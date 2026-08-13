/**
 * PiRpcProcess — long-lived `pi --mode rpc` child process transport.
 *
 * One process per Pi session (and per one-shot text-generation run). Owns:
 *   - spawning through `resolveSpawnCommand` (login-shell PATH semantics),
 *   - the JSONL stdout pump (LF-only splitting per Pi's framing rules —
 *     `Stream.splitLines` splits on `\n`/`\r\n` and never on Unicode
 *     separators, unlike Node's `readline`),
 *   - request/response correlation via monotonic `id`s,
 *   - a single-consumer event queue (the adapter's notification pump),
 *   - in-band process-exit signalling (`PI_PROCESS_EXITED_EVENT`).
 *
 * The process is killed when the enclosing scope closes.
 *
 * [fork:pi] This module is fork-local. See docs/internals/fork-pi-provider.md.
 *
 * @module provider/piRpc/PiRpcProcess
 */
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  classifyPiRpcLine,
  PI_PROCESS_EXITED_EVENT,
  PiRpcRequestError,
  PiRpcSpawnError,
  PiRpcTransportError,
  type PiRpcCommand,
  type PiRpcEvent,
  type PiRpcResponse,
} from "./PiRpcModel.ts";

const STDERR_TAIL_LIMIT = 8_192;
const DEFAULT_REQUEST_TIMEOUT = Duration.seconds(30);

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
const decodeUnknownJsonStringExit = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

export interface PiRpcProcessOptions {
  /** Binary path or bare command name; defaults to `pi`. */
  readonly binaryPath: string | undefined;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface PiRpcProcess {
  /** Fire-and-forget command (no `id`, no response wait). */
  readonly send: (command: PiRpcCommand) => Effect.Effect<void, PiRpcTransportError>;
  /**
   * Correlated request. Fails with `PiRpcRequestError` when Pi answers
   * `success: false`, when the process exits first, or on timeout.
   */
  readonly request: (
    command: PiRpcCommand,
    options?: { readonly timeout?: Duration.Input },
  ) => Effect.Effect<PiRpcResponse, PiRpcTransportError | PiRpcRequestError>;
  /**
   * Single-consumer stream of non-response events, terminated by a
   * synthetic `PI_PROCESS_EXITED_EVENT` entry when the process dies.
   */
  readonly events: Stream.Stream<PiRpcEvent>;
  /** Resolves with the exit code once the process has exited. */
  readonly awaitExit: Effect.Effect<number>;
  /** Last collected stderr output (bounded), for diagnostics. */
  readonly stderrTail: Effect.Effect<string>;
}

export const makePiRpcProcess = Effect.fn("makePiRpcProcess")(function* (
  options: PiRpcProcessOptions,
): Effect.fn.Return<
  PiRpcProcess,
  PiRpcSpawnError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = options.binaryPath?.trim() || "pi";

  const resolved = yield* resolveSpawnCommand(command, options.args, {
    env: options.env,
  });

  const handle = yield* Effect.acquireRelease(
    spawner
      .spawn(
        ChildProcess.make(resolved.command, resolved.args, {
          cwd: options.cwd,
          env: options.env,
          shell: resolved.shell,
          stdin: { stream: "pipe", endOnDone: false },
          stdout: "pipe",
          stderr: "pipe",
          killSignal: "SIGTERM",
          forceKillAfter: Duration.seconds(2),
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new PiRpcSpawnError({
              command,
              detail: cause.message ?? "Failed to spawn Pi process.",
              cause,
            }),
        ),
      ),
    (child) => child.kill().pipe(Effect.ignore),
  );

  const pendingRef = yield* Ref.make(
    new Map<string, Deferred.Deferred<PiRpcResponse, PiRpcTransportError>>(),
  );
  const eventQueue = yield* Queue.unbounded<PiRpcEvent>();
  const exitDeferred = yield* Deferred.make<number>();
  const exitedRef = yield* Ref.make(false);
  const stderrRef = yield* Ref.make("");
  const seqRef = yield* Ref.make(0);
  const writeMutex = yield* Semaphore.make(1);

  const send = (commandRecord: PiRpcCommand): Effect.Effect<void, PiRpcTransportError> =>
    Effect.gen(function* () {
      if (yield* Ref.get(exitedRef)) {
        return yield* new PiRpcTransportError({ detail: "Pi process has exited." });
      }
      const encoded = encodeUnknownJsonStringExit(commandRecord);
      if (!Exit.isSuccess(encoded)) {
        return yield* new PiRpcTransportError({
          detail: `Failed to encode '${commandRecord.type}' command as JSON.`,
        });
      }
      const line = `${encoded.value}\n`;
      yield* writeMutex
        .withPermits(1)(Stream.run(Stream.encodeText(Stream.make(line)), handle.stdin))
        .pipe(
          Effect.mapError(
            (cause) =>
              new PiRpcTransportError({
                detail: `Failed to write '${commandRecord.type}' to Pi stdin.`,
                cause,
              }),
          ),
        );
    });

  const failAllPending = (error: PiRpcTransportError) =>
    Ref.getAndSet(pendingRef, new Map()).pipe(
      Effect.flatMap((pending) =>
        Effect.forEach(pending.values(), (deferred) => Deferred.fail(deferred, error), {
          discard: true,
        }),
      ),
    );

  const settleExit = (code: number) =>
    Effect.gen(function* () {
      const alreadyExited = yield* Ref.getAndSet(exitedRef, true);
      if (alreadyExited) {
        return;
      }
      yield* Deferred.succeed(exitDeferred, code);
      yield* failAllPending(
        new PiRpcTransportError({ detail: `Pi process exited with code ${code}.` }),
      );
      yield* Queue.offer(eventQueue, { type: PI_PROCESS_EXITED_EVENT, code }).pipe(Effect.ignore);
    });

  // stdout pump: split LF-only lines, classify, resolve pending or enqueue.
  yield* handle.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) =>
      Effect.gen(function* () {
        const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (trimmed.trim().length === 0) {
          return;
        }
        const decoded = decodeUnknownJsonStringExit(trimmed);
        if (!Exit.isSuccess(decoded)) {
          // Non-JSON output on stdout (extension logs, stray prints) —
          // tolerated per protocol robustness rules.
          return;
        }
        const classified = classifyPiRpcLine(decoded.value);
        switch (classified._tag) {
          case "Response": {
            const id = classified.response.id;
            if (id === undefined) {
              return;
            }
            const deferred = yield* Ref.modify(pendingRef, (pending) => {
              const found = pending.get(id);
              if (!found) {
                return [undefined, pending] as const;
              }
              const next = new Map(pending);
              next.delete(id);
              return [found, next] as const;
            });
            if (deferred) {
              yield* Deferred.succeed(deferred, classified.response);
            }
            return;
          }
          case "Event":
            yield* Queue.offer(eventQueue, classified.event).pipe(Effect.ignore);
            return;
          case "Ignored":
            return;
        }
      }),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );

