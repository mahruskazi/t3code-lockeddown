# Fork: Pi provider

> Fork-local. This driver integrates the [Pi coding agent](https://pi.dev)
> (`pi --mode rpc`) as a T3 Code provider. It is not upstream; this document
> exists so pulling upstream stays cheap.

## Design rule

All substantial logic lives in **new files** (never conflict on upstream
merges). Every edit to a shared upstream file is a minimal, append-only block
tagged with a `// [fork:pi]` marker comment. When an upstream merge conflicts,
the resolution is mechanical: keep upstream's version of the surrounding code
and re-apply the small `[fork:pi]` block.

```
git grep -n "fork:pi"   # every fork touch point, at any time
```

## New files (no merge risk)

| File                                                  | Role                                                                                                                                                                                     |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/provider/piRpc/PiRpcModel.ts`        | Pure protocol model: JSONL line classification, model slugs, session state, resume cursor, deltas, usage, tool events, agent settlement, extension-UI + `t3-approval:v1:` marker parsing |
| `apps/server/src/provider/piRpc/PiRpcProcess.ts`      | `pi --mode rpc` child-process transport: spawn, LF-only JSONL pump, request/response correlation, single-consumer event queue, in-band exit signalling                                   |
| `apps/server/src/provider/piRpc/PiExtensionSource.ts` | Embedded T3 approval-gating Pi extension + materializer (written under `<stateDir>/pi/`, loaded via `pi -e`)                                                                             |
| `apps/server/src/provider/Layers/PiAdapter.ts`        | Provider adapter: sessions, turns/steering, interrupts, approvals, user-input bridging, token usage, runtime events                                                                      |
| `apps/server/src/provider/Layers/PiProvider.ts`       | Status probe (`pi --version`), dynamic model catalog (`get_available_models`), snapshot enrichment                                                                                       |
| `apps/server/src/provider/Drivers/PiDriver.ts`        | Driver bundle (adapter + snapshot + text generation + extension materialization)                                                                                                         |
| `apps/server/src/provider/Services/PiAdapter.ts`      | Adapter shape interface                                                                                                                                                                  |
| `apps/server/src/textGeneration/PiTextGeneration.ts`  | Commit/PR/branch/title generation via one-shot `--no-session` runs                                                                                                                       |
| `apps/server/scripts/pi-mock-rpc-agent.ts`            | Mock `pi --mode rpc` for tests                                                                                                                                                           |
| `apps/server/src/provider/piRpc/PiRpcModel.test.ts`   | Protocol model unit tests                                                                                                                                                                |
| `apps/server/src/provider/Layers/PiAdapter.test.ts`   | Adapter integration tests against the mock agent                                                                                                                                         |
| `apps/web/src/components/PiIcon.tsx`                  | π provider icon (kept out of `Icons.tsx` deliberately)                                                                                                                                   |
| `docs/internals/fork-pi-provider.md`                  | This document                                                                                                                                                                            |

## Upstream files touched (all marked `[fork:pi]`)

| File                                                         | Edit                                                                                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/settings.ts`                         | `PiSettings` schema block; `providers.pi` struct entry; `PiSettingsPatch` + patch entry                                         |
| `packages/contracts/src/model.ts`                            | `PI_DRIVER_KIND`; entries in `DEFAULT_MODEL_BY_PROVIDER`, `DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER`, `PROVIDER_DISPLAY_NAMES` |
| `packages/contracts/src/providerRuntime.ts`                  | `pi.rpc` / `pi.rpc.extension` raw-source literals                                                                               |
| `apps/server/src/provider/builtInDrivers.ts`                 | Driver import, env union member, `BUILT_IN_DRIVERS` entry                                                                       |
| `apps/server/src/provider/Layers/ProviderRegistry.test.ts`   | Two provider-enumeration expectations (`pi` disabled in one fixture; `pi` in the sorted instance list)                          |
| `apps/web/src/session-logic.ts`                              | `PROVIDER_OPTIONS` entry                                                                                                        |
| `apps/web/src/components/settings/providerDriverMeta.ts`     | Client definition entry + imports                                                                                               |
| `apps/web/src/components/chat/providerIconUtils.ts`          | Icon map entry + import                                                                                                         |
| `apps/web/src/components/settings/ProviderModelsSection.tsx` | Custom-model placeholder entry                                                                                                  |
| `apps/mobile/src/components/ProviderIcon.tsx`                | π icon branch                                                                                                                   |
| `docs/internals/providers.md`                                | Driver table row + fork note                                                                                                    |

Deliberately **not** touched (fallbacks handle the unknown driver kind):
`contextWindow.ts` (title-cases unknown kinds → "Pi"),
`MODEL_SLUG_ALIASES_BY_PROVIDER` (missing entry → `{}`),
`composerDraftStore.ts` provider literal lists (grok is skipped there too),
`TextGeneration.ts` `TextGenerationProvider` union (unused structurally),
`DiagnosticsSettings.tsx` process classifier.

## Updating this fork from upstream

1. `git merge upstream/main` (or rebase — the fork commits are additive).
2. Conflicts, if any, land on the `[fork:pi]` blocks above. Take upstream's
   hunk, re-add the marked block at the equivalent append position.
3. If upstream renamed a helper the new files import
   (`providerSnapshot.ts`, `providerMaintenance.ts`, `makeManagedServerProvider.ts`,
   `TextGenerationPrompts.ts`), the compiler will point at the Pi files;
   follow whatever the Grok driver now does — PiDriver/PiProvider/PiTextGeneration
   are deliberately shaped 1:1 after their Grok counterparts.
4. Re-run: `vp run --filter t3 typecheck` and
   `vp test run src/provider/piRpc src/provider/Layers/PiAdapter.test.ts src/provider/Layers/ProviderRegistry.test.ts`
   (from `apps/server`).

## How the integration works

- **Transport.** One `pi --mode rpc` process per thread session, JSONL over
  stdio (LF-only framing per Pi's spec). Commands carry monotonic `t3-N` ids;
  responses resolve pending deferreds; everything else feeds a single-consumer
  event queue.
- **Turns.** `sendTurn` writes `prompt` and blocks until the pump observes a
  settling `agent_end` (retries with `willRetry: true` don't settle). A
  `sendTurn` during a running turn is a steer (`streamingBehavior: "steer"`)
  folded into the active turn. `interruptTurn` sends `abort` and settles
  `cancelled` immediately.
- **Approvals.** Pi runs tools without asking, so the bundled extension
  (`PiExtensionSource.ts`) gates `bash`/`write`/`edit` behind a `select`
  dialog whose title carries `t3-approval:v1:<json>`. In RPC mode that
  surfaces as `extension_ui_request`; the adapter maps it to T3's
  `request.opened`/`request.resolved` and answers with
  `extension_ui_response` (`Allow` / `Always allow` / `Deny` / cancelled).
  Full-access threads set `T3_PI_APPROVAL_MODE=off` and skip gating.
  Foreign extension `select`/`confirm` dialogs degrade to T3 user-input
  questions; `input`/`editor` dialogs are auto-cancelled (v1 limitation).
- **Structured questions.** Pi's RPC mode cannot render `ctx.ui.custom()`.
  Question extensions can instead emit a `select` dialog whose title starts
  with `t3-user-input:v1:` followed by the JSON-encoded normalized questions.
  The adapter renders one first-class T3 question card and returns the answer
  map as the selected value prefixed with `t3-user-input-response:v1:`.
- **Tool rendering.** Tool lifecycle events (`item.started/updated/completed`)
  follow the shared client data conventions: `data` carries
  `toolCallId`/`kind`/`command`/`path` (file changes only)/`rawInput`/
  `rawOutput.content` (built by `buildPiToolCallData`), and titles/details come
  from `deriveToolActivityPresentation` (`@t3tools/shared/toolActivity`), e.g.
  "Ran command" instead of raw `bash`. Pi only sends args on
  `tool_execution_start`, so the adapter caches them per `toolCallId` and
  re-emits the full `data` on update/end (clients drop `data` from started
  events and render from completed ones).
- **Models.** Pi models are `provider/modelId` slugs. The probe discovers the
  catalog via `get_available_models`; `set_model` switches in-session.
- **Resume.** Cursor `{schemaVersion: 1, sessionFile}` → `--session <file>`.
  Session files stay in Pi's own session dir, so `pi` in a terminal sees the
  same history.
- **Usage.** `message_update.usage` totals are tracked and published as
  `thread.token-usage.updated` on message end and turn settlement (not per
  delta, to keep websocket volume down).

## Known limitations (v1)

- No provider-side rollback (`thread/rollback` fails like Grok's; Pi's
  `fork`/`get_entries` could support it later).
- No MCP server passthrough to Pi.
- Auth status reports `unknown` — Pi is bring-your-own-key via environment
  variables; the probe only verifies the CLI runs.
- Pi's thinking-level control (`set_thinking_level`) is not surfaced.
