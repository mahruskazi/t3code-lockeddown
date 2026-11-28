# T3 Code

T3 Code is a minimal GUI for coding agents. A Node WebSocket server wraps provider CLIs and agents (Codex, Claude Code, Cursor, Grok, OpenCode, Antigravity, Kiro, Pi, Muse Code, fx) and serves web, desktop, and mobile clients.

You can think of T3 Code as an open source "bring-your-own-subscription" alternative to apps like Claude Desktop, Codex App, Cursor Glass and Conductor.

> **This checkout is `t3code-lockeddown`, a hardened fork.** It runs against proprietary company code, under one rule upstream does not hold: no code and no prompts leave the machine except through an authorized provider harness. Read [This is a locked-down fork](#this-is-a-locked-down-fork) before merging anything from upstream.

## What makes T3 Code special?

We have over 500,000 users who love T3 Code. It's important we maintain the things they love as we continue to iterate on the product. Here's a brief list of the things we can never compromise on.

### 1. Open at the core

T3 Code is truly open. We share our roadmap, we share how we think about things, and of course we share all our code. A large number of our users run forks (our MIT license covers source code only, not T3 Code's trademarks or branding; see [TRADEMARK.md](TRADEMARK.md)). We work in the open, and should strive to stay that way.

### 2. Performance without compromise

Lots of apps have gotten bogged down with bad tech decisions and "slop". We have not, and we're proud of the performance of T3 Code. We regularly audit for performance regressions, often caused by sending too much data over websockets, css animations causing gpu spikes, lists being hard to render, and more. Make sure all changes are considerate of performance impact.

### 3. Remote ready

The architecture of T3 Code's websocket layer (`t3`) enables a lot of awesome remote features. These have become core to the product. Whether users are connecting directly over their local network, using Tailscale, or leaning in fully with T3 Connect (our tunnel solution, also in this repo), we need to make sure new features are properly supported.

### 4. Multi-surface

T3 Code has 3 key app surfaces: **web**, **desktop**, and **mobile**.

**Web** is kind of two surfaces, as we have the public facing "app.t3.codes" as well as locally hosting the web app through the `t3` command. Both need to be supported by all new features where reasonable.

**Desktop** is the main surface most users install first. It's a full Electron app that bundles the server runner as well. The desktop app can also be used as the host server, allowing remote connections from app.t3.codes or the mobile app.

**Mobile** is a React Native app for both iOS and Android, available on the App Store and Google Play. The mobile app allows for connecting to any T3 Code server to control work remotely.

## A note from Theo

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be able to override anything here.

Of note: Most T3 Code contributions will come from T3 Code itself, often controlled remotely. This means you should be careful about accessing data, killing dev servers, and other things that may damage the T3 Code instance that the contributor is using.

## Terminology

- **you** = the agent reading this file. **we / us / maintainers** = Theo, Julius, and the people building T3 Code. **user** = person driving coding agents in T3 Code. **agent** = coding agent running inside T3 Code.
- Domain terms (environment, project, thread, turn, provider, checkpoint, etc.): [00_glossary.md](docs/internals/00_glossary.md).

## The three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path, or worktree string. Your own agent process has this worktree's path in its argv, and this machine runs several other dev servers at once. Kill only a PID you captured at spawn, or the owner of your port from `ss -H -ltnp` after confirming `/proc/<pid>/cwd` is your worktree.
2. **Writing to the live install.** `~/.t3/userdata` is the developer's real T3 Code database, in use while you work. Reading or copying from it is fine. Never start a server against it, never open it read-write, never clean it up.
3. **Baking in origins.** Never set `VITE_HTTP_URL` or `VITE_WS_URL` for dev. Dev is single-origin and Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known`. Setting them bakes localhost into the bundle and silently breaks every remote browser.

## Hit every surface

The most common defect in this repo is a change that works on the path you tested and is missing everywhere else. Before calling frontend work done, walk this list and say which entries applied:

- **Entry points.** Chat view, Settings, command palette, and keybindings. Fixing one is not fixing the feature.
- **Clients.** Web, desktop (Electron shell/IPC), and mobile (React Native). Shared logic lives in `packages/client-runtime`.
- **Providers.** Every provider adapter needs a decision, even if the decision is "not supported here".
- **Agents.** Capabilities a user triggers should be service methods reachable by MCP tools and scheduled tasks, not inline handler code.
- **Contracts.** Wire changes go in `packages/contracts` so server, web, mobile, and desktop follow.
- **Reverse states.** Every way in needs a way out and a way to see it (snooze/unsnooze, close/reopen). A one-way door is a bug.
- **Connection modes.** Local, remote/relay, and tunnel; multi-device and multi-environment.
- **Languages.** Translate user-facing copy in `apps/{web,mobile}/src/i18n/translations` (`vp run i18n:generate` / `vp run i18n:check`) and `apps/marketing/src/i18n`. See [14_i18n.md](docs/internals/14_i18n.md).
- **Docs.** Check whether the change makes existing guidance inaccurate. Follow [Documentation](#documentation).

## Dev servers and test data

See [00_development.md](docs/operations/00_development.md) for setup, ports, seeding (`vp run migrate-dev-db`), and [reusable dev auth](docs/operations/00_development.md#reusable-dev-credential). Agent-specific rules:

- **Worktree setup:** Wait while `.t3/setup-running` names a live PID; do not run `vp i` concurrently. If no `.t3/setup-*` marker exists, run `vp i` yourself.
- **Process lifecycle:** Start dev servers, Metro, and builds from your own shell so they exit with your session—never detach with `systemd-run`, `nohup`, `setsid`, or `tmux` unless asked. Stop background tasks with your harness's own stop (`vp` does not forward SIGTERM to child Vite/server processes).
- **Sharing (`vp run dev --share`):** Wait for `pairingUrl:` and hand the full URL to the user. Never wire `tailscale serve` by hand, open the URL yourself, or consume the user's one-time pairing link. Mint another with `node apps/server/src/bin.ts pair` if needed.
- **Test data:** Always copy in (never symlink) and refresh `statev2.sqlite`, not `state.sqlite`. Bring `secrets` / `settings.json` only if the flow under test needs them.
- **Extra checkouts:** Put `git worktree add` next to this worktree, not in `/tmp`, and remove it when done.

## This is a locked-down fork

`mahruskazi/t3code-lockeddown` is a fork of `pingdotgg/t3code` that exists for one reason: **it is safe to point at proprietary company code and data.** The agents running inside this app read confidential repositories, credentials sit in the environments it connects to, and everything an agent sees passes through this server.

Upstream is a healthy, fast-moving open source project with a large contributor base and bot-authored commits. That is good for upstream's users and it is exactly why we do not track it blindly: every line we merge gains the same access to that data as the lines we wrote ourselves.

### The rule

**No code and no prompts leave this machine, except through an authorized provider harness.**

The authorized path is the one the product exists for: a provider CLI — Codex, Claude Code, Cursor, Grok, OpenCode, Kiro, Pi, Muse, fx — sending a turn to its own model API under the operator's own subscription. That is a deal the operator already made with that vendor deliberately, and it is the only channel that may carry source code, diffs, file contents, terminal output, or prompt text off this machine.

Everything else is a leak, including the well-meant kind: analytics, crash reporting, "anonymous" usage pings, remote log shipping, a debug endpoint, a prefetch, a provider adapter that quietly widens what it puts in a payload. Intent does not enter into it. A host we did not choose receiving bytes we did not review is the failure, whether it got there by an attacker, a contributor, or a dependency.

Two things follow, and they are why the invariants below exist:

- **Code we did not choose must not run here.** Anything fetched and executed gets the same access to the data as our own code, so a runtime download is an egress path with extra steps.
- **The rule binds the merged tree, not our commits.** Upstream code ships into the same process with the same access. That is what the audit process below is for.

### Where data legitimately goes

Every outbound path this fork has, and what it may carry. A path that is not on this list is a finding.

| Path                                                                                                                                   | Carries code or prompts                                                                                                                                   | Status                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider harnesses (Codex, Claude Code, Cursor, Grok, OpenCode, Kiro, Pi, Muse, fx)                                                    | Yes — this is the authorized harness                                                                                                                      | The product. Claude and Cursor run in-process via their vendors' SDKs, not spawned CLIs. See the notes below.                                                                                                                                                                                                                                            |
| Codex `/feedback` upload (OpenAI, through the Codex CLI)                                                                               | Yes — the whole thread plus Codex's own logs                                                                                                              | Opt-in per invocation; the user types `/feedback` in a Codex thread. See the note below.                                                                                                                                                                                                                                                                 |
| Source-control hosts (GitHub, GitLab, Bitbucket, Azure DevOps, Forgejo/Gitea, GitCafe, Cursor Origin, TanStack Source)                 | Yes — but to the repo's own remote, under the operator's credentials                                                                                      | Authorized. Includes the PR media proxy, which keeps the token on GitHub hosts (`apps/server/src/assets/GitHubMediaFetch.ts`), Cursor Origin's API through the operator's `origin` login (`packages/source-control-cursor-origin`), and TanStack Source (`source.tanstack.com` only, behind its feature flag; `packages/source-control-tanstack-source`) |
| Linear issue tracker (`api.linear.app`)                                                                                                | Yes — issue and comment text the user or an agent writes, to the operator's own Linear workspace                                                          | Off until the operator saves a Linear API key (Settings → Source control & issues); writes happen only from the Issues UI or the agent `issues` tool (`packages/issue-tracker-linear`)                                                                                                                                                                   |
| Jira Cloud issue tracker (the operator's own `*.atlassian.net` site)                                                                   | Yes — issue and comment text the user or an agent writes; on a Jira Service Management request, a comment sent as Reply to customer reaches that customer | Off until the operator saves a site, email and API token (Settings → Source control & issues); writes happen only from the Issues UI or the agent `issues` tool (`packages/issue-tracker-jira`)                                                                                                                                                          |
| T3 Connect relay (`app.t3.codes` plus a cloudflared tunnel)                                                                            | Yes — the entire session                                                                                                                                  | Opt-in per environment via `t3 connect`, never on by default. See the note below.                                                                                                                                                                                                                                                                        |
| `t3 triage` and in-app triage (public issue on `pingdotgg/t3code`)                                                                     | Yes — logs, DB contents, terminal output                                                                                                                  | **Removed** — invariant 4                                                                                                                                                                                                                                                                                                                                |
| PostHog analytics                                                                                                                      | Event metadata                                                                                                                                            | **Removed** — invariant 1                                                                                                                                                                                                                                                                                                                                |
| Agent feedback reports (T3 ingest, through the analytics sink)                                                                         | Yes, once approved — the report's text and an optional conversation trace                                                                                 | **Removed** — invariant 1: they ride `AnalyticsService.record`, which never sends, so reports stay local and read as unsent (`apps/server/src/feedback/FeedbackStore.ts`)                                                                                                                                                                                |
| Mobile crash reports (`expo-observe`, relay to Axiom)                                                                                  | Error messages and stacks, which can quote thread content                                                                                                 | **Removed** — invariant 1 (`apps/mobile/src/features/observability/observe.ts`, `[fork:lockdown]`)                                                                                                                                                                                                                                                       |
| npm registry or GitHub release archives, at runtime                                                                                    | No, but pulls executable code onto the machine                                                                                                            | **Removed** — invariants 2 and 3                                                                                                                                                                                                                                                                                                                         |
| ACP Registry agents (`cdn.agentclientprotocol.com`, then archives, npm, PyPI)                                                          | Yes — the agent it installs runs every turn                                                                                                               | **Removed** — invariant 2                                                                                                                                                                                                                                                                                                                                |
| Managed Codex and Antigravity installs (GitHub releases, `storage.googleapis.com`)                                                     | No, but are executables                                                                                                                                   | Pinned version and hash in the source, fetched only when the operator picks managed setup. Upstream follows the vendors' latest releases; this fork does not. See the note below                                                                                                                                                                         |
| Fork desktop updates (this repository's `main-build` release on `github.com`)                                                          | No, but the desktop app installs the builds it serves                                                                                                     | macOS fork builds only, user-triggered; sha256, codesign, bundle id and version checked before install. See the note below (`apps/desktop/src/electron/ElectronForkUpdater.ts`)                                                                                                                                                                          |
| Headless preview browser (Chrome for Testing, `storage.googleapis.com`)                                                                | No, but is an executable                                                                                                                                  | Pinned version, sha256 in the source, fetched the first time the server-side browser is used (`apps/server/src/preview/PreviewBrowser.ts`)                                                                                                                                                                                                               |
| Link and tab favicons (Google's `s2/favicons`)                                                                                         | No — but every public hostname that appears in a chat link or browser tab                                                                                 | **Removed** — `faviconUrlForOrigin` returns nothing (`packages/shared/src/favicon.ts`, `[fork:lockdown]`)                                                                                                                                                                                                                                                |
| Provider update checks (`registry.npmjs.org`, Homebrew, `api.meta.ai`, `downloads.claude.ai`, `releases.openai.com`, `releases.fx.sh`) | No — a package name and the installed channel                                                                                                             | Version lookups, gated by the provider-update-check setting (`packages/provider-core/src/server/maintenanceResolver.ts`)                                                                                                                                                                                                                                 |
| T3 release lookup (`registry.npmjs.org/t3/<version>`, or the configured npm registry)                                                  | No — a version number                                                                                                                                     | Read-only server check behind "update everything" (`apps/server/src/cloud/npmRelease.ts`)                                                                                                                                                                                                                                                                |
| Browser-panel address bar search (`duckduckgo.com` by default, or the chosen engine)                                                   | Whatever the user types into the address bar that is not a URL                                                                                            | User-typed only; agents navigate by URL (`packages/shared/src/preview.ts`)                                                                                                                                                                                                                                                                               |
| Codex ChatGPT sign-in (`auth.openai.com`, `api.openai.com/v1/models`)                                                                  | No — an OAuth token and the model list                                                                                                                    | Operator-triggered, for managed Codex setup (`apps/server/src/provider/CodexChatGptAuth.ts`)                                                                                                                                                                                                                                                             |
| Usage limit sources (operator's own CLIProxyAPI hub or HTTP quota URL)                                                                 | No — quota reads (with the operator's optional bearer token) and the Codex reset-credit claim, through the hub                                            | Operator-configured URL, off by default (`apps/server/src/usage/cliproxyApi.ts`, `UsageLimitSources.ts`)                                                                                                                                                                                                                                                 |
| Provider account usage (Anthropic, Cursor, xAI, OpenCode, Google)                                                                      | No — reads each CLI's saved login and asks that same vendor for quota and usage                                                                           | Automatic with provider status checks; Cursor's Keychain read is opt-in; the Claude reset-credit claim is user-triggered. See the note below                                                                                                                                                                                                             |
| GitHub release list (`api.github.com`)                                                                                                 | No — release metadata                                                                                                                                     | Read-only fetch by the mobile app's server-update check (`apps/mobile/src/features/settings/environment-maintenance.ts`)                                                                                                                                                                                                                                 |
| `cloudflared` binary download                                                                                                          | No, but is an executable                                                                                                                                  | Pinned version, sha256-verified, fetched only when the operator turns on T3 Connect (`packages/shared/src/relayClient.ts`)                                                                                                                                                                                                                               |
| litellm pricing table (`raw.githubusercontent.com`, `api.github.com` fallback)                                                         | No — a rates JSON, cached for a day                                                                                                                       | Read-only fetch (`apps/server/src/usage/UsageService.ts`)                                                                                                                                                                                                                                                                                                |
| Model classification manifest (`raw.githubusercontent.com`)                                                                            | No — a list of current model slugs, cached for an hour                                                                                                    | Read-only fetch, gated by the provider-update-check setting (`apps/server/src/provider/ModelManifest.ts`)                                                                                                                                                                                                                                                |
| Open VSX theme search (`open-vsx.org`)                                                                                                 | No — a theme query from the web client                                                                                                                    | Read-only fetch (`apps/web/src/openVsxThemes.ts`)                                                                                                                                                                                                                                                                                                        |
| OTLP traces, metrics and logs export                                                                                                   | No — span metadata and log lines, including workspace and worktree paths                                                                                  | Operator-configured, off by default. See the note below (`apps/server/src/observability/Observability.ts`)                                                                                                                                                                                                                                               |
| Managed-policy update mirror (the `feedUrl` an administrator sets in the machine policy)                                               | No, but the desktop app installs the builds it serves                                                                                                     | Off unless a machine policy sets it; the desktop updater follows it, the server's self-update never downloads. See the note below                                                                                                                                                                                                                        |
| Hosted app auth (`app.t3.codes`, Clerk)                                                                                                | No — account identity                                                                                                                                     | Only on the hosted-web and relay paths                                                                                                                                                                                                                                                                                                                   |
| Linked environments (another T3 server you link)                                                                                       | Yes — `delegate_task` sends the task prompt, and it runs on that machine                                                                                  | Labs beta, off by default on both ends; each link is paired and approved by the user. See the note below                                                                                                                                                                                                                                                 |
| Guest links (a guest's browser, over T3 Connect)                                                                                       | Yes — the shared thread's history, replies, files and command output                                                                                      | Labs beta, off by default, and needs T3 Connect. See the note below                                                                                                                                                                                                                                                                                      |
| EAS cloud simulators (`api.expo.dev`) and Simlock gateways                                                                             | Whatever the agent installs on or shows the device: app builds, screens                                                                                   | Operator-added device hosts only, with the operator's Expo token or gateway (`apps/server/src/device/EasDeviceHost.ts`)                                                                                                                                                                                                                                  |
| GitHub star check (`api.github.com`, the server's GitHub login)                                                                        | No — whether that account starred `pingdotgg/t3code`                                                                                                      | Web client asks once after five prompts (`apps/web/src/components/GitHubStarPrompt.tsx`)                                                                                                                                                                                                                                                                 |
| Cloud voice transcription (OpenAI, xAI, OpenRouter)                                                                                    | Yes — the recording, which becomes prompt text, plus the custom-word list                                                                                 | **Removed** — refused before any request, and `cloudVoiceTranscription` is not advertised (`apps/server/src/speech/CloudSpeech.ts`, `[fork:lockdown]`)                                                                                                                                                                                                   |
| Text generators (OpenAI, Anthropic, OpenRouter, or a custom OpenAI-compatible URL)                                                     | Yes — the task input: a staged diff, a thread prompt, a transcript                                                                                        | **Removed** — every request is refused before the transport (`apps/server/src/textGeneration/textGeneratorDrivers.ts`, `[fork:lockdown]`)                                                                                                                                                                                                                |
| Speech models (`huggingface.co`)                                                                                                       | No, but native code parses them                                                                                                                           | Pinned revision and sha256 in `apps/server/src/speech/catalog.json`, fetched when a user installs a model or the silence detector first runs                                                                                                                                                                                                             |
| Orbit broker (the local Orbit daemon, `http://127.0.0.1:<port>/internal/t3/tool`)                                                      | Yes — prompts, ticket text and notes an agent passes, but only to this machine                                                                            | Off unless `T3CODE_ORBIT_BROKER_TOKEN_FILE` is set; loopback enforced in code. See the note below (`apps/server/src/mcp/OrbitBroker.ts`)                                                                                                                                                                                                                 |

**The Claude harness is a library, not a subprocess.** Upstream moved the Claude provider from a
spawned `claude` CLI to `@anthropic-ai/claude-agent-sdk` running inside the server process
(`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`). The destination is unchanged — Anthropic, under
the operator's own subscription, carrying the turn — so it stays the authorized path. What changed is
the shape: the server now makes those HTTPS calls itself rather than handing them to a separate
process, so the harness boundary is a dependency version rather than a process boundary. The SDK's
bundled platform binaries are removed by `pnpm-workspace.yaml` overrides and the user's own Claude
executable is always supplied, so no vendored binary ships. Treat an SDK bump as provider-adapter
surface in the audit: read the diff for widened payloads, not just for a version number.

**Cursor is a library too.** Upstream's Cursor provider runs `@cursor/sdk` in the server process
(`packages/provider-cursor/src/server/CursorAgentSdk.ts`) and talks to `api2.cursor.sh` under the
operator's Cursor login, so it is the same authorized-harness shape as Claude. The SDK bundles a
Statsig client; it is constructed with `disableLogging`, `disableStorage` and
`networkConfig.preventAllNetworkTraffic`, bootstrapped from Cursor's own API, so nothing reaches
Statsig's hosts. Its platform package (sandbox helper, ripgrep, tree-sitter) arrives at install time from
the lockfile, not at runtime. Treat an SDK bump like a Claude SDK bump: re-check that Statsig
configuration and any new host in its bundle.

**Managed Codex and Antigravity installs are pinned downloads.** Choosing managed setup for a Codex or
Antigravity instance downloads that vendor's own harness binary from a URL and hash written in the
source (`RELEASES` in `CodexInstallation.ts`, `pinnedAntigravityCliRelease` in
`antigravityCliRelease.ts`), the same shape as `cloudflared`. The bytes are fixed by a reviewed commit,
which is what separates them from the ACP Registry, whose content a third party picks at fetch time.
Upstream now moves managed installs to whatever npm's `@openai/codex` tag or Antigravity's update
manifest names; here the Codex lookup returns nothing and the Antigravity layer passes its pin, which
turns the manifest read off (`[fork:lockdown]`). A bump changes those constants; read them in the
audit. Tripwires: `CodexInstallation.test.ts`, `antigravityCliRelease.test.ts`.
The server-side headless browser (`apps/server/src/preview/PreviewBrowser.ts`) is the same shape, a
pinned Chrome for Testing build, except that it installs on first use, so an agent driving the browser
can trigger the download.

**The fork's macOS app updates itself from `main-build`.** `.github/workflows/fork-main-build.yml`
publishes ad-hoc signed builds to a rolling prerelease of this repository, and a build carrying that
feed in `app-update.yml` downloads and installs the next one when the user clicks update
(`[fork:lockdown]`). This is a deliberate, maintainer-approved exception to "no executable code from
the network": the bytes come only from this repository's own CI at a URL fixed in the source, and are
verified against the release manifest and the running app's bundle id before the swap. Server
self-update and remote hosts are unchanged (invariants 2 and 3). See
[Fork main build](docs/operations/fork-main-build.md).

**Webhook automations take input from anyone holding the URL.** A scheduled task can be triggered by
`/api/hooks/<hookId>/<token>`, directly or through the T3 Connect relay. The token is the only
credential unless the operator adds a signature check, and the request body can be templated into the
agent's prompt. Nothing flows back to the sender, but creating one hands that sender a way to start an
agent run on this machine, so treat it as an access decision like T3 Connect.

**Workflows run operator-authored code in the server process.** Upstream's durable workflows
(Labs, off by default) load `.ts` files from `~/.t3/workflows` (or `T3CODE_WORKFLOWS`) into the
server and give them its full access, network included, so a workflow can reach any host its author
writes. Their webhook triggers share `/api/hooks/<hookId>/<token>` with scheduled tasks. Turning
workflows on, or letting an agent write that folder, is an access decision, not a dependency.

**Codex `/feedback` is a deliberate upload, not a turn.** Sending `/feedback` in a Codex thread calls the Codex app-server's `feedback/upload`, which posts that thread's transcript to OpenAI with `includeLogs: true` and returns an id to quote at OpenAI support. It rides the authorized harness and goes to the vendor whose CLI already sees every turn in that thread, which is why it is not a fifth invariant — but the logs are wider than a turn, and nothing about the payload is reviewable from here. Treat invoking it on a proprietary thread the way you would treat pasting that thread into a vendor support ticket, because that is what it is. Nothing sends it automatically: no code path reaches `uploadFeedback` without the user typing the command.

**T3 Connect is the open one.** This fork has not disabled it, and it is the one available path that would carry everything — code, prompts, diffs, terminal output — through a third party. It takes a deliberate `t3 connect` to start, so nothing leaks by accident, but enabling it on a machine holding proprietary code is an authorization decision, not a convenience. Local network and Tailscale reach the same clients without it. If we ever decide the relay is out of bounds here, that becomes a fifth invariant with a choke point and a tripwire, like the four below.

**OTLP export is the other operator switch.** Setting `otlpTracesUrl`, `otlpMetricsUrl` or `otlpLogsUrl` makes the server forward its spans, metrics or log records to that URL on an interval, alongside the local `server.trace.ndjson` it always writes. The spans carry operation names, provider kind, model names, thread and turn ids, and attachment counts — not prompt text, file contents, diffs, or terminal output. They do carry `terminal.cwd`, `checkpoint.cwd`, and `git.cwd`, so a collector learns the paths of the repositories worked on here, which is enough to identify projects and clients. Nothing filters span attributes; the only redaction in the pipeline covers HTTP header names. The settings are empty by default and are set from `settings.json` or `T3CODE_OTLP_*`, never from the Settings UI, which only reports whether export is on. Upstream also honors the standard `OTEL_EXPORTER_OTLP_*` variables; this fork ignores them unless `T3CODE_OTEL_STANDARD_ENV=true` (`packages/shared/src/otelEnvironment.ts`, `[fork:lockdown]`), because a machine-wide endpoint set for some other tool would otherwise start shipping this server's telemetry without anyone deciding to. Pointing them at a collector on a machine holding proprietary code is an authorization decision, the same shape as T3 Connect.

**Provider account usage reads the CLIs' logins.** Upstream's usage limits read each provider CLI's
saved credential — `~/.claude/.credentials.json`, Cursor's `auth.json` or macOS Keychain entry, `~/.grok/auth.json`,
OpenCode's `auth.json` — and call that vendor's own account endpoints (`api.anthropic.com/api/oauth/usage`,
`api2.cursor.sh` and `cursor.com`, `cli-chat-proxy.grok.com`, `opencode.ai`, and for Antigravity Google's
`cloudcode-pa.googleapis.com` after refreshing its token at `oauth2.googleapis.com`). The credential goes back to the vendor that
issued it and the response is quota and token counts; no code or prompt text is sent. The Claude reset-credit claim
spends a credit on the account, so it only ever runs when the user asks.

**The desktop app can now read your browser's cookies.** Upstream added a browser-import feature
(`apps/desktop/src/preview/BrowserImport/`) that decrypts Chromium, Firefox and Safari cookie
databases and writes them into the in-app preview browser's Electron partition. It reaches the OS
credential store through `@napi-rs/keyring` and, on Linux, a small libsecret helper we build from
source (`native/browser-secret/main.c`). Nothing leaves the machine: the cookies move from one local
store to another, and macOS still shows its keychain prompt. It is on this page because the preview
browser is remotely drivable — once real session cookies live in it, anyone who can drive this
environment can reach the sites those cookies authenticate. That is an access decision, the same
shape as T3 Connect and OTLP, not a leak.

**Linked environments and guest links move threads off this machine.** A linked environment is
another T3 server the user pairs with this one; `delegate_task` runs a task there, so its prompt
and the work it does live on that machine. A guest link opens one thread to whoever holds the URL,
through T3 Connect. Both are Labs betas that are off by default, and both are access decisions of
the same shape as T3 Connect, not leaks. `t3 up` (`apps/server/src/cli/up.ts`) preselects T3 Connect
on a fresh machine upstream; here it starts with Connect off unless `--connect` is given
(`[fork:lockdown]`), so `t3 up --headless` never turns on the relay by itself.

**A managed policy can repoint the desktop updater.** Upstream added machine policies
(`/etc/t3code/policy.json`, the Windows registry, or a macOS configuration profile; read by
`apps/server/src/policy/ManagedPolicy.ts` and `apps/desktop/src/app/DesktopManagedPolicy.ts`).
Only an administrator of the machine can write one, and most of what it does narrows access:
it can turn off telemetry, T3 Connect, remote clients and updates. Its `updates.feedUrl` is the
exception: the desktop app's updater then downloads and installs builds from that mirror. The
server's self-update ignores the mirror here and still runs only a provisioned runtime
(`pinnedRuntime.ts`, `[fork:lockdown]`). Setting a feed URL is an access decision, the same shape
as T3 Connect.

**The Orbit broker stays on this machine.** Orbit is the operator's local planning daemon, and this
fork's `orbit` MCP tool forwards an agent's fixed planning operations to it with T3-verified
environment, thread and provider-session identity. That body can hold whatever the agent passes:
thread prompts, ticket text and progress notes, plus those identifiers. With
`T3CODE_ORBIT_BROKER_TOKEN_FILE` unset, the tool is not advertised and Codex approval policy is
unchanged. When set, the file must be owner-only (no group or other bits) and its credential is read
per call, never placed in a prompt, log or transcript. The destination is fixed to `127.0.0.1`;
`T3CODE_ORBIT_PORT` only accepts a port number. `loopbackOnly` refuses any other URL before it
reaches the transport, and the transport is `node:http` with its own agent because `fetch` would
follow a 307 to another host with the body, and honor `NODE_USE_ENV_PROXY`. Providers other than
Codex (host attestation) and Claude (SDK hook) cannot separate a native child from its parent, so
they get `orbit_context` only. Orbit is responsible for what it does with the data afterward, and
the token file is readable by any process running as this OS user, including an unsandboxed agent's
shell. Tripwires: `OrbitBrokerEgress.test.ts` (real redirect and env proxy) and `OrbitBroker.test.ts`.

**Voice input stays on this machine or this environment.** Upstream added dictation: on-device on
mobile, an environment-local model (transcribe-cpp, its native prebuilds from the lockfile), and cloud
transcription that uploads the recording to OpenAI, xAI or OpenRouter. The recording is prompt text
before it is typed, so the cloud path is closed; environment transcription sends audio only to the
user's own environment. Transcript cleanup uses the environment's text generation model, which here is
always a coding agent.

**Text generators are closed.** Upstream lets a model API write titles, commit messages, PR text and
transcript cleanup instead of a coding agent, sending the task's input, such as the staged diff, to the
configured endpoint. That is code leaving outside a harness, so the drivers refuse every call, including
to a local URL; the settings page still exists, and every check fails with a message pointing back to a
coding agent. Tripwire: `TextGenerators.test.ts`.

**Upstream's GitHub workflows are not carried here.** The only workflow is
`fork-main-build.yml`; upstream's CI, release, preview, mobile and moderation workflows (and the
`.github/scripts` and actions only they used) are deleted. One of them, `cursor-hygiene-webhook`,
POSTed every push, PR, issue and discussion payload to a Cursor webhook. A sync that touches a
deleted workflow conflicts; resolve it by deleting the file again, and audit any new one before it
lands.

### The invariants

The rule above is enforced in review. These four leak paths are closed in code instead, so they cannot come back quietly. They are invariants, not preferences. Restoring any of them is a regression no matter how the change arrives — an upstream merge, a dependency bump, a "harmless" revert. Every touch point carries a `[fork:lockdown]` marker:

```
git grep -n "fork:lockdown"   # every lockdown touch point, at any time
```

1. **No telemetry leaves the machine.** `apps/server/src/telemetry/AnalyticsService.ts` binds the live layer to the no-op service, so the PostHog client is never constructed, no flush fiber runs, no identity file is read, and no environment variable can turn sending back on. Server start does not read provider logins for owner ids (`serverRuntimeStartup.ts`). The mobile app's crash reporter never dispatches and its native endpoint is `.invalid` (`apps/mobile/src/features/observability/observe.ts`, `app.config.ts`). Tripwires: `AnalyticsService.test.ts` enables telemetry in config and asserts zero outbound requests; `observe.test.ts` asserts crash reports never dispatch.
2. **No executable code arrives from the network at runtime.** `apps/server/src/cloud/pinnedRuntime.ts` is the single choke point covering server self-update and boot-service installs. Upstream downloads a `pingdotgg/t3code` GitHub release archive on demand (it used to `npm install t3@<version>`); this fork reuses a complete runtime already on disk and hard-errors otherwise, so an update can only ever run a build we provisioned. Upstream's `t3 update` command, which does the same from the CLI, is not registered. Device support (`apps/server/src/device/DeviceToolchain.ts` and `sshDeviceScript.ts`) npm-installs `expo-device-hub` and `agent-device` upstream; here it uses a provisioned install or fails. Upstream's ACP Registry provider reads the public registry at `cdn.agentclientprotocol.com` and downloads the agent it names, as an archive or an `npx`/`uvx` package; here the live catalog (`layerFromHost` in `packages/provider-acp-registry/src/server/AcpRegistrySupport.ts`) refuses every registry operation, and only the Local command source, an executable the operator installed, launches. Tripwires: `pinnedRuntime.test.ts` (a process runner and HTTP client that die on any call), `selfUpdate.test.ts`, `binCli.test.ts` (`update` absent), `DeviceToolchain.test.ts`, `sshDeviceScript.test.ts` and `AcpRegistryLockdown.test.ts`.
3. **Remote hosts run our build, never a published one.** Upstream's SSH launcher downloads and runs a GitHub release archive for the client's version (it used to fall back to `npx t3@<version>`). This fork removes the download path entirely (`REMOTE_RUNNER_SCRIPT` in `packages/ssh/src/tunnel.ts`): the runner execs the `t3` on the remote PATH or fails with provisioning instructions. Tripwire: `tunnel.test.ts` asserts the generated scripts contain no npm, npx, curl, wget or release-archive path, and runs the real runner against a sandboxed home. See below for how provisioning works.
4. **Diagnostic bundles never leave the machine.** Upstream ships `t3 triage` (`apps/server/src/cli/triage.ts`), which seeds a local coding agent to investigate the state database, provider event log, and terminal logs, then file the findings as a public issue on `pingdotgg/t3code`. Here that evidence _is_ the proprietary material, and upstream's redaction step covers credentials and home paths but not source, prompt text, or repo identities. This fork does not register the command and does not carry its playbook or issue template. Upstream's in-app version ("Triage an issue" in the command palette) goes through `apps/server/src/triage/TriageService.ts`, which here refuses every request; the server does not advertise the `triage` capability, so web and mobile hide the entry, and the boot-error screen no longer suggests `npx t3 triage`. Tripwires: `binCli.test.ts` asserts `triage` is absent from the CLI; `TriageService.test.ts` asserts the service refuses.

Pi is an upstream provider, Usage tab included. The fork adds structured user input (`userInput.ts`), `todo_write` checklists (`todos.ts`), Plan mode and approval exemptions in the injected extension (`mcpExtensionSource.ts`), and native items for common extension tools (`extensionTools.ts`), all in `packages/provider-pi/src/server/`, plus Lineage rows for agents that have no child thread.

### Auditing an upstream merge

Upstream is not hostile, but it is a large public codebase we do not review as it lands. Treat every sync as a supply-chain event: **nothing merges unaudited.** The point is not to re-review upstream's engineering, it is to answer one question — does anything here move our data somewhere new, or run code we did not choose?

Work from the last audited sync commit, not from ahead/behind counts. Upstream rewrote `main`'s history in August 2026, so parts of it appear twice under different SHAs and `git cherry` reports every fork commit as unique. Record the sync commit in the merge message so the next audit has a real starting point.

```
git fetch upstream
git log --no-merges --format='%h %an %s' <last-sync>..upstream/main
git diff <last-sync>..upstream/main
```

Read the whole diff at least at file-name level, then look hard at:

- **New or bumped dependencies.** `package.json` and `pnpm-lock.yaml` additions are the highest-risk item in any sync — a new transitive package is code we never read, running with our access. Justify every addition, and check `postinstall`/`prepare` scripts on anything new.
- **New outbound network calls.** Grep the diff for `fetch(`, `http://`, `https://`, new hostnames, analytics or error-reporting SDKs. Any new destination has to earn a row in the table above or it does not merge. A crash reporter is telemetry wearing a different hat.
- **The invariant files themselves.** Anything under `apps/server/src/telemetry/`, `apps/server/src/cloud/`, or `packages/ssh/`, plus the CLI registration in `apps/server/src/binCli.ts`. Conflicts here are expected and always resolve toward the fork.
- **Anything that reads outside the workspace.** Environment variables, `~/.t3` state, secrets, SSH config, git credentials — especially where the value then flows into a request body, a log line, or a provider prompt.
- **Provider adapters.** A new endpoint or a widened prompt payload changes where our source code gets sent. The harness is authorized; an adapter sending more than the turn to somewhere else is not.
- **CI and build config.** `.github/workflows`, build scripts, and Electron entitlements can exfiltrate or weaken the shipped app without touching product code.
- **Auth, pairing, and permission paths.** Anything that widens who can connect, or what a connected client may do, is a data-access change.

Then, before pushing the merge:

- Run the tripwires: the telemetry, pinned-runtime, self-update, tunnel, CLI-registration, and Orbit broker egress tests above. They are the automated half of this audit and they must pass on the merged tree, not just on the fork's side.
- Confirm `git grep -n "fork:lockdown"` still finds every marker — a vanished marker means an upstream hunk overwrote a lockdown edit.
- If something in the diff is unclear, it does not merge until it is understood. "Probably fine" is not an audit result.

### Remote environments (Coder / SSH)

This fork is deployed to remote SSH hosts (e.g. Coder workspaces) from the local checkout, never from the published npm package. Provisioning works like this:

- `scripts/setup-remote-t3.sh <ssh-host> [remote-dir]` rsyncs this checkout to the remote, builds `apps/server/dist/bin.mjs` there (mise-pinned node 24 + repo pnpm, `--frozen-lockfile`), and installs a `~/.local/bin/t3` shim pointing at that build. The launcher finds the shim via its `command -v t3` branch.
- The script is idempotent: re-run it after changing the fork, then disconnect and reconnect the environment in the desktop app so the launcher restarts the server from the new build. The launch script now calls `t3 __ssh-helper` on the remote, so a host provisioned before that command existed must be re-provisioned before it will connect.
- Do not reintroduce the npm install fallback — it would silently swap this fork's server for the upstream published one on any unprovisioned host, which is invariant 3.
- The remote host needs mise (`curl -fsSL https://mise.run | sh`) and a C toolchain for node-pty; everything else the script handles.

## Verifying

- Before you push, run `vp run check:changed`. **Do not run repo-wide checks** (`vp check`, `vp run -r test`, `vp run -r typecheck`) unless asked—CI owns the full suite.
- Iterate with `vp test run <files>` (add `-t "<name>"` for large files) and `vp run typecheck` (`effect-tsgo tsrs --noEmit`). Run `node -e` snippets from the owning package (`effect` does not resolve from repo root).
- Follow [15_testing.md](docs/internals/15_testing.md) for what to test, bug-fix proof, draining async work (no sleeps/polling), web browser tests (`await using screen = await render(...)`), and real-app [Scenarios](docs/internals/15_testing.md#scenarios) (`vp run scenarios:prove`).
- Give user-visible frontend changes one integrated pass in a real client: `test-t3-app` for web, `test-t3-mobile` for mobile (primary agent only; subagents do not launch dev servers). Inspect the rendered result and walk the flow as a user using the feature—checking layout, visual hierarchy, and ergonomics—and fix anything rough until you are satisfied before handing back. Use the free `Replay (dev)` provider unless the change depends on a real provider (then pick its cheapest model, e.g. Haiku or Luna). On mobile, run `vp run mobile:install <ios|android> [device-id]` before Metro rather than rebuilding from scratch.

## Evals

`evals/` checks how real models behave with T3 Code's model-facing text: agent instructions, MCP tool descriptions and schemas, and generated titles. Before changing that text, read [evals/README.md](evals/README.md) and run the evals it names. When fixing a model behavior bug, add a case that fails before the fix.

## Pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- `origin` is not always GitHub. Check `git remote get-url origin` before your first forge command and use that forge's CLI and skill. See [Forge mirror](docs/operations/00_development.md#forge-mirror-optional).
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- UI changes need before/after images; motion or timing needs a short video. Upload PR evidence to GitHub—never commit PR-only screenshots or assets.
- One request is one PR. Split only when asked. Outside contributions follow [CONTRIBUTING.md](CONTRIBUTING.md#one-problem).
- When babysitting: call `watch_pull_request` and end your turn. Do not poll or sleep. Verify each bot finding against the source, fix real ones, dismiss false positives with a written reason. Stay quiet when nothing is new; stop when bots are green on the latest commit.

## Documentation

Most code changes do not need an internal documentation change. Agents can read the code.

- `docs/internals/` is for architectural decisions and their reasons, constraints that span components, and implementation traps that are hard to discover from the source. Before adding a paragraph, ask what a maintainer would get wrong without it. If reading the relevant code answers the question, leave it out.
- Do not document every feature, enumerate fields, methods, constants, timeouts, or migration numbers, narrate control flow, maintain file catalogs, or append PR summaries. Anything that can drift will drift; types, tests, and code already record the implementation. The glossary defines shared vocabulary; it is not a feature index.
- A local reason the code can't show goes in a short nearby code comment. Use an internal doc when the reasoning crosses boundaries or needs context the code cannot carry well. Link to the relevant source instead of copying it.
- When a documented decision or constraint changes, rewrite or remove the affected text. Do not append another account of the new behavior. A new internal page needs a distinct, durable reason to exist.
- `docs/user/` helps users accomplish tasks in the shipped product's voice, without implementation details or contributor tooling. Focus on what a feature does, how to start, and anything unintuitive—not descriptions of buttons, layouts, or UI tweaks.
- `docs/operations/` holds maintainer setup, release, and debugging runbooks. Keep end-user server instructions in `docs/user/`.

## Plans and work artifacts

- Do not commit implementation plans, research notes, or agent scratch files (keep temporary material outside the worktree).
- Track active maintainer work in its GitHub issue or project item; external proposals belong in Ideas discussions. A merged PR is the implementation record.

## Where code lives

- `apps/server` - WebSocket, event-sourced orchestration (`Orchestrator` → `EventSink` → `EffectWorker`), providers, checkpointing. Read [02_effect-services.md](docs/internals/02_effect-services.md) and `.repos/effect/LLMS.md`.
- `apps/web` - React/Vite UI. `apps/desktop` wraps it; `apps/mobile` is React Native; `apps/marketing` is the site.
- `packages/contracts` - Effect/Schema wire contracts plus small derived helpers. No heavy runtime logic.
- `packages/shared` - shared runtime utils, subpath exports, no barrel.
- `packages/client-runtime` - client connection and domain state shared by web and mobile.
- `.repos/` - vendored read-only references. Never edit or import from them (`vpr sync:repos` updates them; if sparse-checked-out, read via `git show origin/main:.repos/<path>`).

### Internal docs by area

Read the matching doc before changing code in that area; code review enforces them.

| Area                                       | Read first                                                                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture & orchestration               | [00_glossary.md](docs/internals/00_glossary.md), [01_architecture.md](docs/internals/01_architecture.md)                                                                                          |
| Server Effect services & errors            | [02_effect-services.md](docs/internals/02_effect-services.md)                                                                                                                                     |
| Providers & ACP                            | [03_providers.md](docs/internals/03_providers.md)                                                                                                                                                 |
| Auth, MCP, guest links, assets, security   | [04_environment-auth.md](docs/internals/04_environment-auth.md), [SECURITY.md](SECURITY.md)                                                                                                       |
| Remote routes, peer links, previews        | [05_remote.md](docs/internals/05_remote.md)                                                                                                                                                       |
| T3 Connect & relay                         | [06_t3-connect.md](docs/internals/06_t3-connect.md)                                                                                                                                               |
| Server updates & crash recovery            | [07_server-updates.md](docs/internals/07_server-updates.md)                                                                                                                                       |
| Telemetry & analytics                      | [08_product-analytics.md](docs/internals/08_product-analytics.md)                                                                                                                                 |
| Client connection & sync runtime           | [09_connection-runtime.md](docs/internals/09_connection-runtime.md)                                                                                                                               |
| Web UI primitives, styles & React Compiler | [10_web-ui.md](docs/internals/10_web-ui.md)                                                                                                                                                       |
| Mobile layout, navigation & dev lifecycle  | [11_mobile-layout.md](docs/internals/11_mobile-layout.md), [12_mobile-navigation.md](docs/internals/12_mobile-navigation.md), [13_mobile-development.md](docs/internals/13_mobile-development.md) |
| Translations & UI copy                     | [14_i18n.md](docs/internals/14_i18n.md)                                                                                                                                                           |
| Writing & reviewing tests                  | [15_testing.md](docs/internals/15_testing.md)                                                                                                                                                     |
| Wire budgets, server metrics & perf        | [16_performance-regressions.md](docs/internals/16_performance-regressions.md)                                                                                                                     |
| Repo & package scripts                     | [17_scripts.md](docs/internals/17_scripts.md)                                                                                                                                                     |

## Taste

- Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb.
- Client mutations use `createEnvironmentRpcCommand`, declare protected methods in `CLIENT_GUARDED_RPC_SCOPES`, and gate UI with `permissionAtom` (server stays authoritative). Keep raw RPC clients inside `rpc/`.
- Server features are Effect services using `Effect.fn("Service.operation")` with thin transport handlers; see [02_effect-services.md](docs/internals/02_effect-services.md).
- `apps/web/src/components/ui` exports own their look (`shadcn/no-restyle` enforces this); see [10_web-ui.md](docs/internals/10_web-ui.md).
- Inferred types over annotations. `any` is the enemy.
- Default to no comment. Write one only for a constraint, external quirk, or invariant the code can't show (1–4 lines max; `t3code/no-low-value-comments` enforces this).
- React effects are only for synchronizing with external systems. Derive in render and act in handlers; any remaining effect states its reason via `// oxlint-disable-next-line t3code/no-unreasoned-state-sync -- <why>`.
- No continuously repainting animations; they peg the GPU on high-refresh displays.
- Security matters, but do not over-index on dev-mode or maintainer-only features. Read [SECURITY.md](SECURITY.md) before auditing or triaging reports.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.
