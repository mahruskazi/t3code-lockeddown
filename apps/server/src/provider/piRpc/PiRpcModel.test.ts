/**
 * [fork:pi] Unit tests for the pure Pi RPC protocol model.
 */
import { assert, describe, it } from "@effect/vitest";

import {
  assistantDeltaFromMessageUpdate,
  buildPiToolCallData,
  canonicalRequestTypeForPiTool,
  classifyPiRpcLine,
  detailForPiToolCall,
  encodeT3PiUserInputResponse,
  itemTypeForPiTool,
  kindForPiTool,
  parsePiAgentEnd,
  parsePiAvailableModels,
  parsePiExtensionUiRequest,
  parsePiResumeCursor,
  parsePiSessionState,
  parsePiRpcLineText,
  parsePiToolExecution,
  parseT3PiApprovalTitle,
  parseT3PiUserInputTitle,
  piModelSlugFromRecord,
  splitPiModelSlug,
  T3_PI_APPROVAL_OPTIONS,
  T3_PI_APPROVAL_TITLE_PREFIX,
  T3_PI_USER_INPUT_RESPONSE_PREFIX,
  T3_PI_USER_INPUT_TITLE_PREFIX,
  usageSnapshotFromPiUsage,
} from "./PiRpcModel.ts";
import { T3_PI_EXTENSION_SOURCE } from "./PiExtensionSource.ts";

describe("classifyPiRpcLine", () => {
  it("classifies responses and events", () => {
    const response = classifyPiRpcLine({
      type: "response",
      command: "prompt",
      id: "t3-1",
      success: true,
      data: { ok: true },
    });
    assert.equal(response._tag, "Response");
    if (response._tag === "Response") {
      assert.equal(response.response.command, "prompt");
      assert.equal(response.response.id, "t3-1");
      assert.isTrue(response.response.success);
    }

    const event = classifyPiRpcLine({ type: "agent_start" });
    assert.equal(event._tag, "Event");

    assert.equal(classifyPiRpcLine("nope")._tag, "Ignored");
    assert.equal(classifyPiRpcLine({ noType: true })._tag, "Ignored");
    assert.equal(classifyPiRpcLine(null)._tag, "Ignored");
  });

  it("parses raw line text tolerantly", () => {
    assert.equal(parsePiRpcLineText('{"type":"agent_start"}\r')._tag, "Event");
    assert.equal(parsePiRpcLineText("   ")._tag, "Ignored");
    assert.equal(parsePiRpcLineText("not json")._tag, "Ignored");
  });
});

