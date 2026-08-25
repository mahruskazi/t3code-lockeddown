// [fork:pi] Pi is a fork-local provider; this whole file is fork code.
import { describe, expect, it } from "@effect/vitest";

import { initialPiScanState, parsePiLine, piLineMightMatter } from "./piUsageTranscript.ts";
import { totalTokens } from "./usageTranscripts.ts";

/** Shaped after a real `pi` session header (`CURRENT_SESSION_VERSION` 3). */
function headerLine(overrides: { id?: string; parentSession?: string } = {}): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id: overrides.id ?? "3f1c2a55-9d84-4a1e-bb90-2c7e6d5f0a11",
    timestamp: "2026-08-24T09:12:00.000Z",
    cwd: "/home/theo/project",
    ...(overrides.parentSession === undefined ? {} : { parentSession: overrides.parentSession }),
  });
}

/** Shaped after a real persisted assistant message entry. */
function assistantLine(
  overrides: {
    entryId?: string;
    responseId?: string;
    provider?: string;
    model?: string;
    timestamp?: string;
    output?: number;
    reasoning?: number;
    costTotal?: number | null;
  } = {},
): string {
  const cost =
    overrides.costTotal === null
      ? undefined
      : {
          input: 0.0004,
          output: 0.0009,
          cacheRead: 0.00002,
          cacheWrite: 0,
          total: overrides.costTotal ?? 0.00132,
        };
  return JSON.stringify({
    type: "message",
    id: overrides.entryId ?? "a1b2c3d4",
    parentId: "0f9e8d7c",
    timestamp: overrides.timestamp ?? "2026-08-24T09:12:31.500Z",
    message: {
      role: "assistant",
      api: "openai-completions",
      provider: overrides.provider ?? "openai",
      model: overrides.model ?? "gpt-5.6-sol",
      ...(overrides.responseId === undefined ? {} : { responseId: overrides.responseId }),
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
      timestamp: Date.parse(overrides.timestamp ?? "2026-08-24T09:12:31.500Z"),
      usage: {
        input: 1200,
        output: overrides.output ?? 300,
        cacheRead: 800,
        cacheWrite: 64,
        ...(overrides.reasoning === undefined ? {} : { reasoning: overrides.reasoning }),
        totalTokens: 2364,
        ...(cost === undefined ? {} : { cost }),
      },
    },
  });
}

describe("piLineMightMatter", () => {
  it("admits usage, header, and model-change lines and rejects the rest", () => {
    expect(piLineMightMatter(assistantLine())).toBe(true);
    expect(piLineMightMatter(headerLine())).toBe(true);
    expect(
      piLineMightMatter(
        JSON.stringify({ type: "model_change", provider: "anthropic", modelId: "claude-opus-5" }),
      ),
    ).toBe(true);
    expect(
      piLineMightMatter(
        JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
      ),
    ).toBe(false);
  });
});

