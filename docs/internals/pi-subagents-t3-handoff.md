# Handoff: first-class Pi subagents in T3 Code

## Objective

Make Pi's extension-managed subagents work as first-class T3 Code agents across web, desktop, and
mobile, including remote connections. A Pi parent should be able to spawn Pi or Codex children while
T3 shows their lifecycle in the Agents surface, preserves visible turn ownership, stops them through
T3's existing stop affordance, and does not silently bypass the thread's permission mode.

This is a separate concern from the structured-question bridge in PR #4 and should ship in its own
branch and PR.

## Executive summary

The installed Pi subagents extension works mechanically under `pi --mode rpc`, but T3 currently sees
only ordinary `subagent_spawn`, `subagent_wait`, and related tool calls. The extension owns the real
child lifecycle, while T3's Pi adapter has no visibility into it.

That gap causes four important problems:

1. T3 receives no `task.started`, `task.progress`, or `task.completed` events, so the Agents surface,
   background-liveness banner, token totals, and stop semantics do not know the children exist.
2. A background result calls `pi.sendMessage(..., { triggerTurn: true })`. If the parent is idle, Pi
   can begin a provider turn that T3 did not start. `PiAdapter` drops ordinary events when it has no
   active T3 turn, so this work can be invisible while still affecting the workspace.
3. The Codex backend starts children with `approvalPolicy: "never"` and
   `sandbox: "danger-full-access"`, regardless of the T3 thread's runtime mode. Pi children likewise
   do not inherit T3's CLI-loaded approval extension.
4. `/subagents` and takeover are terminal-only custom UI and are intentionally unavailable in RPC
   mode.

The recommended fix is a cooperative, versioned lifecycle protocol between the Pi subagents
extension and `PiAdapter`. Do not infer lifecycle from human-readable tool output, and do not move the
whole subagents implementation into T3's managed approvals extension.

## Current architecture

### Pi extension

The currently installed extension lives outside this repository under
`~/.pi/agent/extensions/subagents/`.

- `index.ts` registers `subagent_spawn`, `subagent_wait`, `subagent_check`, `subagent_list`, and
  `subagent_cancel`.
- `src/manager.ts` is the lifecycle owner. It folds backend events into `SubagentSnapshot` values and
  knows when a child starts, changes activity, settles, or is cancelled.
- `src/backends/pi.ts` runs an in-process headless Pi `AgentSession`.
- `src/backends/codex.ts` runs a scoped `codex app-server` child process.
- Normal children cannot spawn more children or ask the user.
- The extension's current harness list is only `pi` and `codex`; its former Claude backend was
  removed.

The extension is the correct owner of child implementation and lifecycle publication. The installed
copy in `~/.pi` should not be the sole source of truth; make the corresponding changes in the
extension's source repository/package and install them from there.

### T3 Pi provider

[`PiAdapter.ts`](../../apps/server/src/provider/Layers/PiAdapter.ts) currently translates Pi RPC
assistant deltas and tool execution events. All subagent tools therefore appear as generic dynamic
tool calls. The adapter returns early for ordinary events when `activeTurnId` is absent, which is
correct for unknown provider work but incompatible with extension-triggered autonomous turns.

[`PiRpcModel.ts`](../../apps/server/src/provider/piRpc/PiRpcModel.ts) already owns tolerant parsing of
Pi RPC extension UI messages and versioned T3 markers. The structured-question bridge is the closest
existing pattern.

### T3 native task lifecycle

[`providerRuntime.ts`](../../packages/contracts/src/providerRuntime.ts) defines the existing shared
events:

- `task.started`
- `task.progress`
- `task.updated`
- `task.completed`
- `tool.progress`

[`ProviderRuntimeIngestion.ts`](../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts)
persists those events, maintains background liveness, and feeds the client runtime. Web, desktop, and
mobile already share that downstream model. A correct Pi adapter mapping should not require a new
client contract.

Use the task-linkage fields already established by Claude and Codex: `taskId`, `taskType`, `title`,
`role`, `model`, `effort`, `toolUseId`, `runHandles`, and optional `timelineBypass`.

