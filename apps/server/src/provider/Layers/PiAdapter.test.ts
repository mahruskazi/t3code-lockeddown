/**
 * [fork:pi] Pi adapter integration tests against the mock RPC agent
 * (scripts/pi-mock-rpc-agent.ts), mirroring the GrokAdapter test setup.
 */
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ApprovalRequestId,
  PiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { makePiAdapter } from "./PiAdapter.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/pi-mock-rpc-agent.ts");
const mockAgentCommand = process.execPath;

async function makeMockPiWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-rpc-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-pi.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

function waitForFileContent(filePath: string, attempts = 40): Effect.Effect<string> {
  const readAttempt = (remainingAttempts: number): Effect.Effect<string> =>
    Effect.gen(function* () {
      if (remainingAttempts <= 0) {
        return yield* Effect.die(new Error(`Timed out waiting for file content at ${filePath}`));
      }
      const raw = yield* Effect.tryPromise(() => NodeFSP.readFile(filePath, "utf8")).pipe(
        Effect.orElseSucceed(() => ""),
      );
      if (raw.trim().length > 0) {
        return raw;
      }
      yield* Effect.sleep("25 millis");
      return yield* readAttempt(remainingAttempts - 1);
    });
  return readAttempt(attempts);
}

const piAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-pi-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makePiAdapter>[1]) =>
  makePiAdapter(decodePiSettings({ binaryPath }), options).pipe(Effect.orDie);