describe("model slugs", () => {
  it("splits provider/model slugs", () => {
    assert.deepStrictEqual(splitPiModelSlug("anthropic/claude-sonnet-5"), {
      provider: "anthropic",
      modelId: "claude-sonnet-5",
    });
    assert.deepStrictEqual(splitPiModelSlug("openrouter/vendor/model"), {
      provider: "openrouter",
      modelId: "vendor/model",
    });
    assert.isUndefined(splitPiModelSlug("no-slash"));
    assert.isUndefined(splitPiModelSlug("/leading"));
    assert.isUndefined(splitPiModelSlug("trailing/"));
    assert.isUndefined(splitPiModelSlug(undefined));
  });

  it("composes slugs from model records", () => {
    assert.equal(
      piModelSlugFromRecord({ provider: "anthropic", id: "claude-sonnet-5" }),
      "anthropic/claude-sonnet-5",
    );
    assert.equal(piModelSlugFromRecord({ provider: "openai", modelId: "gpt-5" }), "openai/gpt-5");
    assert.equal(piModelSlugFromRecord({ id: "bare-model" }), "bare-model");
    assert.isUndefined(piModelSlugFromRecord({}));
    assert.isUndefined(piModelSlugFromRecord("nope"));
  });

  it("parses available-models payloads in both shapes", () => {
    const wrapped = parsePiAvailableModels({
      models: [
        { provider: "anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5" },
        { provider: "anthropic", id: "claude-sonnet-5", name: "duplicate" },
        { provider: "openai", id: "gpt-5" },
        { bogus: true },
      ],
    });
    assert.deepStrictEqual(wrapped, [
      { slug: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" },
      { slug: "openai/gpt-5", name: "openai/gpt-5" },
    ]);

    const bare = parsePiAvailableModels([{ provider: "google", id: "gemini" }]);
    assert.deepStrictEqual(bare, [{ slug: "google/gemini", name: "google/gemini" }]);

    assert.deepStrictEqual(parsePiAvailableModels("nope"), []);
  });
});

describe("session state and resume", () => {
  it("parses get_state payloads", () => {
    const state = parsePiSessionState({
      model: { provider: "anthropic", id: "claude-sonnet-5" },
      sessionId: "abc123",
      sessionFile: "/tmp/session.jsonl",
      isStreaming: true,
    });
    assert.equal(state.sessionId, "abc123");
    assert.equal(state.sessionFile, "/tmp/session.jsonl");
    assert.equal(state.modelSlug, "anthropic/claude-sonnet-5");
    assert.isTrue(state.isStreaming);

    const empty = parsePiSessionState(undefined);
    assert.isUndefined(empty.sessionId);
    assert.isFalse(empty.isStreaming);
  });

  it("round-trips resume cursors and rejects foreign shapes", () => {
    assert.deepStrictEqual(parsePiResumeCursor({ schemaVersion: 1, sessionFile: "/tmp/s.jsonl" }), {
      schemaVersion: 1,
      sessionFile: "/tmp/s.jsonl",
    });
    assert.isUndefined(parsePiResumeCursor({ schemaVersion: 2, sessionFile: "/tmp/s.jsonl" }));
    assert.isUndefined(parsePiResumeCursor({ schemaVersion: 1, sessionFile: "  " }));
    assert.isUndefined(parsePiResumeCursor({ schemaVersion: 1, sessionId: "grok-shaped" }));
    assert.isUndefined(parsePiResumeCursor(null));
  });
});

describe("assistant deltas and usage", () => {
  it("extracts text and thinking deltas", () => {
    assert.deepStrictEqual(
      assistantDeltaFromMessageUpdate({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" },
      }),
      { kind: "text_delta", contentIndex: 0, delta: "hi" },
    );
    assert.deepStrictEqual(
      assistantDeltaFromMessageUpdate({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_start", contentIndex: 1 },
      }),
      { kind: "thinking_start", contentIndex: 1 },
    );
    assert.deepStrictEqual(
      assistantDeltaFromMessageUpdate({
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0 },
      }),
      { kind: "other" },
    );
    assert.isUndefined(assistantDeltaFromMessageUpdate({ type: "message_update" }));
  });

  it("maps pi usage onto the token-usage snapshot", () => {
    const snapshot = usageSnapshotFromPiUsage({
      input: 120,
      output: 18,
      cacheRead: 40,
      cacheWrite: 0,
      totalTokens: 178,
    });
    assert.deepStrictEqual(snapshot, {
      usedTokens: 178,
      inputTokens: 120,
      cachedInputTokens: 40,
      outputTokens: 18,
    });
    assert.isUndefined(usageSnapshotFromPiUsage({}));
    assert.isUndefined(usageSnapshotFromPiUsage("nope"));
  });
});