## Target behavior

1. `subagent_spawn` remains a normal Pi tool call in the parent timeline.
2. Each successfully created child emits one native `task.started` event and appears in T3's Agents
   surface.
3. Meaningful child status, active tool, model, effort, and bounded usage updates emit
   `task.progress`; token deltas must not be forwarded continuously.
4. Settlement emits exactly one `task.completed` event with `completed`, `failed`, or `stopped`.
5. Lifecycle events continue to be ingested after the launching parent turn ends.
6. Background completion never starts an invisible Pi turn. The result is visible in the Agents
   surface immediately and enters parent model context on the next T3-owned turn, unless the parent
   explicitly waits during its current turn.
7. T3's stop-everything action settles every live Pi extension child before background liveness
   clears.
8. Child permissions never exceed the T3 thread's declared runtime mode.

## Recommended protocol

### Transport

Use Pi's fire-and-forget extension UI `notify` message because it is already carried over RPC and
requires no response:

```text
t3-subagent:v1:{JSON payload}
```

The subagents extension should emit these notifications only when T3 explicitly advertises support,
for example through an environment variable set by `PiAdapter`:

```text
T3_PI_SUBAGENT_BRIDGE=v1
T3_PI_RUNTIME_MODE=full-access|approval-required
```

Do not emit marker notifications for terminal Pi or unrelated RPC clients. Do not reuse
`setStatus`; the extension can continue using its existing human-readable status entry separately.

### Payload

Keep the extension-owned envelope small and versioned. One suggested shape is:

```ts
type T3PiSubagentEvent =
  | {
      kind: "started";
      bridgeRunId: string;
      childId: string;
      title: string;
      harness: "pi" | "codex";
      cwd: string;
      model?: string;
      effort?: string;
      transcriptPath?: string;
    }
  | {
      kind: "progress";
      bridgeRunId: string;
      childId: string;
      status: "running" | "waiting";
      lastToolName?: string;
      summary?: string;
      usedTokens?: number;
      contextWindow?: number;
    }
  | {
      kind: "completed";
      bridgeRunId: string;
      childId: string;
      status: "completed" | "failed" | "stopped";
      summary?: string;
      error?: string;
      usedTokens?: number;
    };
```

`bridgeRunId` must be unique per parent Pi process. The extension's local ids restart at `sa-1`, so
using `childId` alone would collide with persisted tasks after a provider-session restart. T3 should
derive `RuntimeTaskId` from both values, for example `pi:<bridgeRunId>:<childId>`.

All strings need explicit bounds before crossing RPC. Keep summaries suitable for a one-line Agents
preview and never place full transcripts in lifecycle messages.

### Event mapping

| Extension marker      | Provider runtime event | Important fields                                                                     |
| --------------------- | ---------------------- | ------------------------------------------------------------------------------------ |
| `started`             | `task.started`         | `taskType: "local_agent"`, title, role/harness, model, effort, transcript run handle |
| `progress`            | `task.progress`        | `status`, summary, `lastToolName`, bounded typed usage                               |
| `completed/completed` | `task.completed`       | `status: "completed"`, summary and usage                                             |
| `completed/failed`    | `task.completed`       | `status: "failed"`, bounded error summary                                            |
| `completed/stopped`   | `task.completed`       | `status: "stopped"`                                                                  |

When the adapter receives `started` during an active parent turn, remember that turn id in a
session-local `RuntimeTaskId -> TurnId | undefined` map. Reuse the launching turn id for later
progress and completion events so direct spawns group consistently even after the parent settles.
The lifecycle parser must run before the adapter's `activeTurnId` guard.

## Pi extension changes

Make these changes in the subagents extension source, not only in the installed `~/.pi` copy.

1. Add a lifecycle publisher next to the manager view subscription. It should fingerprint the last
   published state per child and emit:
   - one start marker after the snapshot is registered;
   - progress only on meaningful state/tool/usage changes;
   - one terminal marker from settlement.
2. Throttle progress to at most one update per child per second. Never publish assistant token
   deltas. Tool start/end and message-end usage are sufficient.