  // stderr tail collector (diagnostics only).
  yield* handle.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Ref.update(stderrRef, (current) => {
        const combined = current + chunk;
        return combined.length > STDERR_TAIL_LIMIT
          ? combined.slice(combined.length - STDERR_TAIL_LIMIT)
          : combined;
      }),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );

  // Exit watcher.
  yield* handle.exitCode.pipe(
    Effect.map(Number),
    Effect.orElseSucceed(() => -1),
    Effect.flatMap(settleExit),
    Effect.forkScoped,
  );

  const request: PiRpcProcess["request"] = (commandRecord, requestOptions) =>
    Effect.gen(function* () {
      if (yield* Ref.get(exitedRef)) {
        return yield* new PiRpcRequestError({
          command: commandRecord.type,
          detail: "Pi process has exited.",
        });
      }
      const seq = yield* Ref.modify(seqRef, (current) => [current + 1, current + 1] as const);
      const id = `t3-${seq}`;
      const deferred = yield* Deferred.make<PiRpcResponse, PiRpcTransportError>();
      yield* Ref.update(pendingRef, (pending) => {
        const next = new Map(pending);
        next.set(id, deferred);
        return next;
      });
      const cleanup = Ref.update(pendingRef, (pending) => {
        if (!pending.has(id)) {
          return pending;
        }
        const next = new Map(pending);
        next.delete(id);
        return next;
      });

      yield* send({ ...commandRecord, id }).pipe(Effect.tapError(() => cleanup));

      const response = yield* Deferred.await(deferred).pipe(
        Effect.timeoutOption(requestOptions?.timeout ?? DEFAULT_REQUEST_TIMEOUT),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              cleanup.pipe(
                Effect.andThen(
                  Effect.fail(
                    new PiRpcRequestError({
                      command: commandRecord.type,
                      detail: "Timed out waiting for Pi response.",
                    }),
                  ),
                ),
              ),
            onSome: (value: PiRpcResponse) => Effect.succeed(value),
          }),
        ),
      );

      if (!response.success) {
        return yield* new PiRpcRequestError({
          command: commandRecord.type,
          detail: response.error ?? "Pi reported a command failure.",
        });
      }
      return response;
    });

  return {
    send,
    request,
    events: Stream.fromQueue(eventQueue),
    awaitExit: Deferred.await(exitDeferred),
    stderrTail: Ref.get(stderrRef),
  } satisfies PiRpcProcess;
});