describe("tool executions", () => {
  it("parses tool execution events and truncates result text", () => {
    const tool = parsePiToolExecution({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "ls" },
      result: { content: [{ type: "text", text: "a".repeat(5_000) }] },
      isError: false,
    });
    assert.isDefined(tool);
    if (tool) {
      assert.equal(tool.toolCallId, "call-1");
      assert.equal(tool.toolName, "bash");
      assert.equal(tool.isError, false);
      assert.isDefined(tool.resultText);
      assert.isBelow(tool.resultText?.length ?? 0, 4_100);
    }
    assert.isUndefined(parsePiToolExecution({ type: "tool_execution_start" }));
  });

  it("maps tool names to item and request types", () => {
    assert.equal(itemTypeForPiTool("bash"), "command_execution");
    assert.equal(itemTypeForPiTool("edit"), "file_change");
    assert.equal(itemTypeForPiTool("write"), "file_change");
    assert.equal(itemTypeForPiTool("read"), "dynamic_tool_call");
    assert.equal(canonicalRequestTypeForPiTool("bash"), "exec_command_approval");
    assert.equal(canonicalRequestTypeForPiTool("edit"), "file_change_approval");
    assert.equal(canonicalRequestTypeForPiTool("custom"), "dynamic_tool_call");
  });

  it("derives one-line details from args", () => {
    assert.equal(detailForPiToolCall("bash", { command: "ls -la" }), "ls -la");
    assert.equal(detailForPiToolCall("edit", { path: "/tmp/a.ts" }), "/tmp/a.ts");
    assert.isUndefined(detailForPiToolCall("read", {}));
  });

  it("maps tool names to action kinds", () => {
    assert.equal(kindForPiTool("bash"), "execute");
    assert.equal(kindForPiTool("read"), "read");
    assert.equal(kindForPiTool("edit"), "edit");
    assert.equal(kindForPiTool("write"), "write");
    assert.equal(kindForPiTool("fetch"), "search");
    assert.equal(kindForPiTool("web_search"), "search");
    assert.isUndefined(kindForPiTool("custom"));
  });

  it("builds client-facing tool call data", () => {
    const bash = buildPiToolCallData({
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "ls" },
    });
    assert.deepEqual(bash, {
      toolCallId: "call-1",
      kind: "execute",
      command: "ls",
      rawInput: { command: "ls" },
    });

    const edit = buildPiToolCallData({
      toolCallId: "call-2",
      toolName: "edit",
      args: { path: "/tmp/a.ts" },
    });
    assert.equal(edit.kind, "edit");
    assert.equal(edit.path, "/tmp/a.ts");

    // A read path must not surface as a top-level `path` (changed-file chip).
    const read = buildPiToolCallData({
      toolCallId: "call-3",
      toolName: "read",
      args: { path: "/tmp/a.ts" },
    });
    assert.equal(read.kind, "read");
    assert.isUndefined(read.path);
    assert.deepEqual(read.rawInput, { path: "/tmp/a.ts" });

    const withResult = buildPiToolCallData({
      toolCallId: "call-4",
      toolName: "bash",
      args: { command: "ls" },
      resultText: "file.txt",
    });
    assert.deepEqual(withResult.rawOutput, { content: "file.txt" });

    const empty = buildPiToolCallData({ toolCallId: "call-5", toolName: "custom", args: {} });
    assert.deepEqual(empty, { toolCallId: "call-5" });
  });
});

describe("agent settlement", () => {
  it("interprets agent_end outcomes", () => {
    assert.deepStrictEqual(
      parsePiAgentEnd({
        type: "agent_end",
        messages: [{ role: "assistant", stopReason: "stop" }],
        willRetry: false,
      }),
      { willRetry: false, errorMessage: undefined, aborted: false },
    );
    assert.deepStrictEqual(
      parsePiAgentEnd({
        type: "agent_end",
        messages: [{ role: "assistant", stopReason: "aborted" }],
      }),
      { willRetry: false, errorMessage: undefined, aborted: true },
    );
    assert.deepStrictEqual(
      parsePiAgentEnd({
        type: "agent_end",
        messages: [{ role: "assistant", stopReason: "error", errorMessage: "boom" }],
      }),
      { willRetry: false, errorMessage: "boom", aborted: false },
    );
    assert.isTrue(parsePiAgentEnd({ type: "agent_end", willRetry: true }).willRetry);
  });
});

