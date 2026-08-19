/**
 * PiAdapter — provider adapter for the Pi coding agent (`pi --mode rpc`).
 *
 * One `PiRpcProcess` per thread session. Turn lifecycle is event-driven:
 * `sendTurn` writes a `prompt` command and blocks until the pump observes a
 * settling `agent_end` (or the turn is interrupted / the process dies).
 * A `sendTurn` while a turn is streaming is a steer — the prompt is sent
 * with `streamingBehavior: "steer"` and folded into the active turn.
 *
 * Approvals ride Pi's extension UI protocol: the bundled T3 extension
 * (PiExtensionSource.ts) gates mutating tools behind a `select` dialog whose
 * title carries a structured `t3-approval:v1:` payload; the pump maps those
 * onto `request.opened`/`request.resolved` and answers over stdin with
 * `extension_ui_response`. Foreign extension dialogs degrade to user-input
 * questions (`select`/`confirm`) or are cancelled (`input`/`editor`).
 *
 * [fork:pi] This module is fork-local. See docs/internals/fork-pi-provider.md.
 *
 * @module provider/Layers/PiAdapter
 */
import {
  ApprovalRequestId,
  EventId,
  type PiSettings,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  type ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { deriveToolActivityPresentation } from "@t3tools/shared/toolActivity";

import {
  assistantDeltaFromMessageUpdate,
  buildPiToolCallData,
  canonicalRequestTypeForPiTool,
  detailForPiToolCall,
  itemTypeForPiTool,
  PI_PROCESS_EXITED_EVENT,
  PI_RESUME_VERSION,
  parsePiAgentEnd,
  parsePiExtensionUiRequest,
  parsePiResumeCursor,
  parsePiSessionState,
  parsePiToolExecution,
  parseT3PiApprovalTitle,
  parseT3PiSubagentEvent,
  splitPiModelSlug,
  T3_PI_APPROVAL_OPTIONS,
  T3_PI_RUNTIME_MODE_ENV,
  T3_PI_SUBAGENT_BRIDGE_ENV,
  usageSnapshotFromPiUsage,
  type PiExtensionUiRequest,
  type PiRpcEvent,
  type T3PiSubagentEvent,
} from "../piRpc/PiRpcModel.ts";
import { makePiRpcProcess, type PiRpcProcess } from "../piRpc/PiRpcProcess.ts";
import { T3_PI_APPROVAL_MODE_ENV } from "../piRpc/PiExtensionSource.ts";
import { type PiAdapterShape } from "../Services/PiAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("pi");

const GET_STATE_TIMEOUT = Duration.seconds(15);
/** Prompt acks may only arrive at end-of-turn; keep this effectively open. */
const PROMPT_REQUEST_TIMEOUT = Duration.hours(24);
const PI_SUBAGENT_PROGRESS_MIN_INTERVAL_MS = 1_000;
const PI_SUBAGENT_MAX_TASKS_PER_SESSION = 256;

export interface PiAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
  /** Absolute path of the materialized T3 approval extension, if any. */
  readonly extensionFilePath?: string;
}

