# Exploration: richer Pi provider output in T3 Code

> Fork-local ([fork:pi]). Companion to
> [fork-pi-provider.md](./fork-pi-provider.md) and
> [pi-subagents-t3-handoff.md](./pi-subagents-t3-handoff.md). This document
> maps what "rich output" can mean for the Pi provider, ranked by payoff,
> and says for each item whether the change lives in this repo, in the
> [mahruskazi/pi-config](https://github.com/mahruskazi/pi-config) extensions,
> or both.

## Framing

"Rich output" in T3 terms is not new UI — it is feeding rendering surfaces
the clients already have. The runtime event vocabulary
(`packages/contracts/src/providerRuntime.ts`) is shared by web, desktop, and
mobile, and ingestion/persistence already handle all of it. The Pi adapter
currently emits a conservative subset:

| Emits today                              | Renders as                                    |
| ---------------------------------------- | --------------------------------------------- |
| `item.*` + `content.delta`               | assistant/reasoning streaming                  |
| `item.*` for `tool_execution_*`          | tool rows via `deriveToolActivityPresentation` |
| `request.opened/resolved`                | approval cards (via the bundled extension)     |
| `user-input.requested/resolved`          | question cards (`t3-user-input:v1:` bridge)    |
| `task.*`                                 | Agents surface (`t3-subagent:v1:` bridge)      |
| `thread.token-usage.updated`             | context meter                                  |

Surfaces that exist downstream but that Pi never feeds:

- **Plan chips + working indicator** — `turn.plan.updated` drives an inline
  per-turn plan chip (`deriveTurnPlans` in `apps/web/src/session-logic.ts`)
  and the sidebar "step 2/5" working line (`ThreadPlanProgress.ts`).
- **Agents surface** — the T3 side of the subagent bridge shipped (PR #5),
  but pi-config's subagents extension never gained the publisher, so no
  `t3-subagent:v1:` notifications are ever emitted. The whole pipeline is
  dark.
- **Work-log rows** — extension `notify` messages (typecheck failures,
  background-job completion, MCP status) are silently dropped by
  `handleForeignUiRequest`.
- **`web_search` item chrome** — pi-config's `search`/`scrape` tools render
  as generic `dynamic_tool_call` hammers.

## Proposals, ranked

### P1. Map `todo_write` to `turn.plan.updated` — t3code only, small

pi-config's `todos.ts` gives the model a Claude-style `todo_write` tool, and
its full checklist arrives in `tool_execution_start.args.todos`. Today it
renders as an opaque dynamic tool row; the checklist itself is invisible.

ClaudeAdapter sets the precedent (`ClaudeAdapter.ts` ~2571): keep the tool
row **and** additionally emit `turn.plan.updated` from the parsed todos.
Doing the same in `PiAdapter.handlePumpEvent`'s tool branch gets, with ~40
lines in this repo and zero pi-config changes:

- live plan chip in the timeline (web + mobile),
- "step N/M" working indicator on the sidebar row,
- plan persistence across follow-up turns.

Mapping: `pending → pending`, `in_progress → inProgress`,
`completed → completed`; an empty list clears the chip (ingestion already
handles that). Match the tool by exact name `todo_write`; emit on
`tool_execution_start` (args are only present there). Pure mapping helper +
tests belong in `PiRpcModel.ts`.

### P2. Ship the pi-config side of the subagent bridge — pi-config, medium

Everything in [pi-subagents-t3-handoff.md](./pi-subagents-t3-handoff.md) on
the T3 side is implemented and tested (`parseT3PiSubagentEvent`,
`handleT3PiSubagentEvent`, `T3_PI_SUBAGENT_BRIDGE=v1` env). The extension
side was never built: pi-config's `subagents/src/manager.ts` has the read
model (`SubagentSnapshot` carries id, backend, title, cwd, status, usage,
errorText — everything the payload schema needs) but no publisher.

The work, per the handoff doc:

1. A lifecycle publisher gated on `process.env.T3_PI_SUBAGENT_BRIDGE === "v1"`
   that subscribes to the manager read model and emits
   `ctx.ui.notify("t3-subagent:v1:" + JSON.stringify(event), "info")` —
   one `started`, throttled `progress` (≥1s apart, already enforced again on
   the T3 side), one terminal `completed`.
2. Result delivery via `deliverAs: "nextTurn"` instead of a triggered turn
   when the bridge env is present (the hidden-turn fix — required).
3. Runtime-mode enforcement from `T3_PI_RUNTIME_MODE` (reject spawns in
   approval-required mode for v1).

This is the single biggest payoff: subagents are the flagship pi-config
extension and currently show up as nothing but a `subagent_spawn` tool row.

### P3. Surface extension notifications in the work log — t3code, small

Pi extensions communicate a lot through `ctx.ui.notify(message, severity)`:
`typecheck.ts` reports diagnostics after edits, `background-shell` reports
job exits, `notion-mcp`/`web-search` report connection problems. In RPC mode
these arrive as fire-and-forget `extension_ui_request` events and the
adapter drops them.

Map non-marker `notify` events (severity `warning`/`error` at minimum;
`info` is debatable noise) onto the existing `runtime.warning` event, which
ingestion already renders as a labeled work-log row. Bounds: truncate to the
same 120/detail limits ingestion applies, skip anything with a `t3-` marker
prefix, and rate-limit per session so a buggy extension cannot flood
persisted activity. No contract change, no client change.

### P4. Background-shell jobs as tasks — both repos, medium, after P2

`background-shell.ts` owns long-running processes whose lifecycle outlives
the turn — exactly what the `task.*` pipeline models (background liveness
banner, stop affordance). Once P2's publisher pattern exists in pi-config,
reuse it: either generalize the marker to a `t3-task:v1:` envelope with a
`taskType` field, or add a sibling `t3-bgjob:v1:` marker with the same
started/progress/completed shape. The T3 mapping is a near-copy of
`handleT3PiSubagentEvent` with `taskType: "background_job"`.

Decide deliberately whether T3's stop-everything should SIGTERM background
jobs; the subagent bridge's stop semantics discussion applies unchanged.

### P5. Tool presentation polish — t3code, small

- `itemTypeForPiTool`/`kindForPiTool`: map pi-config's `search` and `scrape`
  to `web_search`/`search` so they get the globe chrome instead of the
  generic hammer. Same for `file-search`'s tools if their names are stable.
- Pi tool results carry a structured `details` field alongside `content`
  (todos.ts returns `details.todos`; the built-in `edit` returns
  `EditToolDetails` with the computed diff). **Verify** whether
  `tool_execution_end` includes `details` over RPC; if it does, pass a
  bounded copy through `data` so file-change rows can show the actual diff
  in their expanded body instead of (or alongside) `rawOutput.content`
  prose. This also makes P1 more robust (read todos from the result details
  rather than args). Note `edit-diff-feedback.ts` already appends a unified
  diff to the result *text*, so edits get some of this for free today via
  the `rawOutput.content` preview.

### P6. Not worth it (for now)

- **Streaming command output as `content.delta`** — `tool_execution_update`
  already re-emits bounded `rawOutput.content` (4000-char cap) on
  `item.updated`; per-delta streaming adds websocket volume for marginal UX.
  Revisit only if long bash runs feel dead in the UI.
- **`tokens-per-second`, `powerline-status`, `thinking-status`, widgets** —
  TUI footer/widget concerns. T3 has its own equivalents; `setStatus`/
  `setWidget` events should stay ignored.
- **`/subagents` takeover view** — the Agents surface is the RPC
  replacement; do not serialize terminal UI (handoff doc agrees).

## Adjacent (input-side, listed for completeness)

Not "output", but repeatedly adjacent while reading this code:

- `set_thinking_level` is unexposed (fork doc limitation #4); pi-config sets
  `defaultThinkingLevel: "high"` globally as a workaround.
- Provider-side rollback via Pi's `fork`/`get_entries` (limitation #1).

## Suggested order

1. **P1** — self-contained in this repo, immediately visible, no protocol.
2. **P3** — small, makes extension failures diagnosable from T3.
3. **P2** — the big one; follow the handoff doc, land pi-config publisher +
   any T3 stop-semantics follow-up together.
4. **P4/P5** — after P2 establishes the publisher pattern.

Each lands as its own PR. Verification per repo rules: `PiRpcModel.test.ts`
for pure parsing/mapping, `PiAdapter.test.ts` against the mock RPC agent
(receipts, no sleeps), and one approved integrated pass in a real client at
the end.