3. Preserve cancellation as a distinct domain outcome. The current manager maps `Interrupted` to
   `status: "error"`; add enough state to publish `stopped` when cancellation was requested.
4. In T3 RPC mode, change automatic result delivery from an autonomous follow-up turn to the next
   T3-owned turn:

   ```ts
   pi.sendMessage(message, { deliverAs: "nextTurn", triggerTurn: false });
   ```

   Explicit `subagent_wait` should keep returning results in the current visible tool call.

5. Keep `/subagents` and takeover TUI-only. T3's Agents surface is the RPC replacement; do not try to
   serialize custom terminal UI.
6. On session shutdown, retain the existing bounded cleanup and emit terminal markers before the
   RPC transport disappears when possible.

## T3 provider changes

### Protocol model

In [`PiRpcModel.ts`](../../apps/server/src/provider/piRpc/PiRpcModel.ts):

1. Add the `t3-subagent:v1:` prefix and schemas/parsers for the three payload variants.
2. Parse only `extension_ui_request` messages with `method: "notify"` and the exact versioned prefix.
3. Reject malformed payloads atomically. Do not partially accept children or silently invent
   required identity.
4. Add maximum lengths/counts and parser tests for malformed JSON, unknown versions, duplicate
   terminal delivery, missing identity, and oversized summaries.

### Adapter

In [`PiAdapter.ts`](../../apps/server/src/provider/Layers/PiAdapter.ts):

1. Add session-local task identity and last-state maps.
2. Handle structured lifecycle notifications before the active-turn guard.
3. Emit native task events using `RuntimeTaskId` and the existing linkage fields.
4. Deduplicate starts and terminal events. Ignore progress after terminal settlement.
5. Map progress usage into `RuntimeTaskUsage` only when the extension provides defensible values.
6. Bound websocket volume. A noisy or buggy extension must not produce unbounded persisted activity.
7. Clear task state on session exit; ingestion already derives interrupted state when the provider
   session dies without terminal rows.

Do not parse `subagent_spawn` result prose or depend on labels such as `sa-1`. Human-facing strings
are not a transport contract, automatic completion is not represented by the spawn tool result, and
future extension versions may change their renderers.

## Hidden-turn fix

This is required, not optional. The current extension uses a triggered follow-up to deliver a result
to the parent. T3 owns turn ids and checkpoints, so a provider-triggered turn after the parent settles
has no valid T3 turn, can be dropped by `PiAdapter`, and can mutate the workspace without a matching
checkpoint.

For T3-hosted RPC sessions:

- lifecycle completion goes directly to T3 through the marker protocol;
- the full result is queued with `deliverAs: "nextTurn"`;
- the next user-initiated T3 turn incorporates that result into Pi context;
- `subagent_wait` remains the same-turn path when the parent cannot proceed without the answer.

Do not synthesize a fake T3 turn in the adapter. Checkpoints, interruption, user intent, and durable
turn ordering belong to orchestration, not to a provider extension callback.

## Stop and cancellation

T3's background-liveness banner sends the normal thread interrupt command even when the parent turn
has ended. The desired Pi behavior is "stop every live extension child, then report terminal state."

Before implementation, verify whether Pi extension hooks receive an abort/agent-end signal when the
RPC `abort` command is sent while the parent is idle:

1. If the extension receives a reliable aborted lifecycle hook, gate on `T3_PI_SUBAGENT_BRIDGE` and
   call `manager.cancel()` for every running child.
2. If idle abort is not observable, do not fake success. A small upstream Pi RPC capability is
   preferable to polling files or keeping a dummy dialog open. Until that exists, T3 must either stop
   the provider session to guarantee cleanup or present explicit "session restart required" behavior.

Test the chosen path using receipts/worker drains. Do not use sleeps or polling in T3 tests.

Individual child cancellation can remain model-driven through `subagent_cancel` for the first
version unless T3 adds a user-facing per-agent cancel command. The global stop affordance must still
be truthful.

## Permission model

Do not ship native task rendering while leaving the current permission bypass implicit. The Agents
surface would make children look T3-managed even though they exceed the parent thread's authority.

Recommended minimal policy:

