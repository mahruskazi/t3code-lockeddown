// [fork:pi] Pi is a fork-local provider; this whole file is fork code.
/**
 * Pure parser for Pi's on-disk session transcripts.
 *
 * Pi appends one JSON object per line to
 * `<sessionsDir>/<encoded-cwd>/<timestamp>_<sessionId>.jsonl`: a `session`
 * header first, then `message`, `model_change`, `compaction` and other entries
 * as the session runs. Assistant messages carry the full token breakdown and,
 * unlike Claude Code and Codex, a cost figure Pi computed from the model's own
 * declared rates. That cost covers locally hosted and custom models the LiteLLM
 * rate table has never heard of, so it is always preferred over our pricing.
 *
 * Line-at-a-time so the caller can stream large files. Does not touch the
 * filesystem.
 *
 * @module piUsageTranscript
 */
import type { UsageTokenTotals } from "@t3tools/contracts";

import { totalTokens, type UsageRecord } from "./usageTranscripts.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Rolling state for a single Pi session file.
 *
 * The session id lives on the header line rather than on each entry, and
 * compaction entries record what their summarising call cost without recording
 * which model ran it, so both are carried forward.
 */
export interface PiScanState {
  sessionId: string;
  model: string;
}

export function initialPiScanState(): PiScanState {
  return { sessionId: "", model: "" };
}

/**
 * Cheap substring gate applied before `JSON.parse`.
 *
 * Most of a Pi transcript is tool results and user messages. Every line that
 * can produce a record carries `"usage"`; header and model-change lines carry
 * no usage of their own but still have to reach the reducer.
 */
export function piLineMightMatter(line: string): boolean {
  return line.includes('"usage"') || line.includes('"session"') || line.includes('"model_change"');
}

/**
 * Pi's model slug, as `provider/modelId`.
 *
 * Pi records the two separately, and the same model id is served by several
 * providers at different prices. Pricing strips the prefix back off, so this
 * only has to disambiguate the bucket label.
 */
function modelSlug(provider: unknown, modelId: unknown): string {
  if (typeof modelId !== "string" || modelId.trim().length === 0) return "";
  if (typeof provider !== "string" || provider.trim().length === 0) return modelId.trim();
  return `${provider.trim()}/${modelId.trim()}`;
}

/**
 * Pi reports `input` exclusive of the cached and cache-written portions, which
 * is already how `UsageTokenTotals` is defined, so the counts map across
 * directly.
 */
function totalsFromPiUsage(usage: Record<string, unknown>): UsageTokenTotals {
  const outputTokens = int(usage["output"]);
  return {
    uncachedInputTokens: int(usage["input"]),
    cachedInputTokens: int(usage["cacheRead"]),
    cacheCreationTokens: int(usage["cacheWrite"]),
    outputTokens,
    // Pi reports reasoning inside output, matching our convention.
    reasoningTokens: Math.min(outputTokens, int(usage["reasoning"])),
  };
}

/**
 * Pi's own cost for this call, or `null` when it did not record one.
 *
 * Zero is a real answer, not a missing one: a local model declares zero rates
 * and genuinely costs nothing. Falling back to the rate table there would price
 * a local run at a hosted model's rates whenever the ids happen to collide.
 */
function reportedCostUsd(usage: Record<string, unknown>): number | null {
  const cost = usage["cost"];
  if (!isRecord(cost)) return null;
  const total = cost["total"];
  return typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : null;
}

/**
 * Key for dropping entries a fork or resume copied into a second file.
 *
 * Pi copies entries verbatim when forking a session, so the same spend appears
 * in both files. Entry ids are only unique within their own file (Pi shortens
 * them to eight characters and only checks for collisions locally), so the
 * message's own instant and token total ride along to separate two sessions
 * that happen to land on the same short id. A provider-assigned response id,
 * when there is one, is already globally unique and needs no help.
 */
function dedupeKeyFor(
  responseId: unknown,
  entryId: unknown,
  messageTimestampMs: number | null,
  tokens: number,
): string | null {
  if (typeof responseId === "string" && responseId.length > 0) return `pi:r:${responseId}`;
  if (typeof entryId !== "string" || entryId.length === 0) return null;
  return `pi:e:${entryId}:${messageTimestampMs ?? ""}:${tokens}`;
}

/**
 * Feeds one line of a Pi session file into `state`, returning a record when the
 * line carried usage.
 *
 * Assistant messages are the bulk of it. Compaction and branch-summary entries
 * bill for a real model call too — summarising a full context is not cheap —
 * and are attributed to whichever model was last in use, since Pi does not
 * record one on the entry.
 */
export function parsePiLine(line: string, state: PiScanState): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const entryType = parsed["type"];

  if (entryType === "session") {
    // Only the first header describes this file's own session.
    if (state.sessionId.length === 0 && typeof parsed["id"] === "string") {
      state.sessionId = parsed["id"];
    }
    return null;
  }

  if (entryType === "model_change") {
    const slug = modelSlug(parsed["provider"], parsed["modelId"]);
    if (slug.length > 0) state.model = slug;
    return null;
  }

  const entryTimestampMs = parseTimestampMs(parsed["timestamp"]);

  if (entryType === "message") {
    const message = parsed["message"];
    if (!isRecord(message) || message["role"] !== "assistant") return null;

    const usage = message["usage"];
    if (!isRecord(usage)) return null;

    const slug = modelSlug(message["provider"], message["model"]);
    if (slug.length === 0) return null;
    state.model = slug;

    const messageTimestampMs = parseTimestampMs(message["timestamp"]);
    const timestampMs = entryTimestampMs ?? messageTimestampMs;
    if (timestampMs === null) return null;

    const totals = totalsFromPiUsage(usage);
    const tokens = totalTokens(totals);
    if (tokens === 0) return null;

    return {
      provider: "pi",
      timestampMs,
      model: slug,
      sessionId: state.sessionId,
      totals,
      reportedCostUsd: reportedCostUsd(usage),
      dedupeKey: dedupeKeyFor(message["responseId"], parsed["id"], messageTimestampMs, tokens),
    };
  }

  if (entryType === "compaction" || entryType === "branch_summary") {
    const usage = parsed["usage"];
    if (!isRecord(usage)) return null;
    // Nothing on the entry says which model ran, and an unattributed record
    // would price as an unknown model. Skip until a model has been seen.
    if (state.model.length === 0) return null;
    if (entryTimestampMs === null) return null;

    const totals = totalsFromPiUsage(usage);
    const tokens = totalTokens(totals);
    if (tokens === 0) return null;

    return {
      provider: "pi",
      timestampMs: entryTimestampMs,
      model: state.model,
      sessionId: state.sessionId,
      totals,
      reportedCostUsd: reportedCostUsd(usage),
      dedupeKey: dedupeKeyFor(undefined, parsed["id"], entryTimestampMs, tokens),
    };
  }

  return null;
}
