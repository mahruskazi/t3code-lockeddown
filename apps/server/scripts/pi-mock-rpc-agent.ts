#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
/**
 * pi-mock-rpc-agent — a minimal stand-in for `pi --mode rpc` used by the
 * Pi adapter tests. Speaks the Pi RPC JSONL protocol over stdio.
 *
 * Behavior knobs (env):
 *   PI_MOCK_APPROVAL=1            emit a T3-marker extension_ui_request
 *                                 before streaming, and gate on the answer
 *   PI_MOCK_USER_INPUT=1          emit a structured user-input UI request
 *   PI_MOCK_HANG_PROMPT=1         start streaming but never settle the turn
 *   PI_MOCK_FAIL_PROMPT=1         answer the prompt ack with success:false
 *   PI_MOCK_UI_LOG_PATH=<file>    append extension_ui_response bodies
 *   PI_MOCK_EXIT_LOG_PATH=<file>  write "exited" on shutdown
 *   PI_MOCK_ARGS_LOG_PATH=<file>  write process argv on startup
 *   PI_MOCK_SUBAGENTS=1           emit T3 Pi-subagent lifecycle markers
 *   PI_MOCK_SUBAGENT_HANG=1       leave the emitted child running
 *
 * [fork:pi] Test-only. See docs/internals/fork-pi-provider.md.
 */
import * as NodeFS from "node:fs";

const uiLogPath = process.env.PI_MOCK_UI_LOG_PATH;
const exitLogPath = process.env.PI_MOCK_EXIT_LOG_PATH;
const argsLogPath = process.env.PI_MOCK_ARGS_LOG_PATH;
const emitApproval = process.env.PI_MOCK_APPROVAL === "1";
const emitUserInput = process.env.PI_MOCK_USER_INPUT === "1";
const hangPrompt = process.env.PI_MOCK_HANG_PROMPT === "1";
const failPrompt = process.env.PI_MOCK_FAIL_PROMPT === "1";
const emitSubagents =
  process.env.PI_MOCK_SUBAGENTS === "1" && process.env.T3_PI_SUBAGENT_BRIDGE === "v1";
const hangSubagent = process.env.PI_MOCK_SUBAGENT_HANG === "1";

if (argsLogPath) {
  NodeFS.writeFileSync(argsLogPath, JSON.stringify(process.argv.slice(2)));
}

const sessionArgIndex = process.argv.indexOf("--session");
const sessionFile =
  sessionArgIndex >= 0 && process.argv[sessionArgIndex + 1]
    ? process.argv[sessionArgIndex + 1]
    : "/tmp/pi-mock-session.jsonl";

const state = {
  model: { provider: "anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  isStreaming: false,
  sessionId: "mock-pi-session-1",
  sessionFile,
};

function writeLine(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const bridgeRunId = `mock-${process.pid}`;
let notificationId = 0;
const subagentMarker = (payload: Record<string, unknown>) =>
  writeLine({
    type: "extension_ui_request",
    id: `notify-${++notificationId}`,
    method: "notify",
    message: `t3-subagent:v1:${JSON.stringify(payload)}`,
    notifyType: "info",
  });

function respond(id: string | undefined, command: string, body: Record<string, unknown> = {}) {
  writeLine({
    ...(id === undefined ? {} : { id }),
    type: "response",
    command,
    success: true,
    ...body,
  });
}

function respondError(id: string | undefined, command: string, error: string) {
  writeLine({
    ...(id === undefined ? {} : { id }),
    type: "response",
    command,
    success: false,
    error,
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const usage = {
  input: 120,
  output: 18,
  cacheRead: 40,
  cacheWrite: 0,
  totalTokens: 178,
};

let pendingUiResolve: ((value: Record<string, unknown>) => void) | undefined;
let aborted = false;

async function runTurn() {
  aborted = false;
  state.isStreaming = true;
  writeLine({ type: "agent_start" });

  if (emitSubagents) {
    const started = {
      kind: "started",
      bridgeRunId,
      childId: "sa-1",
      title: "Mock child",
      harness: "pi",
      cwd: process.cwd(),
      model: "openai/gpt-5",
      effort: "high",
      toolUseId: "subagent-tool-1",
      transcriptPath: "/tmp/mock-child/session.jsonl",
    };
    subagentMarker(started);
    subagentMarker(started);
  }

  if (emitApproval) {
    const payload = {
      toolName: "bash",
      detail: "rm -rf /tmp/x",
      args: { command: "rm -rf /tmp/x" },
    };
    const answer = await new Promise<Record<string, unknown>>((resolve) => {
      pendingUiResolve = resolve;
      writeLine({
        type: "extension_ui_request",
        id: "ui-1",
        method: "select",
        title: `t3-approval:v1:${JSON.stringify(payload)}`,
        options: ["Allow", "Always allow", "Deny"],
      });
    });
    pendingUiResolve = undefined;
    if (uiLogPath) {
      NodeFS.appendFileSync(uiLogPath, `${JSON.stringify(answer)}\n`);
    }
    if (answer.value === "Allow" || answer.value === "Always allow") {
      writeLine({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "rm -rf /tmp/x" },
      });
      await sleep(5);
      writeLine({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "done" }] },
        isError: false,
      });
    }
  }

  if (emitUserInput) {
    const payload = {
      questions: [
        {
          id: "platform",
          header: "Platform",
          question: "Which Discord platform do you use most?",
          options: [
            { label: "Desktop", description: "The desktop app" },
            { label: "Mobile", description: "The mobile app" },
          ],
          multiSelect: false,
        },
        {
          id: "features",
          header: "Features",
          question: "Which features matter?",
          options: [
            { label: "Speed", description: "Fast interactions" },
            { label: "Remote", description: "Remote access" },
          ],
          multiSelect: true,
        },
      ],
    };
    const answer = await new Promise<Record<string, unknown>>((resolve) => {
      pendingUiResolve = resolve;
      writeLine({
        type: "extension_ui_request",
        id: "ui-2",
        method: "select",
        title: `t3-user-input:v1:${JSON.stringify(payload)}`,
        options: ["Answer in T3 Code"],
      });
    });
    pendingUiResolve = undefined;
    if (uiLogPath) {
      NodeFS.appendFileSync(uiLogPath, `${JSON.stringify(answer)}\n`);
    }
  }

  await sleep(5);
  writeLine({
    type: "message_update",
    usage,
    assistantMessageEvent: { type: "text_start", contentIndex: 0 },
  });
  for (const delta of ["hello ", "from ", "pi"]) {
    await sleep(2);
    if (aborted) return;
    writeLine({
      type: "message_update",
      usage,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
    });
  }
  if (hangPrompt) {
    return;
  }
  writeLine({
    type: "message_update",
    usage,
    assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "hello from pi" },
  });
  writeLine({ type: "message_end", message: { role: "assistant" } });
  state.isStreaming = false;
  writeLine({
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "stop" }],
    willRetry: false,
  });
  if (emitSubagents && !hangSubagent) {
    subagentMarker({
      kind: "progress",
      bridgeRunId,
      childId: "sa-1",
      status: "running",
      lastToolName: "read",
      summary: "Finishing the mock child",
      usedTokens: 120,
      contextWindow: 1_000,
    });
    const completed = {
      kind: "completed",
      bridgeRunId,
      childId: "sa-1",
      status: "completed",
      summary: "Mock child complete",
      usedTokens: 180,
    };
    subagentMarker(completed);
    subagentMarker(completed);
  }
}

