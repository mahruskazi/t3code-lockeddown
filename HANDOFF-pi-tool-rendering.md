# Handoff: fix Pi tool-call rendering in T3 Code

**Branch:** `claude/pi-dev-t3-provider-gv5j0a`
**State:** implementation ~done but unverified (nothing has been typechecked or test-run yet); test/doc updates remain.
**Note:** `PiAdapter.ts`, `PiRpcModel.ts`, and `pnpm-lock.yaml` already had uncommitted modifications _before_ this task started — the edits below are layered on top. Don't discard the working tree.

## Problem

Pi's tool calls render badly in the web UI (raw lowercase tool names as row labels, no output preview, no changed-file chips, unreliable row collapsing). There is **no Pi-specific rendering in the clients**: the web renders tool rows generically from the `item.started/updated/completed` runtime payloads, and `PiAdapter` was emitting a `data` shape (`{args}` on start, `{output}` on end) that no client extractor reads.

## Conventions the clients actually read (verified)

Web extractors in `apps/web/src/session-logic.ts`:

- `data.toolCallId` — collapse key pairing a tool's updated/completed rows (`session-logic.ts:1093`, `:1324`)
- `data.command` / `data.item.command` / `data.input.command` — command preview (`:1285-1318`)
- `data.rawOutput.{content,stdout,totalFiles}` — output summary (`:1366-1390`)
- changed-file chips: top-level `data.path` (and path keys nested under `item/result/input/data/changes/files/edits/patch/patches/operations` — **not** `rawInput`, **not** `args`) (`:1484-1537`)
- `tool.started` activities are skipped entirely (`:758`), and ingestion drops `data` from `item.started` payloads (`ProviderRuntimeIngestion.ts:837-859`) → only updated/completed events matter for rendering, so args must be carried to the end event.

Shared presentation helper `deriveToolActivityPresentation` in `packages/shared/src/toolActivity.ts` (used by the ACP adapters, import path `@t3tools/shared/toolActivity`): classifies via `itemType` + `data.kind` (`execute/read/edit/write/move/delete/search`) and produces canonical titles ("Ran command", "Read file", "Changed files", "Searched files") + detail (command / primary path / `rawInput.query`).

Reference implementations: `AcpRuntimeModel.ts:334-353` (`makeToolCallState` data shape), `ClaudeAdapter.ts:1144` (`titleForTool`).

## Changes made so far (all `[fork:pi]`-owned files, no client changes)

### 1. `apps/server/src/provider/piRpc/PiRpcModel.ts` — DONE

In the "Tool execution" section, added:

- `commandForPiToolCall(args)` — `args.command`, trimmed
- `primaryPathForPiToolCall(args)` — first of `path/file_path/filePath/file`
- `detailForPiToolCall` refactored to use both (behavior unchanged: command truncated at 400 chars, else path)
- `kindForPiTool(toolName)` — bash→`execute`, read→`read`, edit→`edit`, write→`write`, fetch/web_search→`search`, else undefined
- `buildPiToolCallData({toolCallId, toolName, args, resultText?})` — returns `{ toolCallId, kind?, command?, path?, rawInput?, rawOutput? }` where:
  - top-level `path` is set **only when `itemTypeForPiTool(toolName) === "file_change"`** (deliberate: a `read` path must not render as a changed-file chip)
  - `rawInput` = full args (omitted when empty)
  - `rawOutput` = `{ content: resultText }` when resultText defined

### 2. `apps/server/src/provider/Layers/PiAdapter.ts` — DONE

- Import added: `deriveToolActivityPresentation` from `@t3tools/shared/toolActivity`; `buildPiToolCallData` added to the PiRpcModel import list.
- `PiSessionContext` gained `readonly toolArgsByCallId: Map<string, Record<string, unknown>>` (initialized `new Map()` in the ctx literal in `startSession`). Needed because Pi only sends `args` on `tool_execution_start`; update/end omit them (confirmed against the mock agent).
- The `tool_execution_start|update|end` branch (~line 629) rewritten: caches args on start, falls back to cache when event args empty, deletes on end; builds `data` via `buildPiToolCallData`; derives `title`/`detail` via `deriveToolActivityPresentation` (title is now e.g. "Ran command" instead of raw `bash`); emits the same full `data` on all three lifecycle events.

## Remaining work

1. **Typecheck + run existing tests** (from `apps/server`):
   - `vp run --filter t3 typecheck`
   - `vp test run src/provider/piRpc src/provider/Layers/PiAdapter.test.ts src/provider/Layers/ProviderRegistry.test.ts`
   - Existing assertions were checked and should still pass (they assert event types and `itemType`, not `title`), but verify.
2. **`PiRpcModel.test.ts`**: add coverage for `kindForPiTool` and `buildPiToolCallData` (import them). Suggested cases: bash args `{command: "ls"}` → data has `command`, `kind: "execute"`, no `path`; edit args `{path: "/tmp/a.ts"}` → `kind: "edit"`, top-level `path`; read args `{path: ...}` → **no** top-level `path`; `resultText` → `rawOutput.content`; empty args → no `rawInput`.
3. **`PiAdapter.test.ts`**: in the approval test ("surfaces T3 extension approvals…", ~line 156), the mock runs a gated bash tool (`call-1`, command `rm -rf /tmp/x`, end event has **no args** and result text `"done"`). Add assertions on the `item.completed` event with `itemType === "command_execution"`: `payload.title === "Ran command"`, `payload.data.toolCallId === "call-1"`, `payload.data.command === "rm -rf /tmp/x"` (proves the args cache carried start→end), `payload.data.rawOutput.content === "done"`.
4. **`docs/internals/fork-pi-provider.md`**: add a bullet under "How the integration works" noting tool lifecycle events follow the shared client data conventions (`toolCallId`/`kind`/`command`/`path`/`rawInput`/`rawOutput` + `deriveToolActivityPresentation` titles).
5. Optional sanity check: run the web app against a Pi thread and confirm rows show "Ran command"/"Changed files" labels, command/output previews, and file chips.

## Explicitly out of scope (decided)

- No `content.delta` `command_output` streaming (ingestion ignores those deltas anyway).
- No change to `itemTypeForPiTool` (`read` stays `dynamic_tool_call`, matching Claude's classification of Read).
- No client/contract edits — the whole fix is server-side in fork-owned files, per the fork's `[fork:pi]` design rule (`docs/internals/fork-pi-provider.md`).