interface PendingApproval {
  readonly uiRequestId: string;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

type PendingUserInputResolution =
  | { readonly _tag: "answered"; readonly answers: ProviderUserInputAnswers }
  | { readonly _tag: "cancelled" };

interface PendingUserInput {
  readonly uiRequestId: string;
  readonly resolution: Deferred.Deferred<PendingUserInputResolution>;
}

interface PiSubagentTaskState {
  readonly taskId: RuntimeTaskId;
  readonly turnId: TurnId | undefined;
  readonly title: string;
  readonly role: "pi" | "codex";
  readonly toolUseId: string | undefined;
  readonly runHandles: { readonly runId: string; readonly transcriptDir?: string } | undefined;
  model: string | undefined;
  effort: string | undefined;
  terminal: boolean;
  lastProgress: Extract<T3PiSubagentEvent, { readonly kind: "progress" }> | undefined;
  lastProgressAt: number | undefined;
}

function samePiSubagentProgress(
  left: Extract<T3PiSubagentEvent, { readonly kind: "progress" }> | undefined,
  right: Extract<T3PiSubagentEvent, { readonly kind: "progress" }>,
) {
  return (
    left?.status === right.status &&
    left.lastToolName === right.lastToolName &&
    left.summary === right.summary &&
    left.usedTokens === right.usedTokens &&
    left.contextWindow === right.contextWindow &&
    left.model === right.model &&
    left.effort === right.effort
  );
}

type TurnSettlement =
  | { readonly state: "completed" }
  | { readonly state: "cancelled" }
  | { readonly state: "failed"; readonly errorMessage: string };

interface PiSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly rpc: PiRpcProcess;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  /** Resolved when the active turn settles; one per started turn. */
  turnDone: Map<TurnId, Deferred.Deferred<TurnSettlement>>;
  /** Turns already interrupted; late events must not resurrect them. */
  interruptedTurnIds: Set<TurnId>;
  /** contentIndex → live assistant/reasoning item id for delta streaming. */
  readonly activeContentItems: Map<number, { itemId: string; reasoning: boolean }>;
  /** toolCallId → args from `tool_execution_start`; update/end events omit them. */
  readonly toolArgsByCallId: Map<string, Record<string, unknown>>;
  /** Versioned extension lifecycle state, independent of the parent turn. */
  readonly subagentTasks: Map<RuntimeTaskId, PiSubagentTaskState>;
  assistantItemSeq: number;
  lastUsage: ThreadTokenUsageSnapshot | undefined;
  currentModelSlug: string | undefined;
  sessionFile: string | undefined;
  stopped: boolean;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function settlePendingUserInputsAsCancelled(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingUserInputs.values()),
    (pending) => Deferred.succeed(pending.resolution, { _tag: "cancelled" }).pipe(Effect.ignore),
    { discard: true },
  );
}

