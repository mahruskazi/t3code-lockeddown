/**
 * PiRpcModel — pure protocol model for the Pi coding agent's `--mode rpc`
 * JSONL protocol (https://pi.dev, `pi --mode rpc`).
 *
 * Commands are JSON objects written to stdin, one per line. Responses echo
 * the command's optional `id` with `type: "response"`. Everything else on
 * stdout is an asynchronous event. This module owns the tolerant parsing of
 * those lines plus the small mapping helpers the adapter needs; it has no
 * process or Effect-runtime concerns, so everything here is unit-testable
 * with plain values.
 *
 * [fork:pi] This module is fork-local. See docs/internals/fork-pi-provider.md.
 *
 * @module provider/piRpc/PiRpcModel
 */
import type { ThreadTokenUsageSnapshot } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

// ── Errors ────────────────────────────────────────────────────────────

export class PiRpcSpawnError extends Schema.TaggedErrorClass<PiRpcSpawnError>()("PiRpcSpawnError", {
  command: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Failed to spawn Pi RPC process '${this.command}': ${this.detail}`;
  }
}

export class PiRpcTransportError extends Schema.TaggedErrorClass<PiRpcTransportError>()(
  "PiRpcTransportError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Pi RPC transport error: ${this.detail}`;
  }
}

export class PiRpcRequestError extends Schema.TaggedErrorClass<PiRpcRequestError>()(
  "PiRpcRequestError",
  {
    command: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Pi RPC command '${this.command}' failed: ${this.detail}`;
  }
}

export type PiRpcError = PiRpcSpawnError | PiRpcTransportError | PiRpcRequestError;

// ── Wire shapes ───────────────────────────────────────────────────────

/** A command written to Pi's stdin. `id` is added by the transport. */
export interface PiRpcCommand {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** A `type: "response"` line correlated (via `id`) to a sent command. */
export interface PiRpcResponse {
  readonly command: string;
  readonly id: string | undefined;
  readonly success: boolean;
  readonly error: string | undefined;
  readonly data: unknown;
}

/** Any non-response stdout line, kept loose — accessors below refine it. */
export interface PiRpcEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

/**
 * Synthetic event the transport injects when the Pi process exits, so the
 * single event consumer observes process death in-band.
 */
export const PI_PROCESS_EXITED_EVENT = "t3.pi.process_exited" as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export type PiRpcLine =
  | { readonly _tag: "Response"; readonly response: PiRpcResponse }
  | { readonly _tag: "Event"; readonly event: PiRpcEvent }
  | { readonly _tag: "Ignored" };

/**
 * Classify one parsed stdout JSON value. Anything that is not a record with
 * a string `type` is ignored — Pi extensions or misbehaving children may
 * write stray output and the transport must survive it.
 */
export function classifyPiRpcLine(value: unknown): PiRpcLine {
  if (!isRecord(value)) {
    return { _tag: "Ignored" };
  }
  const type = stringField(value, "type");
  if (!type) {
    return { _tag: "Ignored" };
  }
  if (type === "response") {
    return {
      _tag: "Response",
      response: {
        command: stringField(value, "command") ?? "unknown",
        id: stringField(value, "id"),
        success: value.success === true,
        error: stringField(value, "error"),
        data: value.data,
      },
    };
  }
  return { _tag: "Event", event: value as PiRpcEvent };
}

/** Parse one raw stdout line (already `\n`-split; tolerates trailing `\r`). */
export function parsePiRpcLineText(line: string): PiRpcLine {
  const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (trimmed.trim().length === 0) {
    return { _tag: "Ignored" };
  }
  try {
    return classifyPiRpcLine(JSON.parse(trimmed));
  } catch {
    return { _tag: "Ignored" };
  }
}

// ── Model slugs ───────────────────────────────────────────────────────

/**
 * Pi models are addressed as `provider/modelId` (e.g.
 * `anthropic/claude-sonnet-5`). `set_model` wants the two halves separately.
 */
export function splitPiModelSlug(
  slug: string | null | undefined,
): { readonly provider: string; readonly modelId: string } | undefined {
  const trimmed = slug?.trim();
  if (!trimmed) {
    return undefined;
  }
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) {
    return undefined;
  }
  return {
    provider: trimmed.slice(0, separator),
    modelId: trimmed.slice(separator + 1),
  };
}

/** Compose a `provider/modelId` slug from a Pi model record, tolerantly. */
export function piModelSlugFromRecord(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const provider = stringField(value, "provider");
  const modelId = stringField(value, "id") ?? stringField(value, "modelId");
  if (provider && modelId) {
    return `${provider}/${modelId}`;
  }
  return modelId ?? undefined;
}

export interface PiCatalogModel {
  readonly slug: string;
  readonly name: string;
}

/**
 * Parse the `get_available_models` response payload. Accepts either
 * `{ models: [...] }` or a bare array; entries carry `provider` plus
 * `id`/`modelId` and an optional display `name`.
 */
export function parsePiAvailableModels(data: unknown): ReadonlyArray<PiCatalogModel> {
  const entries = isRecord(data) && Array.isArray(data.models) ? data.models : data;
  if (!Array.isArray(entries)) {
    return [];
  }
  const seen = new Set<string>();
  const models: Array<PiCatalogModel> = [];
  for (const entry of entries) {
    const slug = piModelSlugFromRecord(entry);
    if (!slug || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    const name = (isRecord(entry) ? stringField(entry, "name") : undefined) ?? slug;
    models.push({ slug, name });
  }
  return models;
}

// ── Session state ─────────────────────────────────────────────────────

export interface PiSessionState {
  readonly sessionId: string | undefined;
  readonly sessionFile: string | undefined;
  readonly modelSlug: string | undefined;
  readonly isStreaming: boolean;
}

/** Parse the `get_state` response payload. */
export function parsePiSessionState(data: unknown): PiSessionState {
  if (!isRecord(data)) {
    return {
      sessionId: undefined,
      sessionFile: undefined,
      modelSlug: undefined,
      isStreaming: false,
    };
  }
  return {
    sessionId: stringField(data, "sessionId"),
    sessionFile: stringField(data, "sessionFile"),
    modelSlug: piModelSlugFromRecord(data.model),
    isStreaming: data.isStreaming === true,
  };
}

// ── Resume cursor ─────────────────────────────────────────────────────

export const PI_RESUME_VERSION = 1 as const;

export interface PiResumeCursor {
  readonly schemaVersion: typeof PI_RESUME_VERSION;
  readonly sessionFile: string;
}

export function parsePiResumeCursor(raw: unknown): PiResumeCursor | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== PI_RESUME_VERSION) return undefined;
  const sessionFile = stringField(raw, "sessionFile")?.trim();
  if (!sessionFile) return undefined;
  return { schemaVersion: PI_RESUME_VERSION, sessionFile };
}

// ── Assistant streaming ───────────────────────────────────────────────

export type PiAssistantDelta =
  | { readonly kind: "text_start" | "thinking_start"; readonly contentIndex: number }
  | {
      readonly kind: "text_delta" | "thinking_delta";
      readonly contentIndex: number;
      readonly delta: string;
    }
  | { readonly kind: "text_end" | "thinking_end"; readonly contentIndex: number }
  | { readonly kind: "other" };

/** Extract the assistant delta from a `message_update` event. */
export function assistantDeltaFromMessageUpdate(event: PiRpcEvent): PiAssistantDelta | undefined {
  const inner = event.assistantMessageEvent;
  if (!isRecord(inner)) {
    return undefined;
  }
  const kind = stringField(inner, "type");
  const contentIndex = numberField(inner, "contentIndex") ?? 0;
  switch (kind) {
    case "text_start":
    case "thinking_start":
      return { kind, contentIndex };
    case "text_delta":
    case "thinking_delta": {
      const delta = stringField(inner, "delta");
      return delta === undefined ? undefined : { kind, contentIndex, delta };
    }
    case "text_end":
    case "thinking_end":
      return { kind, contentIndex };
    default:
      return { kind: "other" };
  }
}

// ── Token usage ───────────────────────────────────────────────────────

/**
 * Map Pi's usage record (`{input, output, cacheRead, cacheWrite,
 * totalTokens}`) to T3's thread token-usage snapshot.
 */
export function usageSnapshotFromPiUsage(value: unknown): ThreadTokenUsageSnapshot | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const input = numberField(value, "input");
  const output = numberField(value, "output");
  const cacheRead = numberField(value, "cacheRead");
  const totalTokens = numberField(value, "totalTokens");
  const used =
    totalTokens ??
    (input !== undefined || output !== undefined
      ? (input ?? 0) + (cacheRead ?? 0) + (output ?? 0)
      : undefined);
  if (used === undefined) {
    return undefined;
  }
  const contextWindow = numberField(value, "contextWindow") ?? numberField(value, "maxTokens");
  return {
    usedTokens: Math.max(0, Math.round(used)),
    ...(input !== undefined ? { inputTokens: Math.max(0, Math.round(input)) } : {}),
    ...(cacheRead !== undefined ? { cachedInputTokens: Math.max(0, Math.round(cacheRead)) } : {}),
    ...(output !== undefined ? { outputTokens: Math.max(0, Math.round(output)) } : {}),
    ...(contextWindow !== undefined && contextWindow > 0
      ? { maxTokens: Math.round(contextWindow) }
      : {}),
  };
}

// ── Tool execution ────────────────────────────────────────────────────

export interface PiToolExecution {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  /** Present on `tool_execution_end`. */
  readonly isError: boolean | undefined;
  /** Concatenated text content from the (partial) result, if any. */
  readonly resultText: string | undefined;
}

const MAX_TOOL_RESULT_TEXT = 4_000;

function textFromToolResult(value: unknown): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    return undefined;
  }
  const parts: Array<string> = [];
  for (const entry of value.content) {
    if (isRecord(entry) && entry.type === "text" && typeof entry.text === "string") {
      parts.push(entry.text);
    }
  }
  if (parts.length === 0) {
    return undefined;
  }
  const joined = parts.join("");
  return joined.length > MAX_TOOL_RESULT_TEXT
    ? `${joined.slice(0, MAX_TOOL_RESULT_TEXT)}…`
    : joined;
}

/** Parse a `tool_execution_start|update|end` event. */
export function parsePiToolExecution(event: PiRpcEvent): PiToolExecution | undefined {
  const toolCallId = stringField(event, "toolCallId");
  if (!toolCallId) {
    return undefined;
  }
  return {
    toolCallId,
    toolName: stringField(event, "toolName") ?? "tool",
    args: isRecord(event.args) ? event.args : {},
    isError: typeof event.isError === "boolean" ? event.isError : undefined,
    resultText: textFromToolResult(event.result) ?? textFromToolResult(event.partialResult),
  };
}

/**
 * Map a Pi tool name onto T3's tool lifecycle item vocabulary. Pi's core
 * tools are `bash`, `read`, `write`, and `edit`; extensions may add more.
 */
export function itemTypeForPiTool(
  toolName: string,
): "command_execution" | "file_change" | "web_search" | "dynamic_tool_call" {
  switch (toolName) {
    case "bash":
      return "command_execution";
    case "write":
    case "edit":
      return "file_change";
    case "fetch":
    case "web_search":
      return "web_search";
    default:
      return "dynamic_tool_call";
  }
}

/** One-line human detail for a tool call (command or file path). */
export function detailForPiToolCall(
  toolName: string,
  args: Record<string, unknown>,
): string | undefined {
  const command = typeof args.command === "string" ? args.command.trim() : undefined;
  if (command) {
    return command.length > 400 ? `${command.slice(0, 400)}…` : command;
  }
  for (const key of ["path", "file_path", "filePath", "file"] as const) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

// ── Agent settlement ──────────────────────────────────────────────────

export interface PiAgentEndOutcome {
  readonly willRetry: boolean;
  readonly errorMessage: string | undefined;
  readonly aborted: boolean;
}

/**
 * Interpret an `agent_end` event. Pi retries transient provider errors when
 * auto-retry is on (`willRetry: true` means the loop is not settled yet).
 * Error/abort details live on the final assistant message when present.
 */
export function parsePiAgentEnd(event: PiRpcEvent): PiAgentEndOutcome {
  const willRetry = event.willRetry === true;
  let errorMessage: string | undefined;
  let aborted = false;
  const messages = Array.isArray(event.messages) ? event.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message)) continue;
    const role = stringField(message, "role");
    if (role !== undefined && role !== "assistant") continue;
    const stopReason = stringField(message, "stopReason");
    if (stopReason === "aborted" || stopReason === "cancelled") {
      aborted = true;
    }
    const explicitError = stringField(message, "errorMessage") ?? stringField(message, "error");
    if (stopReason === "error" || explicitError !== undefined) {
      errorMessage = explicitError ?? "Pi agent loop failed.";
    }
    break;
  }
  return { willRetry, errorMessage, aborted };
}

// ── Extension UI protocol ─────────────────────────────────────────────

export interface PiExtensionUiRequest {
  readonly id: string;
  readonly method: string;
  readonly title: string | undefined;
  readonly message: string | undefined;
  readonly options: ReadonlyArray<string>;
}

export function parsePiExtensionUiRequest(event: PiRpcEvent): PiExtensionUiRequest | undefined {
  const id = stringField(event, "id");
  const method = stringField(event, "method");
  if (!id || !method) {
    return undefined;
  }
  const options = Array.isArray(event.options)
    ? event.options.filter((option): option is string => typeof option === "string")
    : [];
  return {
    id,
    method,
    title: stringField(event, "title"),
    message: stringField(event, "message"),
    options,
  };
}

/**
 * The T3 approval extension encodes structured approval requests into the
 * dialog title so the RPC client (this server) can render a first-class
 * approval card instead of a raw select dialog. See PiExtensionSource.ts.
 */
export const T3_PI_APPROVAL_TITLE_PREFIX = "t3-approval:v1:";

/** Option labels the extension presents; the adapter answers with one. */
export const T3_PI_APPROVAL_OPTIONS = {
  allow: "Allow",
  allowAlways: "Always allow",
  deny: "Deny",
} as const;

export interface T3PiApprovalRequest {
  readonly toolName: string;
  readonly detail: string | undefined;
  readonly args: unknown;
}

export function parseT3PiApprovalTitle(title: string | undefined): T3PiApprovalRequest | undefined {
  if (!title || !title.startsWith(T3_PI_APPROVAL_TITLE_PREFIX)) {
    return undefined;
  }
  try {
    const payload: unknown = JSON.parse(title.slice(T3_PI_APPROVAL_TITLE_PREFIX.length));
    if (!isRecord(payload)) {
      return undefined;
    }
    const toolName = stringField(payload, "toolName");
    if (!toolName) {
      return undefined;
    }
    return {
      toolName,
      detail: stringField(payload, "detail"),
      args: payload.args,
    };
  } catch {
    return undefined;
  }
}

export function canonicalRequestTypeForPiTool(
  toolName: string,
): "exec_command_approval" | "file_change_approval" | "dynamic_tool_call" {
  switch (toolName) {
    case "bash":
      return "exec_command_approval";
    case "write":
    case "edit":
      return "file_change_approval";
    default:
      return "dynamic_tool_call";
  }
}