function handleCommand(command: Record<string, unknown>) {
  const id = typeof command.id === "string" ? command.id : undefined;
  switch (command.type) {
    case "get_state":
      respond(id, "get_state", {
        data: {
          model: state.model,
          thinkingLevel: "medium",
          isStreaming: state.isStreaming,
          isCompacting: false,
          steeringMode: "all",
          followUpMode: "one-at-a-time",
          sessionFile: state.sessionFile,
          sessionId: state.sessionId,
          sessionName: null,
          autoCompactionEnabled: true,
          messageCount: 0,
          pendingMessageCount: 0,
        },
      });
      return;
    case "get_available_models":
      respond(id, "get_available_models", {
        data: {
          models: [
            { provider: "anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5" },
            { provider: "openai", id: "gpt-5", name: "GPT-5" },
          ],
        },
      });
      return;
    case "set_model": {
      const provider = typeof command.provider === "string" ? command.provider : "";
      const modelId = typeof command.modelId === "string" ? command.modelId : "";
      if (provider === "bogus") {
        respondError(id, "set_model", `Model not found: ${provider}/${modelId}`);
        return;
      }
      state.model = { provider, id: modelId, name: modelId };
      respond(id, "set_model");
      return;
    }
    case "prompt": {
      if (failPrompt) {
        respondError(id, "prompt", "Mock prompt failure.");
        return;
      }
      respond(id, "prompt");
      void runTurn();
      return;
    }
    case "abort": {
      aborted = true;
      state.isStreaming = false;
      respond(id, "abort");
      writeLine({
        type: "agent_end",
        messages: [{ role: "assistant", stopReason: "aborted" }],
        willRetry: false,
      });
      return;
    }
    case "extension_ui_response": {
      if (pendingUiResolve && (command.id === "ui-1" || command.id === "ui-2")) {
        pendingUiResolve(command);
      }
      return;
    }
    default:
      respondError(
        id,
        typeof command.type === "string" ? command.type : "unknown",
        "Unsupported mock command.",
      );
  }
}

let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffered += chunk;
  let newlineIndex = buffered.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = buffered.slice(0, newlineIndex).replace(/\r$/, "");
    buffered = buffered.slice(newlineIndex + 1);
    if (line.trim().length > 0) {
      try {
        handleCommand(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // ignore malformed input
      }
    }
    newlineIndex = buffered.indexOf("\n");
  }
});

function logExit() {
  if (exitLogPath) {
    try {
      NodeFS.writeFileSync(exitLogPath, "exited");
    } catch {
      // best effort
    }
  }
}

process.on("SIGTERM", () => {
  logExit();
  process.exit(0);
});
process.on("exit", logExit);
process.stdin.on("end", () => {
  logExit();
  process.exit(0);
});