export function makePiAdapter(piSettings: PiSettings, options?: PiAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("pi");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

    const sessions = new Map<ThreadId, PiSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Pi runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to write native Pi notification log.", {
            cause,
            threadId,
            method,
          }),
        ),
      );

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<PiSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    /** Settle the given turn (idempotent) and put the session back to ready. */
    const settleTurn = (ctx: PiSessionContext, turnId: TurnId, settlement: TurnSettlement) =>
      Effect.gen(function* () {
        const done = ctx.turnDone.get(turnId);
        ctx.turnDone.delete(turnId);
        const isActive = ctx.activeTurnId === turnId;
        if (isActive) {
          ctx.activeTurnId = undefined;
          ctx.activeContentItems.clear();
          const { activeTurnId: _activeTurnId, ...readySession } = ctx.session;
          ctx.session = {
            ...readySession,
            status: "ready",
            updatedAt: yield* nowIso,
          };
        }
        if (done === undefined && !isActive) {
          // Late settlement for a turn that was already settled.
          return;
        }
        if (ctx.lastUsage) {
          yield* offerRuntimeEvent({
            type: "thread.token-usage.updated",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload: { usage: ctx.lastUsage },
          });
        }
        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload:
            settlement.state === "failed"
              ? { state: "failed", errorMessage: settlement.errorMessage }
              : { state: settlement.state, stopReason: null },
        });
        if (done) {
          yield* Deferred.succeed(done, settlement);
        }
      });

    const stopSessionInternal = (ctx: PiSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs);
        // Unblock any sendTurn awaiting settlement before tearing down.
        for (const [turnId, done] of ctx.turnDone) {
          ctx.interruptedTurnIds.add(turnId);
          yield* Deferred.succeed(done, { state: "cancelled" }).pipe(Effect.ignore);
        }
        ctx.turnDone.clear();
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        ctx.subagentTasks.clear();
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const handleT3PiSubagentEvent = Effect.fn("PiAdapter.handleT3PiSubagentEvent")(function* (
      ctx: PiSessionContext,
      event: T3PiSubagentEvent,
    ) {
      const taskId = RuntimeTaskId.make(
        `pi:${encodeURIComponent(event.bridgeRunId)}:${encodeURIComponent(event.childId)}`,
      );
      const existing = ctx.subagentTasks.get(taskId);

      if (event.kind === "started") {
        if (existing || ctx.subagentTasks.size >= PI_SUBAGENT_MAX_TASKS_PER_SESSION) return;
        const runHandles = event.transcriptPath
          ? {
              runId: `${event.bridgeRunId}:${event.childId}`,
              transcriptDir: path.dirname(event.transcriptPath),
            }
          : undefined;
        const state: PiSubagentTaskState = {
          taskId,
          turnId: ctx.activeTurnId,
          title: event.title,
          role: event.harness,
          toolUseId: event.toolUseId,
          runHandles,
          model: event.model,
          effort: event.effort,
          terminal: false,
          lastProgress: undefined,
          lastProgressAt: undefined,
        };
        ctx.subagentTasks.set(taskId, state);
        yield* offerRuntimeEvent({
          type: "task.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          ...(state.turnId ? { turnId: state.turnId } : {}),
          payload: {
            taskId,
            taskType: "local_agent",
            description: state.title,
            title: state.title,
            role: state.role,
            ...(state.model ? { model: state.model } : {}),
            ...(state.effort ? { effort: state.effort } : {}),
            ...(state.toolUseId ? { toolUseId: state.toolUseId } : {}),
            ...(state.runHandles ? { runHandles: state.runHandles } : {}),
            timelineBypass: true,
          },
        });
        return;
      }

      if (!existing || existing.terminal) return;
      const linkage = () =>
        ({
          taskType: "local_agent",
          title: existing.title,
          role: existing.role,
          ...(existing.model ? { model: existing.model } : {}),
          ...(existing.effort ? { effort: existing.effort } : {}),
          ...(existing.toolUseId ? { toolUseId: existing.toolUseId } : {}),
          ...(existing.runHandles ? { runHandles: existing.runHandles } : {}),
          timelineBypass: true,
        }) as const;
      const turnLink = existing.turnId ? { turnId: existing.turnId } : {};

      if (event.kind === "progress") {
        existing.model = event.model ?? existing.model;
        existing.effort = event.effort ?? existing.effort;
        const observedAt = yield* Clock.currentTimeMillis;
        if (
          samePiSubagentProgress(existing.lastProgress, event) ||
          (existing.lastProgressAt !== undefined &&
            observedAt - existing.lastProgressAt < PI_SUBAGENT_PROGRESS_MIN_INTERVAL_MS)
        ) {
          return;
        }
        existing.lastProgress = event;
        existing.lastProgressAt = observedAt;
        const typedUsage =
          event.usedTokens !== undefined ? { totalTokens: event.usedTokens } : undefined;
        yield* offerRuntimeEvent({
          type: "task.progress",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          ...turnLink,
          payload: {
            taskId,
            description: event.summary ?? (event.status === "waiting" ? "Waiting" : "Running"),
            status: event.status,
            ...(event.summary ? { summary: event.summary } : {}),
            ...(event.lastToolName ? { lastToolName: event.lastToolName } : {}),
            ...(event.usedTokens !== undefined || event.contextWindow !== undefined
              ? {
                  usage: {
                    ...(event.usedTokens !== undefined ? { usedTokens: event.usedTokens } : {}),
                    ...(event.contextWindow !== undefined
                      ? { contextWindow: event.contextWindow }
                      : {}),
                  },
                }
              : {}),
            ...(typedUsage ? { typedUsage } : {}),
            ...linkage(),
          },
        });
        return;
      }

      existing.terminal = true;
      const typedUsage =
        event.usedTokens !== undefined ? { totalTokens: event.usedTokens } : undefined;
      const terminalSummary =
        event.status === "failed" ? (event.error ?? event.summary) : (event.summary ?? event.error);
      yield* offerRuntimeEvent({
        type: "task.completed",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        threadId: ctx.threadId,
        ...turnLink,
        payload: {
          taskId,
          status: event.status,
          ...(terminalSummary ? { summary: terminalSummary } : {}),
          ...(event.usedTokens !== undefined ? { usage: { usedTokens: event.usedTokens } } : {}),
          ...(typedUsage ? { typedUsage } : {}),
          ...linkage(),
        },
      });
    });

    // ── Extension UI handling ─────────────────────────────────────────

    const respondUi = (ctx: PiSessionContext, uiRequestId: string, body: Record<string, unknown>) =>
      ctx.rpc.send({ type: "extension_ui_response", id: uiRequestId, ...body }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to answer Pi extension UI request.", {
            cause,
            threadId: ctx.threadId,
          }),
        ),
      );

    const handleApprovalUiRequest = (
      ctx: PiSessionContext,
      ui: PiExtensionUiRequest,
      approval: { toolName: string; detail: string | undefined; args: unknown },
    ) =>
      Effect.gen(function* () {
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
        const runtimeRequestId = RuntimeRequestId.make(requestId);
        const decision = yield* Deferred.make<ProviderApprovalDecision>();
        const turnId = ctx.activeTurnId;
        ctx.pendingApprovals.set(requestId, { uiRequestId: ui.id, decision });
        yield* offerRuntimeEvent({
          type: "request.opened",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          requestId: runtimeRequestId,
          payload: {
            requestType: canonicalRequestTypeForPiTool(approval.toolName),
            detail: approval.detail ?? approval.toolName,
            args: approval.args,
          },
          raw: {
            source: "pi.rpc.extension",
            method: "extension_ui_request",
            payload: ui,
          },
        });
        const resolved = yield* Deferred.await(decision);
        ctx.pendingApprovals.delete(requestId);
        yield* offerRuntimeEvent({
          type: "request.resolved",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          requestId: runtimeRequestId,
          payload: {
            requestType: canonicalRequestTypeForPiTool(approval.toolName),
            decision: resolved,
          },
        });
        switch (resolved) {
          case "accept":
            return yield* respondUi(ctx, ui.id, { value: T3_PI_APPROVAL_OPTIONS.allow });
          case "acceptForSession":
            return yield* respondUi(ctx, ui.id, { value: T3_PI_APPROVAL_OPTIONS.allowAlways });
          case "decline":
            return yield* respondUi(ctx, ui.id, { value: T3_PI_APPROVAL_OPTIONS.deny });
          case "cancel":
            return yield* respondUi(ctx, ui.id, { cancelled: true });
        }
      });

    /** Foreign extension `select`/`confirm` dialogs become user-input questions. */
    const handleForeignUiRequest = (ctx: PiSessionContext, ui: PiExtensionUiRequest) =>
      Effect.gen(function* () {
        if (ui.method !== "select" && ui.method !== "confirm") {
          // input/editor and unknown blocking dialogs cannot be represented;
          // cancel them so the turn does not hang. Fire-and-forget methods
          // (notify/setStatus/…) take no response at all.
          if (ui.method === "input" || ui.method === "editor") {
            yield* respondUi(ctx, ui.id, { cancelled: true });
          }
          return;
        }
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
        const runtimeRequestId = RuntimeRequestId.make(requestId);
        const resolution = yield* Deferred.make<PendingUserInputResolution>();
        const turnId = ctx.activeTurnId;
        ctx.pendingUserInputs.set(requestId, { uiRequestId: ui.id, resolution });
        const questionId = "pi-dialog";
        const options =
          ui.method === "confirm" ? ["Yes", "No"] : ui.options.length > 0 ? ui.options : ["OK"];
        yield* offerRuntimeEvent({
          type: "user-input.requested",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          requestId: runtimeRequestId,
          payload: {
            questions: [
              {
                id: questionId,
                header: "Pi",
                question: ui.title?.trim() || ui.message?.trim() || "Pi extension request",
                options: options.map((label) => ({
                  label,
                  description: label,
                })),
                multiSelect: false,
              },
            ],
          },
          raw: {
            source: "pi.rpc.extension",
            method: "extension_ui_request",
            payload: ui,
          },
        });
        const resolved = yield* Deferred.await(resolution);
        ctx.pendingUserInputs.delete(requestId);
        const answers = resolved._tag === "answered" ? resolved.answers : {};
        yield* offerRuntimeEvent({
          type: "user-input.resolved",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          requestId: runtimeRequestId,
          payload: { answers },
        });
        if (resolved._tag === "cancelled") {
          return yield* respondUi(ctx, ui.id, { cancelled: true });
        }
        const raw = answers[questionId];
        const answer = Array.isArray(raw) ? raw[0] : raw;
        const value = typeof answer === "string" ? answer : undefined;
        if (ui.method === "confirm") {
          return yield* respondUi(ctx, ui.id, { confirmed: value === "Yes" });
        }
        return value === undefined
          ? yield* respondUi(ctx, ui.id, { cancelled: true })
          : yield* respondUi(ctx, ui.id, { value });
      });

    // ── Event pump ────────────────────────────────────────────────────

    const handlePumpEvent = (ctx: PiSessionContext, event: PiRpcEvent) =>
      Effect.gen(function* () {
        switch (event.type) {
          case PI_PROCESS_EXITED_EVENT: {
            if (ctx.stopped) return;
            const code = typeof event.code === "number" ? event.code : -1;
            ctx.stopped = true;
            yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
            yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs);
            const activeTurnId = ctx.activeTurnId;
            if (activeTurnId !== undefined) {
              yield* settleTurn(ctx, activeTurnId, {
                state: "failed",
                errorMessage: `Pi process exited unexpectedly with code ${code}.`,
              });
            }
            for (const [, done] of ctx.turnDone) {
              yield* Deferred.succeed(done, {
                state: "failed",
                errorMessage: `Pi process exited unexpectedly with code ${code}.`,
              }).pipe(Effect.ignore);
            }
            ctx.turnDone.clear();
            ctx.subagentTasks.clear();
            sessions.delete(ctx.threadId);
            yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
            yield* offerRuntimeEvent({
              type: "session.exited",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: ctx.threadId,
              payload: {
                exitKind: "error",
                reason: `Pi process exited unexpectedly with code ${code}.`,
              },
            });
            return;
          }
          case "extension_ui_request": {
            const subagentEvent = parseT3PiSubagentEvent(event);
            if (subagentEvent) {
              yield* logNative(ctx.threadId, "t3_subagent", subagentEvent);
              yield* handleT3PiSubagentEvent(ctx, subagentEvent);
              return;
            }
            const ui = parsePiExtensionUiRequest(event);
            if (!ui) return;
            yield* logNative(ctx.threadId, "extension_ui_request", event);
            const approval = parseT3PiApprovalTitle(ui.title);
            const handler = approval
              ? handleApprovalUiRequest(ctx, ui, approval)
              : handleForeignUiRequest(ctx, ui);
            // Blocking dialogs must not stall the pump.
            yield* handler.pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Pi extension UI handling failed.", {
                  cause,
                  threadId: ctx.threadId,
                }),
              ),
              Effect.forkChild,
            );
            return;
          }
          default:
            break;
        }

        const turnId = ctx.activeTurnId;
        if (turnId === undefined || ctx.interruptedTurnIds.has(turnId)) {
          return;
        }

        switch (event.type) {
          case "message_update": {
            const usage = usageSnapshotFromPiUsage(event.usage);
            if (usage) {
              ctx.lastUsage = usage;
            }
            const delta = assistantDeltaFromMessageUpdate(event);
            if (!delta || delta.kind === "other") {
              return;
            }
            const stamp = yield* makeEventStamp();
            switch (delta.kind) {
              case "text_start":
              case "thinking_start": {
                const reasoning = delta.kind === "thinking_start";
                const itemId = `pi-${reasoning ? "reasoning" : "text"}-${turnId}-${ctx.assistantItemSeq}`;
                ctx.assistantItemSeq += 1;
                ctx.activeContentItems.set(delta.contentIndex, { itemId, reasoning });
                yield* offerRuntimeEvent({
                  type: "item.started",
                  ...stamp,
                  provider: PROVIDER,
                  threadId: ctx.threadId,
                  turnId,
                  itemId: RuntimeItemId.make(itemId),
                  payload: {
                    itemType: reasoning ? "reasoning" : "assistant_message",
                    status: "inProgress",
                  },
                });
                return;
              }
              case "text_delta":
              case "thinking_delta": {
                const reasoning = delta.kind === "thinking_delta";
                let active = ctx.activeContentItems.get(delta.contentIndex);
                if (!active) {
                  const itemId = `pi-${reasoning ? "reasoning" : "text"}-${turnId}-${ctx.assistantItemSeq}`;
                  ctx.assistantItemSeq += 1;
                  active = { itemId, reasoning };
                  ctx.activeContentItems.set(delta.contentIndex, active);
                  yield* offerRuntimeEvent({
                    type: "item.started",
                    ...stamp,
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId,
                    itemId: RuntimeItemId.make(active.itemId),
                    payload: {
                      itemType: reasoning ? "reasoning" : "assistant_message",
                      status: "inProgress",
                    },
                  });
                }
                yield* offerRuntimeEvent({
                  type: "content.delta",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: ctx.threadId,
                  turnId,
                  itemId: RuntimeItemId.make(active.itemId),
                  payload: {
                    streamKind: reasoning ? "reasoning_text" : "assistant_text",
                    delta: delta.delta,
                    contentIndex: delta.contentIndex,
                  },
                });
                return;
              }
              case "text_end":
              case "thinking_end": {
                const active = ctx.activeContentItems.get(delta.contentIndex);
                if (!active) return;
                ctx.activeContentItems.delete(delta.contentIndex);
                yield* offerRuntimeEvent({
                  type: "item.completed",
                  ...stamp,
                  provider: PROVIDER,
                  threadId: ctx.threadId,
                  turnId,
                  itemId: RuntimeItemId.make(active.itemId),
                  payload: {
                    itemType: active.reasoning ? "reasoning" : "assistant_message",
                    status: "completed",
                  },
                });
                return;
              }
            }
            return;
          }
          case "tool_execution_start":
          case "tool_execution_update":
          case "tool_execution_end": {
            yield* logNative(ctx.threadId, event.type, event);
            const tool = parsePiToolExecution(event);
            if (!tool) return;
            const completed = event.type === "tool_execution_end";
            const status = completed
              ? tool.isError === true
                ? "failed"
                : "completed"
              : "inProgress";
            // Args only arrive on tool_execution_start; carry them through the
            // lifecycle so the completed event (the row clients render) keeps
            // the command/path context.
            if (event.type === "tool_execution_start") {
              ctx.toolArgsByCallId.set(tool.toolCallId, tool.args);
            }
            const args =
              Object.keys(tool.args).length > 0
                ? tool.args
                : (ctx.toolArgsByCallId.get(tool.toolCallId) ?? {});
            if (completed) {
              ctx.toolArgsByCallId.delete(tool.toolCallId);
            }
            const itemType = itemTypeForPiTool(tool.toolName);
            const data = buildPiToolCallData({
              toolCallId: tool.toolCallId,
              toolName: tool.toolName,
              args,
              resultText: tool.resultText,
            });
            const presentation = deriveToolActivityPresentation({
              itemType,
              title: tool.toolName,
              detail: detailForPiToolCall(tool.toolName, args),
              data,
              fallbackSummary: tool.toolName,
            });
            yield* offerRuntimeEvent({
              type:
                event.type === "tool_execution_start"
                  ? "item.started"
                  : completed
                    ? "item.completed"
                    : "item.updated",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId,
              itemId: RuntimeItemId.make(tool.toolCallId),
              payload: {
                itemType,
                status,
                title: presentation.summary,
                ...(presentation.detail ? { detail: presentation.detail } : {}),
                data,
              },
              raw: {
                source: "pi.rpc",
                method: event.type,
                payload: completed
                  ? { toolCallId: tool.toolCallId, isError: tool.isError }
                  : undefined,
              },
            });
            return;
          }
          case "message_end": {
            if (ctx.lastUsage) {
              yield* offerRuntimeEvent({
                type: "thread.token-usage.updated",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId,
                payload: { usage: ctx.lastUsage },
              });
            }
            return;
          }
          case "agent_end": {
            const outcome = parsePiAgentEnd(event);
            if (outcome.willRetry) {
              return;
            }
            yield* logNative(ctx.threadId, "agent_end", { willRetry: outcome.willRetry });
            yield* settleTurn(
              ctx,
              turnId,
              outcome.errorMessage !== undefined
                ? { state: "failed", errorMessage: outcome.errorMessage }
                : outcome.aborted
                  ? { state: "cancelled" }
                  : { state: "completed" },
            );
            return;
          }
          default:
            return;
        }
      });

    // ── Adapter surface ───────────────────────────────────────────────

    const startSession: PiAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const piModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );

          const resume = parsePiResumeCursor(input.resumeCursor);
          const args: Array<string> = ["--mode", "rpc"];
          if (options?.extensionFilePath) {
            args.push("-e", options.extensionFilePath);
          }
          if (resume) {
            args.push("--session", resume.sessionFile);
          }

          const environment: NodeJS.ProcessEnv = {
            ...(options?.environment ?? process.env),
            [T3_PI_APPROVAL_MODE_ENV]: input.runtimeMode === "full-access" ? "off" : "gated",
            [T3_PI_SUBAGENT_BRIDGE_ENV]: "v1",
            [T3_PI_RUNTIME_MODE_ENV]: input.runtimeMode,
          };

          const rpc = yield* makePiRpcProcess({
            binaryPath: piSettings.binaryPath,
            args,
            cwd,
            env: environment,
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );

          const state = yield* rpc
            .request({ type: "get_state" }, { timeout: GET_STATE_TIMEOUT })
            .pipe(
              Effect.map((response) => parsePiSessionState(response.data)),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: input.threadId,
                    detail: `Pi RPC did not report session state: ${cause.message}`,
                    cause,
                  }),
              ),
            );

          let boundModelSlug = state.modelSlug;
          const requestedModel = splitPiModelSlug(piModelSelection?.model);
          if (requestedModel && piModelSelection?.model !== state.modelSlug) {
            yield* rpc
              .request({
                type: "set_model",
                provider: requestedModel.provider,
                modelId: requestedModel.modelId,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "set_model",
                      detail: cause.message,
                      cause,
                    }),
                ),
              );
            boundModelSlug = piModelSelection?.model;
          }

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(boundModelSlug ? { model: boundModelSlug } : {}),
            threadId: input.threadId,
            ...(state.sessionFile
              ? {
                  resumeCursor: {
                    schemaVersion: PI_RESUME_VERSION,
                    sessionFile: state.sessionFile,
                  },
                }
              : {}),
            createdAt: now,
            updatedAt: now,
          };

          const ctx: PiSessionContext = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            rpc,
            pendingApprovals: new Map(),
            pendingUserInputs: new Map(),
            turns: [],
            activeTurnId: undefined,
            turnDone: new Map(),
            interruptedTurnIds: new Set(),
            activeContentItems: new Map(),
            toolArgsByCallId: new Map(),
            subagentTasks: new Map(),
            assistantItemSeq: 0,
            lastUsage: undefined,
            currentModelSlug: boundModelSlug,
            sessionFile: state.sessionFile,
            stopped: false,
          };

          yield* Stream.runDrain(
            Stream.mapEffect(rpc.events, (event) =>
              handlePumpEvent(ctx, event).pipe(
                Effect.catchCause((cause) =>
                  Effect.logError("Failed to process Pi runtime event.", { cause }),
                ),
              ),
            ),
          ).pipe(Effect.forkIn(sessionScope));

          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: {},
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Pi RPC session ready" },
          });
          if (state.sessionId) {
            yield* offerRuntimeEvent({
              type: "thread.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { providerThreadId: state.sessionId },
            });
          }

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: PiAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const prepared = yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(input.threadId);
            const steeringTurnId = ctx.activeTurnId;
            const steering = steeringTurnId !== undefined;
            const turnId = steeringTurnId ?? TurnId.make(yield* randomUUIDv4);

            const text = input.input?.trim();
            const images = yield* Effect.forEach(input.attachments ?? [], (attachment) =>
              Effect.gen(function* () {
                const attachmentPath = resolveAttachmentPath({
                  attachmentsDir: serverConfig.attachmentsDir,
                  attachment,
                });
                if (!attachmentPath) {
                  return yield* new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "prompt",
                    detail: `Invalid attachment id '${attachment.id}'.`,
                  });
                }
                const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapterRequestError({
                        provider: PROVIDER,
                        method: "prompt",
                        detail: cause.message,
                        cause,
                      }),
                  ),
                );
                return {
                  type: "image" as const,
                  data: Buffer.from(bytes).toString("base64"),
                  mimeType: attachment.mimeType,
                };
              }),
            );

            if (!text && images.length === 0) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: "Turn requires non-empty text or attachments.",
              });
            }

            // Model switch (in-session) when a different model is requested.
            const turnModelSelection =
              input.modelSelection?.instanceId === boundInstanceId
                ? input.modelSelection
                : undefined;
            const requestedSlug = turnModelSelection?.model?.trim() || undefined;
            if (requestedSlug !== undefined && requestedSlug !== ctx.currentModelSlug) {
              const split = splitPiModelSlug(requestedSlug);
              if (split) {
                yield* ctx.rpc
                  .request({ type: "set_model", provider: split.provider, modelId: split.modelId })
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new ProviderAdapterRequestError({
                          provider: PROVIDER,
                          method: "set_model",
                          detail: cause.message,
                          cause,
                        }),
                    ),
                  );
                ctx.currentModelSlug = requestedSlug;
              }
            }

            const done = ctx.turnDone.get(turnId) ?? (yield* Deferred.make<TurnSettlement>());
            ctx.turnDone.set(turnId, done);
            ctx.activeTurnId = turnId;
            if (!steering) {
              ctx.lastUsage = undefined;
            }
            ctx.session = {
              ...ctx.session,
              status: "running",
              activeTurnId: turnId,
              updatedAt: yield* nowIso,
              ...(ctx.currentModelSlug ? { model: ctx.currentModelSlug } : {}),
            };
            ctx.turns = [
              ...ctx.turns.filter((turn) => turn.id !== turnId),
              {
                id: turnId,
                items: [
                  ...(ctx.turns.find((turn) => turn.id === turnId)?.items ?? []),
                  { prompt: text, attachments: images.length },
                ],
              },
            ];

            if (!steering) {
              yield* offerRuntimeEvent({
                type: "turn.started",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: ctx.currentModelSlug ? { model: ctx.currentModelSlug } : {},
              });
            }

            return { ctx, turnId, done, steering, text, images };
          }),
        );

        const { ctx, turnId, done, steering } = prepared;

        // The prompt ack may arrive immediately or only at end-of-turn
        // depending on the Pi version; run it concurrently and let a
        // failed ack settle the turn.
        yield* prepared.ctx.rpc
          .request(
            {
              type: "prompt",
              ...(prepared.text ? { message: prepared.text } : { message: "" }),
              ...(prepared.images.length > 0 ? { images: prepared.images } : {}),
              ...(steering ? { streamingBehavior: "steer" } : {}),
            },
            { timeout: PROMPT_REQUEST_TIMEOUT },
          )
          .pipe(
            Effect.tapError((cause) =>
              withThreadLock(
                input.threadId,
                Effect.gen(function* () {
                  const liveCtx = sessions.get(input.threadId);
                  if (!liveCtx || liveCtx.stopped) return;
                  if (liveCtx.interruptedTurnIds.has(turnId)) return;
                  if (liveCtx.activeTurnId !== turnId) return;
                  yield* settleTurn(liveCtx, turnId, {
                    state: "failed",
                    errorMessage: cause.message,
                  });
                }),
              ),
            ),
            Effect.ignore,
            Effect.forkChild,
          );

        yield* Deferred.await(done);

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: ctx.session.resumeCursor,
        };
      });

    const interruptTurn: PiAdapterShape["interruptTurn"] = (threadId, turnId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (!ctx || ctx.stopped) {
            return;
          }
          const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
          if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
            return;
          }
          const interruptedTurnId = turnId ?? activeTurnId;
          yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
          yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs);
          if (interruptedTurnId === undefined) {
            // Pi 0.83 exposes no idle-abort extension hook. Terminating the
            // provider session is the only truthful way to stop detached
            // extension children and lets ingestion interrupt their tasks.
            yield* stopSessionInternal(ctx);
            return;
          }
          yield* ctx.rpc.send({ type: "abort" }).pipe(Effect.ignore);
          if (interruptedTurnId !== undefined) {
            ctx.interruptedTurnIds.add(interruptedTurnId);
            yield* settleTurn(ctx, interruptedTurnId, { state: "cancelled" });
          } else if (ctx.session.status === "running" || ctx.session.status === "connecting") {
            const { activeTurnId: _activeTurnId, ...readySession } = ctx.session;
            ctx.activeTurnId = undefined;
            ctx.session = {
              ...readySession,
              status: "ready",
              updatedAt: yield* nowIso,
            };
          }
        }),
      );

    const respondToRequest: PiAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "extension_ui_response",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: PiAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "extension_ui_response",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.resolution, { _tag: "answered", answers });
      });

    const readThread: PiAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: PiAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail: "Pi sessions do not support provider-side rollback yet.",
        });
      });

    const stopSession: PiAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* ctx.rpc.send({ type: "abort" }).pipe(Effect.ignore);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: PiAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: PiAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies PiAdapterShape;
  });
}