describe("parsePiLine", () => {
  it("maps an assistant message onto disjoint token totals", () => {
    const state = initialPiScanState();
    parsePiLine(headerLine(), state);
    const record = parsePiLine(assistantLine({ reasoning: 120 }), state);

    expect(record).not.toBeNull();
    expect(record?.provider).toBe("pi");
    expect(record?.sessionId).toBe("3f1c2a55-9d84-4a1e-bb90-2c7e6d5f0a11");
    expect(record?.model).toBe("openai/gpt-5.6-sol");
    expect(record?.totals).toStrictEqual({
      uncachedInputTokens: 1200,
      cachedInputTokens: 800,
      cacheCreationTokens: 64,
      outputTokens: 300,
      reasoningTokens: 120,
    });
    // Pi reports input exclusive of the cached and written portions.
    expect(totalTokens(record!.totals)).toBe(2364);
    expect(record?.timestampMs).toBe(Date.parse("2026-08-24T09:12:31.500Z"));
  });

  it("prefers Pi's own cost, including a genuine zero from a local model", () => {
    const state = initialPiScanState();
    parsePiLine(headerLine(), state);

    expect(parsePiLine(assistantLine({ costTotal: 0.0042 }), state)?.reportedCostUsd).toBe(0.0042);
    expect(
      parsePiLine(
        assistantLine({ provider: "ds4", model: "deepseek-v4-flash", costTotal: 0 }),
        state,
      )?.reportedCostUsd,
    ).toBe(0);
    // No cost block at all falls back to our own rate table.
    expect(parsePiLine(assistantLine({ costTotal: null }), state)?.reportedCostUsd).toBeNull();
  });

  it("de-duplicates entries a fork copied into a second session file", () => {
    const original = initialPiScanState();
    parsePiLine(headerLine(), original);
    const first = parsePiLine(assistantLine({ entryId: "a1b2c3d4" }), original);

    // A fork writes a new header, then copies the parent's entries verbatim.
    const forked = initialPiScanState();
    parsePiLine(
      headerLine({ id: "77770000-0000-4000-8000-000000000000", parentSession: "/p.jsonl" }),
      forked,
    );
    const copy = parsePiLine(assistantLine({ entryId: "a1b2c3d4" }), forked);

    expect(first?.dedupeKey).not.toBeNull();
    expect(copy?.dedupeKey).toBe(first?.dedupeKey);
  });

  it("separates two sessions that collide on Pi's eight-character entry id", () => {
    const left = initialPiScanState();
    parsePiLine(headerLine(), left);
    const leftRecord = parsePiLine(
      assistantLine({ entryId: "a1b2c3d4", timestamp: "2026-08-24T09:12:31.500Z" }),
      left,
    );

    const right = initialPiScanState();
    parsePiLine(headerLine({ id: "88880000-0000-4000-8000-000000000000" }), right);
    const rightRecord = parsePiLine(
      assistantLine({ entryId: "a1b2c3d4", timestamp: "2026-08-24T11:40:02.000Z", output: 999 }),
      right,
    );

    expect(rightRecord?.dedupeKey).not.toBe(leftRecord?.dedupeKey);
  });

  it("uses the provider's response id as the dedupe key when there is one", () => {
    const state = initialPiScanState();
    parsePiLine(headerLine(), state);
    const record = parsePiLine(assistantLine({ responseId: "resp_9f8e7d" }), state);

    expect(record?.dedupeKey).toBe("pi:r:resp_9f8e7d");
  });

  it("keeps the first header's session id when a fork repeats its ancestors", () => {
    const state = initialPiScanState();
    parsePiLine(headerLine({ id: "own-session" }), state);
    parsePiLine(headerLine({ id: "ancestor-session" }), state);

    expect(parsePiLine(assistantLine(), state)?.sessionId).toBe("own-session");
  });

  it("bills compaction against the model last in use", () => {
    const state = initialPiScanState();
    parsePiLine(headerLine(), state);
    parsePiLine(assistantLine({ provider: "anthropic", model: "claude-opus-5" }), state);

    const record = parsePiLine(
      JSON.stringify({
        type: "compaction",
        id: "c0ffee01",
        parentId: "a1b2c3d4",
        timestamp: "2026-08-24T10:00:00.000Z",
        summary: "…",
        firstKeptEntryId: "a1b2c3d4",
        tokensBefore: 180_000,
        usage: {
          input: 175_000,
          output: 2_400,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 177_400,
          cost: { input: 0.52, output: 0.03, cacheRead: 0, cacheWrite: 0, total: 0.55 },
        },
      }),
      state,
    );

    expect(record?.model).toBe("anthropic/claude-opus-5");
    expect(record?.reportedCostUsd).toBe(0.55);
    expect(record?.totals.uncachedInputTokens).toBe(175_000);
  });

  it("tracks a mid-session model switch for later compaction entries", () => {
    const state = initialPiScanState();
    parsePiLine(headerLine(), state);
    parsePiLine(
      JSON.stringify({
        type: "model_change",
        id: "m0000001",
        parentId: null,
        timestamp: "2026-08-24T09:30:00.000Z",
        provider: "anthropic",
        modelId: "claude-opus-5",
      }),
      state,
    );

    const record = parsePiLine(
      JSON.stringify({
        type: "compaction",
        id: "c0ffee02",
        parentId: null,
        timestamp: "2026-08-24T09:31:00.000Z",
        summary: "…",
        firstKeptEntryId: "x",
        tokensBefore: 10,
        usage: { input: 900, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 910 },
      }),
      state,
    );

    expect(record?.model).toBe("anthropic/claude-opus-5");
  });

  it("ignores lines that carry no spend", () => {
    const state = initialPiScanState();
    parsePiLine(headerLine(), state);

    expect(parsePiLine("not json", state)).toBeNull();
    expect(
      parsePiLine(JSON.stringify({ type: "message", message: { role: "user" } }), state),
    ).toBeNull();
    expect(
      parsePiLine(
        JSON.stringify({
          type: "message",
          id: "e1",
          timestamp: "2026-08-24T09:12:31.500Z",
          message: {
            role: "assistant",
            provider: "openai",
            model: "gpt-5.6-sol",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
          },
        }),
        state,
      ),
    ).toBeNull();
    // Compaction before any model has been seen cannot be attributed.
    expect(
      parsePiLine(
        JSON.stringify({
          type: "compaction",
          id: "c1",
          timestamp: "2026-08-24T09:12:31.500Z",
          usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10 },
        }),
        initialPiScanState(),
      ),
    ).toBeNull();
  });
});
