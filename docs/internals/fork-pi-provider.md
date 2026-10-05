# Fork: Pi usage on the Usage tab

> Fork-local. Upstream ships the Pi provider itself
> ([adapter](../../apps/server/src/orchestration-v2/Adapters/PiAdapterV2.ts)); this fork used to
> carry its own driver and dropped it when upstream's landed. What remains is the one thing upstream
> does not do: count Pi's tokens and cost on the Usage tab.

```
git grep -n "fork:pi"   # every fork touch point, at any time
```

## What the fork adds

The Usage page scans the provider CLIs' own session files, so Pi needs a parser rather than anything
written at runtime. Pi appends JSONL to `<sessionsDir>/<encoded-cwd>/<timestamp>_<sessionId>.jsonl`
(`~/.pi/agent/sessions` by default, moved by `PI_CODING_AGENT_SESSION_DIR` or
`PI_CODING_AGENT_DIR`; see [piSessionsDir.ts](../../apps/server/src/usage/piSessionsDir.ts)). Each
assistant entry already carries provider, model, an ISO timestamp, the token breakdown, and a cost
Pi computed from the model's own declared rates. That cost is preferred over the LiteLLM table: it
is the only thing that prices locally hosted and custom models, and it honours tiered rates the
table flattens. Compaction and branch-summary entries bill for a real call, so they count too,
attributed to whichever model was last in use. Terminal `pi` runs land in the tab alongside
T3-driven ones, and existing history counts immediately.

Forking copies entries verbatim into the new file, so records de-duplicate on the provider's
response id when there is one, and otherwise on the entry id plus the message instant and token
total. Pi shortens entry ids to eight characters and only checks for collisions within one file.

One-shot `--no-session` runs (commit and PR message generation) write no session file and are not
counted.

The parser lives in [piUsageTranscript.ts](../../apps/server/src/usage/piUsageTranscript.ts). The
shared files it touches are `packages/contracts/src/usage.ts` (`pi` in `UsageProviderKind`),
`usageTranscriptReader.ts`, `usageTranscripts.ts` and `UsageService.ts` on the server, and the web
and mobile `usageProviders.ts`. Each edit is a small block marked `[fork:pi]`; on an upstream
conflict, take upstream's hunk and re-add the block. If upstream ever counts Pi itself, delete all
of it.

## pi-config

[`mahruskazi/pi-config`](https://github.com/mahruskazi/pi-config) holds the Pi extensions used here.
They talk to upstream's adapter through its plain extension UI and the `T3_PI_RUNTIME_MODE`
variable it sets; there is no T3-specific protocol left on either side.