| T3 runtime mode     | Child policy                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `full-access`       | Preserve current autonomous Pi/Codex behavior.                                                                |
| `approval-required` | Reject subagent spawning with a clear tool error until nested approval or a reliable read-only policy exists. |

Possible later refinement: permit Codex children with a true read-only sandbox. Do not describe Pi
children as read-only unless the Pi backend can enforce that boundary independently of prompt text.
Forwarding nested child approvals into T3 is a larger design and should not be smuggled into this
bridge.

`PiAdapter` should pass the parent runtime mode in an explicit environment variable. The extension
must treat a missing/unknown value conservatively when the T3 bridge flag is present.

## Tests

### T3 repository

Add focused tests only:

- `PiRpcModel.test.ts`
  - valid start/progress/completion markers;
  - malformed and unknown-version messages;
  - identity and bounds validation.
- `PiAdapter.test.ts` and `pi-mock-rpc-agent.ts`
  - child starts during a parent turn;
  - progress and completion arrive after `turn.completed` and are still emitted;
  - duplicate terminal events are ignored;
  - a new provider session cannot collide with an old `sa-1`;
  - session exit clears live task state;
  - stop behavior matches the selected idle-abort design.
- `ProviderRuntimeIngestion.test.ts`
  - Pi-shaped task events feed background liveness and persist the expected linkage.
- `packages/client-runtime` subagent fold tests
  - Pi roles/models/statuses render without provider-specific assumptions.

Run targeted server typecheck, lint, formatting, and only the touched test files. Do not run the
repository-wide suite.

### Pi extension repository

Add tests for:

- lifecycle marker deduplication and throttling;
- completion versus cancellation status;
- `nextTurn` result delivery in T3 RPC mode;
- unchanged triggered delivery in ordinary TUI mode;
- runtime-mode enforcement for both Pi and Codex harnesses;
- shutdown cleanup and terminal publication.

### Integrated verification

After unit/integration tests, request permission before using a browser or client. Then verify once in
a real T3 client:

1. Spawn one Pi and one Codex child.
2. Let the parent turn end while both continue.
3. Confirm both remain visible and update in the Agents surface.
4. Confirm completion does not create a hidden assistant turn.
5. Send a new user message and confirm queued results reach parent context.
6. Spawn again and press the background Stop action after the parent turn ends.
7. Verify local and remote clients converge on the same terminal state.

## Acceptance criteria

- Pi extension children appear in the existing Agents surface on web, desktop, and mobile.
- Direct spawns group under their launching T3 turn and remain visible after that turn settles.
- Completion after the parent turn is persisted and rendered without starting an autonomous hidden
  turn.
- Every live child reaches one terminal state on completion, failure, cancellation, provider exit,
  or T3 stop.
- Background liveness clears only after real child settlement.
- No child exceeds the thread's declared runtime mode.
- The protocol works over local, relay, and tunnel connections without client-origin assumptions.
- Progress traffic is bounded and does not forward token deltas.
- Existing Pi TUI subagent behavior remains unchanged when the T3 bridge is absent.

## Open decisions

Resolve these explicitly before implementation:

1. Where is the canonical source repository/package for the installed Pi subagents extension?
2. Does Pi expose a reliable extension hook for RPC abort while idle, or is an upstream RPC addition
   required for truthful stop-everything behavior?
3. Should the first release reject all approval-required spawns, or support a verified read-only
   Codex subset?
4. Which bounded subset of child output belongs in `task.completed.summary` versus only in the next
   parent turn and transcript file?
5. Does the Agents surface need a future explicit per-child cancel action, or is model-driven cancel
   plus global stop sufficient for v1?

## Suggested implementation order

1. Confirm the extension source/distribution location and idle-abort behavior.
2. Add extension-side bridge identity, lifecycle publication, and `nextTurn` delivery.
3. Add pure T3 protocol parsing and tests.
4. Map lifecycle into native task events before the active-turn guard.
5. Add permission-mode enforcement.
6. Add truthful global stop behavior.
7. Verify ingestion/client folding with targeted tests.
8. Perform one approved integrated client pass and document the final behavior.
