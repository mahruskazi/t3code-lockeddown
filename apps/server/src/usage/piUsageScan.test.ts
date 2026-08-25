// [fork:pi] Pi is a fork-local provider; this whole file is fork code.
/**
 * Integration cover for the Pi half of a usage scan: the directory walk, the
 * pre-parse gate, the parser, and cross-file de-duplication, over session files
 * written the way `pi` writes them.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";

import { UsageAggregator } from "./usageAggregation.ts";
import { listTranscriptFiles, readTranscriptRecords } from "./usageTranscriptReader.ts";

const HEADER = (id: string, parentSession?: string) =>
  JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-08-24T09:12:00.000Z",
    cwd: "/home/theo/proj",
    ...(parentSession === undefined ? {} : { parentSession }),
  });

/** Everything after the header, shared by the original and its fork. */
const BODY = [
  JSON.stringify({
    type: "message",
    id: "11111111",
    parentId: null,
    timestamp: "2026-08-24T09:12:05.000Z",
    message: { role: "user", content: "add a test", timestamp: 1_787_000_000_000 },
  }),
  JSON.stringify({
    type: "message",
    id: "22222222",
    parentId: "11111111",
    timestamp: "2026-08-24T09:12:31.500Z",
    message: {
      role: "assistant",
      api: "openai-completions",
      provider: "openai",
      model: "gpt-5.6-sol",
      responseId: "resp_abc",
      content: [{ type: "text", text: "ok" }],
      stopReason: "stop",
      timestamp: 1_787_000_031_500,
      usage: {
        input: 1200,
        output: 300,
        cacheRead: 800,
        cacheWrite: 64,
        reasoning: 120,
        totalTokens: 2364,
        cost: { input: 0.0004, output: 0.0009, cacheRead: 0.00002, cacheWrite: 0, total: 0.00132 },
      },
    },
  }),
  JSON.stringify({
    type: "message",
    id: "33333333",
    parentId: "22222222",
    timestamp: "2026-08-24T09:13:00.000Z",
    message: {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "bash",
      content: [{ type: "text", text: "lots of output" }],
      isError: false,
      timestamp: 1_787_000_060_000,
    },
  }),
  JSON.stringify({
    type: "compaction",
    id: "66666666",
    parentId: "33333333",
    timestamp: "2026-08-24T09:15:00.000Z",
    summary: "…",
    firstKeptEntryId: "22222222",
    tokensBefore: 180_000,
    usage: {
      input: 175_000,
      output: 2400,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 177_400,
      cost: { input: 0.52, output: 0.03, cacheRead: 0, cacheWrite: 0, total: 0.55 },
    },
  }),
  JSON.stringify({
    type: "model_change",
    id: "44444444",
    parentId: "66666666",
    timestamp: "2026-08-24T09:20:00.000Z",
    provider: "ds4",
    modelId: "deepseek-v4-flash",
  }),
  JSON.stringify({
    type: "message",
    id: "55555555",
    parentId: "44444444",
    timestamp: "2026-08-24T09:21:00.000Z",
    message: {
      role: "assistant",
      api: "openai-completions",
      provider: "ds4",
      model: "deepseek-v4-flash",
      content: [],
      stopReason: "stop",
      timestamp: 1_787_000_520_000,
      // A locally hosted model declares zero rates, so Pi reports zero cost.
      usage: {
        input: 500,
        output: 40,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 540,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  }),
].join("\n");

let root = "";

beforeAll(async () => {
  root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-usage-scan-"));
  // Pi nests one directory per encoded cwd, so the scan has to recurse.
  const projectDir = NodePath.join(root, "-home-theo-proj");
  await NodeFSP.mkdir(projectDir, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(projectDir, "2026-08-24T09-12-00-000Z_sess-1.jsonl"),
    `${HEADER("sess-1")}\n${BODY}\n`,
  );
  // Forking writes a fresh header and copies the parent's entries verbatim.
  await NodeFSP.writeFile(
    NodePath.join(projectDir, "2026-08-24T10-00-00-000Z_sess-2.jsonl"),
    `${HEADER("sess-2", "parent.jsonl")}\n${BODY}\n`,
  );
});

afterAll(async () => {
  if (root !== "") await NodeFSP.rm(root, { recursive: true, force: true });
});

describe("scanning Pi session files", () => {
  it("prices a scan from Pi's own cost figures and drops the forked copies", async () => {
    const files = await listTranscriptFiles(root, 0);
    expect(files.length).toBe(2);

    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      resolution: "day",
      // Deliberately empty: every figure below has to come from Pi.
      rates: new Map(),
    });

    let parsed = 0;
    let landed = 0;
    for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
      const records = await readTranscriptRecords(file.path, "pi");
      expect(records).not.toBeNull();
      for (const record of records ?? []) {
        parsed += 1;
        if (aggregator.add(record)) landed += 1;
      }
    }

    // Three spend-bearing entries in each file; the fork's copies are dropped.
    expect(parsed).toBe(6);
    expect(landed).toBe(3);

    const byModel = new Map(aggregator.finish().buckets.map((bucket) => [bucket.model, bucket]));
    expect([...byModel.keys()].sort()).toEqual(["ds4/deepseek-v4-flash", "openai/gpt-5.6-sol"]);

    // The local model reports a real zero rather than falling through to
    // "unpriced", which no rate table could have told us.
    const local = byModel.get("ds4/deepseek-v4-flash");
    expect(local?.costSource).toBe("providerReported");
    expect(local?.costUsd).toBe(0);

    // The hosted turn plus the compaction that ran while it was still active.
    const hosted = byModel.get("openai/gpt-5.6-sol");
    expect(hosted?.costSource).toBe("providerReported");
    expect(hosted?.costUsd).toBeCloseTo(0.00132 + 0.55, 9);
    expect(hosted?.records).toBe(2);
    expect(hosted?.sessions).toBe(1);
    expect(hosted?.totals.reasoningTokens).toBe(120);
  });
});