describe("extension UI protocol", () => {
  it("parses extension_ui_request events", () => {
    const ui = parsePiExtensionUiRequest({
      type: "extension_ui_request",
      id: "ui-1",
      method: "select",
      title: "pick one",
      options: ["a", "b", 3],
    });
    assert.isDefined(ui);
    if (ui) {
      assert.equal(ui.id, "ui-1");
      assert.equal(ui.method, "select");
      assert.deepStrictEqual(ui.options, ["a", "b"]);
    }
    assert.isUndefined(parsePiExtensionUiRequest({ type: "extension_ui_request", method: "x" }));
  });

  it("round-trips the T3 approval marker", () => {
    const payload = { toolName: "bash", detail: "rm -rf x", args: { command: "rm -rf x" } };
    const parsed = parseT3PiApprovalTitle(
      `${T3_PI_APPROVAL_TITLE_PREFIX}${JSON.stringify(payload)}`,
    );
    assert.isDefined(parsed);
    if (parsed) {
      assert.equal(parsed.toolName, "bash");
      assert.equal(parsed.detail, "rm -rf x");
      assert.deepStrictEqual(parsed.args, { command: "rm -rf x" });
    }
    assert.isUndefined(parseT3PiApprovalTitle("plain title"));
    assert.isUndefined(parseT3PiApprovalTitle(`${T3_PI_APPROVAL_TITLE_PREFIX}not json`));
    assert.isUndefined(parseT3PiApprovalTitle(`${T3_PI_APPROVAL_TITLE_PREFIX}{"detail":"x"}`));
    assert.isUndefined(parseT3PiApprovalTitle(undefined));
  });

  it("round-trips structured T3 user-input markers", () => {
    const payload = {
      questions: [
        {
          id: "platform",
          header: "Platform",
          question: "Which platform?",
          options: [{ label: "Desktop", description: "Desktop app" }, { label: "Mobile" }],
          multiSelect: false,
        },
      ],
    };
    const parsed = parseT3PiUserInputTitle(
      `${T3_PI_USER_INPUT_TITLE_PREFIX}${JSON.stringify(payload)}`,
    );
    assert.deepStrictEqual(parsed, {
      questions: [
        {
          id: "platform",
          header: "Platform",
          question: "Which platform?",
          options: [
            { label: "Desktop", description: "Desktop app" },
            { label: "Mobile", description: "Mobile" },
          ],
          multiSelect: false,
        },
      ],
    });
    assert.equal(
      encodeT3PiUserInputResponse({ platform: "Desktop" }),
      `${T3_PI_USER_INPUT_RESPONSE_PREFIX}{"platform":"Desktop"}`,
    );
    assert.isUndefined(parseT3PiUserInputTitle("plain title"));
    assert.isUndefined(parseT3PiUserInputTitle(`${T3_PI_USER_INPUT_TITLE_PREFIX}not json`));
    assert.isUndefined(
      parseT3PiUserInputTitle(
        `${T3_PI_USER_INPUT_TITLE_PREFIX}${JSON.stringify({ questions: [] })}`,
      ),
    );
  });

  it("stays in sync with the embedded extension source", () => {
    // The extension composes titles/answers the adapter must understand;
    // these invariants pin the two sides of the wire together.
    assert.include(T3_PI_EXTENSION_SOURCE, T3_PI_APPROVAL_TITLE_PREFIX);
    assert.include(T3_PI_EXTENSION_SOURCE, `"${T3_PI_APPROVAL_OPTIONS.allow}"`);
    assert.include(T3_PI_EXTENSION_SOURCE, `"${T3_PI_APPROVAL_OPTIONS.allowAlways}"`);
    assert.include(T3_PI_EXTENSION_SOURCE, `"${T3_PI_APPROVAL_OPTIONS.deny}"`);
    assert.include(T3_PI_EXTENSION_SOURCE, "T3_PI_APPROVAL_MODE");
  });
});