it.layer(piAdapterTestLayer)("PiAdapterLive", (it) => {
  it.effect("starts a session and maps the mock RPC prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-mock-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockPiWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("pi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "openai/gpt-5" },
      });

      assert.equal(session.provider, "pi");
      assert.equal(session.model, "openai/gpt-5");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionFile: "/tmp/pi-mock-session.jsonl",
      });

      const result = yield* adapter.sendTurn({
        threadId,
        input: "hello pi",
        attachments: [],
      });
      assert.equal(result.threadId, threadId);

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);
      const types = runtimeEvents.map((e) => e.type);

      assert.includeMembers(types, [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "item.started",
        "content.delta",
        "item.completed",
        "thread.token-usage.updated",
        "turn.completed",
      ] as const);

      const deltas = runtimeEvents.filter((e) => e.type === "content.delta");
      const text = deltas.map((e) => (e.type === "content.delta" ? e.payload.delta : "")).join("");
      assert.equal(text, "hello from pi");

      const usage = runtimeEvents.find((e) => e.type === "thread.token-usage.updated");
      if (usage?.type === "thread.token-usage.updated") {
        assert.equal(usage.payload.usage.usedTokens, 178);
      }

      const completed = runtimeEvents.find((e) => e.type === "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.state, "completed");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("surfaces T3 extension approvals and answers Pi over the UI protocol", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-approval-thread");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-adapter-ui-log-")),
      );
      const uiLogPath = NodePath.join(tempDir, "ui.log");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockPiWrapper({ PI_MOCK_APPROVAL: "1", PI_MOCK_UI_LOG_PATH: uiLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (event.type === "request.opened" && event.requestId !== undefined) {
            yield* adapter
              .respondToRequest(threadId, ApprovalRequestId.make(event.requestId), "accept")
              .pipe(Effect.orDie);
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, undefined);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      yield* adapter.sendTurn({ threadId, input: "run something", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const opened = runtimeEvents.find((e) => e.type === "request.opened");
      assert.isDefined(opened);
      if (opened?.type === "request.opened") {
        assert.equal(opened.payload.requestType, "exec_command_approval");
        assert.equal(opened.payload.detail, "rm -rf /tmp/x");
      }
      const resolved = runtimeEvents.find((e) => e.type === "request.resolved");
      if (resolved?.type === "request.resolved") {
        assert.equal(resolved.payload.decision, "accept");
      }

      // The gated bash tool ran after approval.
      const toolStart = runtimeEvents.find(
        (e) => e.type === "item.started" && e.payload.itemType === "command_execution",
      );
      assert.isDefined(toolStart);

      // The completed event carries the client render data; the end event from
      // Pi has no args, so `command` proves the start-event args cache worked.
      const toolCompleted = runtimeEvents.find(
        (e) => e.type === "item.completed" && e.payload.itemType === "command_execution",
      );
      assert.isDefined(toolCompleted);
      if (toolCompleted?.type === "item.completed") {
        assert.equal(toolCompleted.payload.title, "Ran command");
        const data = toolCompleted.payload.data as Record<string, unknown> | undefined;
        assert.isDefined(data);
        assert.equal(data?.toolCallId, "call-1");
        assert.equal(data?.command, "rm -rf /tmp/x");
        assert.deepEqual(data?.rawOutput, { content: "done" });
      }

      // Pi received the mapped answer over extension_ui_response.
      const uiLog = yield* waitForFileContent(uiLogPath);
      assert.include(uiLog, '"value":"Allow"');

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("surfaces structured Pi questions and returns the complete answer map", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-user-input-thread");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-adapter-user-input-log-")),
      );
      const uiLogPath = NodePath.join(tempDir, "ui.log");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockPiWrapper({ PI_MOCK_USER_INPUT: "1", PI_MOCK_UI_LOG_PATH: uiLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (event.type === "user-input.requested" && event.requestId !== undefined) {
            yield* adapter
              .respondToUserInput(threadId, ApprovalRequestId.make(event.requestId), {
                platform: "Desktop",
                features: ["Speed", "Remote"],
              })
              .pipe(Effect.orDie);
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, undefined);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({ threadId, input: "ask me", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const requested = runtimeEvents.find((event) => event.type === "user-input.requested");
      assert.isDefined(requested);
      if (requested?.type === "user-input.requested") {
        assert.lengthOf(requested.payload.questions, 2);
        assert.equal(requested.payload.questions[0]?.header, "Platform");
        assert.equal(requested.payload.questions[0]?.options[0]?.description, "The desktop app");
        assert.isTrue(requested.payload.questions[1]?.multiSelect);
      }
      const resolved = runtimeEvents.find((event) => event.type === "user-input.resolved");
      assert.isDefined(resolved);
      if (resolved?.type === "user-input.resolved") {
        assert.deepEqual(resolved.payload.answers, {
          platform: "Desktop",
          features: ["Speed", "Remote"],
        });
      }

      const uiLog = yield* waitForFileContent(uiLogPath);
      const response = JSON.parse(uiLog.trim()) as Record<string, unknown>;
      assert.equal(
        response.value,
        't3-user-input-response:v1:{"platform":"Desktop","features":["Speed","Remote"]}',
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("maps todo_write to plan updates and surfaces extension warnings", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-rich-output-thread");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockPiWrapper({ PI_MOCK_TODOS: "1", PI_MOCK_NOTIFY: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, undefined);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({ threadId, input: "do the work", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      // The todo_write checklist feeds the plan surface…
      const planUpdate = runtimeEvents.find((event) => event.type === "turn.plan.updated");
      assert.isDefined(planUpdate);
      if (planUpdate?.type === "turn.plan.updated") {
        assert.isDefined(planUpdate.turnId);
        assert.deepEqual(planUpdate.payload.plan, [
          { step: "Write tests", status: "completed" },
          { step: "Fix the bug", status: "inProgress" },
          { step: "Ship it", status: "pending" },
        ]);
      }
      // …while the tool row itself is preserved.
      const todoItem = runtimeEvents.find(
        (event) =>
          event.type === "item.completed" &&
          (event.payload.data as Record<string, unknown> | undefined)?.toolCallId === "todo-call-1",
      );
      assert.isDefined(todoItem);

      // Warning notifications become one work-log row: consecutive
      // duplicates are collapsed and info-level stays TUI-only.
      const warnings = runtimeEvents.filter((event) => event.type === "runtime.warning");
      assert.lengthOf(warnings, 1);
      if (warnings[0]?.type === "runtime.warning") {
        assert.equal(warnings[0].payload.message, "Typecheck failed: 2 errors");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("interruptTurn settles a streaming turn as cancelled", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-interrupt-thread");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockPiWrapper({ PI_MOCK_HANG_PROMPT: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const sawDelta = yield* Deferred.make<void>();
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (event.type === "content.delta") {
            yield* Deferred.succeed(sawDelta, undefined);
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, undefined);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const turnFiber = yield* adapter
        .sendTurn({ threadId, input: "never settles", attachments: [] })
        .pipe(Effect.forkChild);

      yield* Deferred.await(sawDelta);
      yield* adapter.interruptTurn(threadId);
      yield* Deferred.await(turnCompleted);
      yield* Fiber.join(turnFiber);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const completed = runtimeEvents.find((e) => e.type === "turn.completed");
      assert.isDefined(completed);
      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.state, "cancelled");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect(
    "maps Pi extension children after the parent turn settles and deduplicates lifecycle",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("pi-subagent-thread");
        const wrapperPath = yield* Effect.promise(() =>
          makeMockPiWrapper({ PI_MOCK_SUBAGENTS: "1" }),
        );
        const adapter = yield* makeTestAdapter(wrapperPath);
        const runtimeEvents: ProviderRuntimeEvent[] = [];
        const taskCompleted = yield* Deferred.make<void>();
        const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => runtimeEvents.push(event)).pipe(
            Effect.andThen(
              event.type === "task.completed"
                ? Deferred.succeed(taskCompleted, undefined)
                : Effect.void,
            ),
          ),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId, input: "spawn a child", attachments: [] });
        yield* Deferred.await(taskCompleted);
        yield* Fiber.interrupt(runtimeEventsFiber);

        const started = runtimeEvents.filter((event) => event.type === "task.started");
        const progress = runtimeEvents.filter((event) => event.type === "task.progress");
        const completed = runtimeEvents.filter((event) => event.type === "task.completed");
        assert.equal(started.length, 1);
        assert.equal(progress.length, 1);
        assert.equal(completed.length, 1);
        assert.isTrue(
          runtimeEvents.findIndex((event) => event.type === "turn.completed") <
            runtimeEvents.findIndex((event) => event.type === "task.progress"),
        );
        const start = started[0];
        if (start?.type === "task.started") {
          assert.match(start.payload.taskId, /^pi:mock-/);
          assert.equal(start.payload.taskType, "local_agent");
          assert.equal(start.payload.role, "pi");
          assert.equal(start.payload.toolUseId, "subagent-tool-1");
          assert.deepEqual(start.payload.runHandles, {
            runId: `${decodeURIComponent(start.payload.taskId.split(":")[1] ?? "")}:sa-1`,
            transcriptDir: "/tmp/mock-child",
          });
          assert.isTrue(start.payload.timelineBypass);
        }
        const terminal = completed[0];
        if (terminal?.type === "task.completed") {
          assert.equal(terminal.payload.status, "completed");
          assert.equal(terminal.payload.typedUsage?.totalTokens, 180);
        }

        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect("terminates an idle Pi session to stop live extension children", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-idle-subagent-stop");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockPiWrapper({
          PI_MOCK_SUBAGENTS: "1",
          PI_MOCK_SUBAGENT_HANG: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const taskStarted = yield* Deferred.make<void>();
      const sessionExited = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (event.type === "task.started") yield* Deferred.succeed(taskStarted, undefined);
          if (event.type === "session.exited") yield* Deferred.succeed(sessionExited, undefined);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "spawn a child", attachments: [] });
      yield* Deferred.await(taskStarted);
      yield* adapter.interruptTurn(threadId);
      yield* Deferred.await(sessionExited);
      assert.isFalse(yield* adapter.hasSession(threadId));

      yield* Fiber.interrupt(runtimeEventsFiber);
    }),
  );

  it.effect("uses the bridge run id to avoid child-id collisions across Pi sessions", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-subagent-session-identity");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockPiWrapper({ PI_MOCK_SUBAGENTS: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const taskIds: string[] = [];
      const sawSecondStart = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (event.type !== "task.started") return;
          taskIds.push(event.payload.taskId);
          if (taskIds.length >= 2) yield* Deferred.succeed(sawSecondStart, undefined);
        }),
      ).pipe(Effect.forkChild);

      for (const input of ["first session", "second session"]) {
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId, input, attachments: [] });
      }
      yield* Deferred.await(sawSecondStart);
      assert.equal(taskIds.length, 2);
      assert.notEqual(taskIds[0], taskIds[1]);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("kills the Pi child process when a session stops", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-stop-session-close");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-adapter-exit-log-")),
      );
      const exitLogPath = NodePath.join(tempDir, "exit.log");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockPiWrapper({ PI_MOCK_EXIT_LOG_PATH: exitLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.stopSession(threadId);

      const exitLog = yield* waitForFileContent(exitLogPath);
      assert.include(exitLog, "exited");
      assert.isFalse(yield* adapter.hasSession(threadId));
    }),
  );

  it.effect("passes the extension path and resume session file to Pi", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-args-thread");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-adapter-args-log-")),
      );
      const argsLogPath = NodePath.join(tempDir, "args.log");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockPiWrapper({ PI_MOCK_ARGS_LOG_PATH: argsLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, {
        extensionFilePath: "/tmp/t3-approvals.ts",
      });

      const session = yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionFile: "/tmp/resume-me.jsonl" },
      });

      const argsLog = yield* waitForFileContent(argsLogPath);
      const args = JSON.parse(argsLog) as string[];
      assert.includeMembers(args, [
        "--mode",
        "rpc",
        "-e",
        "/tmp/t3-approvals.ts",
        "--session",
        "/tmp/resume-me.jsonl",
      ]);
      // The mock reports the resumed session file back through get_state.
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionFile: "/tmp/resume-me.jsonl",
      });

      yield* adapter.stopSession(threadId);
    }),
  );
});
