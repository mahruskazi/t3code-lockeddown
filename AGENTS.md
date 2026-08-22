# T3 Code

T3 Code is a minimal GUI for coding agents. A Node WebSocket server wraps provider CLIs (Codex, Claude Code, Cursor, Grok, OpenCode) and serves web, desktop, and mobile clients.

You can think of T3 Code as an open source "bring-your-own-subscription" alternative to apps like Claude Desktop, Codex App, Cursor Glass and Conductor.

> **This checkout is `t3code-lockeddown`, a hardened fork.** It runs against proprietary company code, under one rule upstream does not hold: no code and no prompts leave the machine except through an authorized provider harness. Read [This is a locked-down fork](#this-is-a-locked-down-fork) before merging anything from upstream.

## What makes T3 Code special?

We have over 200,000 users who love T3 Code. It's important we maintain the things they love as we continue to iterate on the product. Here's a brief list of the things we can never compromise on.

### 1. Open at the core

T3 Code is truly open. We share our roadmap, we share how we think about things, and of course we share all our code. A large number of our users run forks. We work in the open, and should strive to stay that way.

### 2. Performance without compromise

Lots of apps have gotten bogged down with bad tech decisions and "slop". We have not, and we're proud of the performance of T3 Code. We regularly audit for performance regressions, often caused by sending too much data over websockets, css animations causing gpu spikes, lists being hard to render, and more. Make sure all changes are considerate of performance impact.

### 3. Remote ready

The architecture of T3 Code's websocket layer (npx t3) enables a lot of awesome remote features. These have become core to the product. Whether users are connecting directly over their local network, using Tailscale, or leaning in fully with T3 Connect (our tunnel solution, also in this repo), we need to make sure new features are properly supported.

### 4. Multi-surface

T3 Code has 3 key app surfaces: **web**, **desktop**, and **mobile**.

**Web** is kind of two surfaces, as we have the public facing "app.t3.codes" as well as locally hosting the web app through the `npx t3` command. Both need to be supported by all new features where reasonable.

**Desktop** is the main surface most users install first. It's a full Electron app that bundles the server runner as well. The desktop app can also be used as the host server, allowing remote connections from app.t3.codes or the mobile app.

**Mobile** is a React Native app for both iOS and Android, available on the App Store and Google Play. The mobile app allows for connecting to any T3 Code server to control work remotely.

## A note from Theo

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be able to override anything here.

Of note: Most T3 Code contributions will come from T3 Code itself, often controlled remotely. This means you should be careful about accessing data, killing dev servers, and other things that may damage the T3 Code instance that the contributor is using.

## A small glossary

We need to be on the same page with terminology. When communicating, use this language:

- **you** means the agent reading this file and changing T3 Code.
- **we, us, and maintainers** mean Theo, Julius and the people building T3 Code. These are who you are talking to now.
- **user** means the person using T3 Code to direct coding agents.
- **agent** means the coding agent a user runs inside T3 Code. Depending on context, that may also include you.
- **provider** means the agent runtime or harness T3 Code talks to, such as Codex, Claude, Cursor, or OpenCode.
- **client** means the web, desktop, or mobile UI.
- **environment** means one running T3 server and the machine, filesystem, provider credentials, and state it owns.
- **project** means an environment-local workspace record rooted at a directory.
- **thread** means the durable conversation and work history for a project.
- **turn** means one user-to-agent cycle, including follow-up work such as checkpointing.
- **T3 home** means the base data directory. Runtime state normally lives below its userdata directory.

## The three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path, or worktree string. Your own agent process has this worktree's path in its argv, and this machine runs several other dev servers at once. Kill only a PID you captured at spawn, or the owner of your port from `ss -H -ltnp` after confirming `/proc/<pid>/cwd` is your worktree.
2. **Writing to the live install.** `~/.t3/userdata` is the developer's real T3 Code database, in use while you work. Reading it and copying from it are fine, and a good way to get real test data (see Test data). Never start a server against it, never open it read-write, never clean it up.
3. **Baking in origins.** Never set `VITE_HTTP_URL` or `VITE_WS_URL` for dev. Dev is single-origin and Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known`. Setting them bakes localhost into the bundle and silently breaks every remote browser.

## Hit every surface

The most common defect in this repo is a change that works on the path you tested and is missing everywhere else. Before calling frontend work done, walk this list and say which entries applied:

- **Entry points.** A behavior reachable from the chat view is usually also reachable from Settings, the command palette, and a keybinding. Fixing one is not fixing the feature.
- **Clients.** Web, desktop (wraps web, adds Electron shell/IPC), and mobile (React Native, separate navigation). Shared logic lives in `packages/client-runtime`
- **Providers.** Codex, Claude, Cursor, Grok, and OpenCode each have an adapter. Provider-shaped features need a decision per adapter, even if the decision is "not supported here".
- **Contracts.** Anything crossing the wire is typed in `packages/contracts`. Change the schema and the server, web, mobile, and desktop all follow.
- **Reverse states.** If you added a way in, add the way out and the way to see it. Snooze needs unsnooze. Close needs reopen. A one-way door is a bug.
- **Connection modes.** Local, remote/relay, and tunnel behave differently. Multi-device and multi-environment cases are real.
- **Docs.** `docs/` splits by audience. Behavior changes that a user would notice belong in `docs/user/` (shipped-product voice, no repo tooling or source paths); architecture and contributor changes in `docs/internals/`; runbooks in `docs/operations/`; new vocabulary in `docs/internals/glossary.md`.

## Dev servers

- `vp i` installs. Worktrees get this from the t3.json setup script; if module resolution looks broken, it probably did not run.
- `vp run dev` starts server and web. In a worktree, state defaults to that worktree's gitignored `.t3`, which deliberately outranks an ambient `T3CODE_HOME` so you cannot land on shared state by accident. An explicit `--home-dir` still wins.
- Ports derive from the worktree path and are stable across restarts, but read the real ones from the `[dev-runner]` line since occupied ports shift.
- Sharing over the tailnet is three steps: run `vp run dev --share` in the background, wait for the `pairingUrl:` line in its output, paste that full URL (token included) in your reply. Do not wire up `tailscale serve` by hand for this, and do not open the URL yourself.
- The web app requires pairing. Hand over the pairing URL, not the bare origin. A URL without its token is useless to whoever you gave it to. If the token got consumed, mint a fresh one with `node apps/server/src/bin.ts pair` — note it carries standard scopes, while the startup URL carries admin scopes (needed for Settings → Connections management).
- Stop what you started, by the PID you tracked. See rule 1.

## This is a locked-down fork

`mahruskazi/t3code-lockeddown` is a fork of `pingdotgg/t3code` that exists for one reason: **it is safe to point at proprietary company code and data.** The agents running inside this app read confidential repositories, credentials sit in the environments it connects to, and everything an agent sees passes through this server.

Upstream is a healthy, fast-moving open source project with a large contributor base and bot-authored commits. That is good for upstream's users and it is exactly why we do not track it blindly: every line we merge gains the same access to that data as the lines we wrote ourselves.

### The rule

**No code and no prompts leave this machine, except through an authorized provider harness.**

The authorized path is the one the product exists for: a provider CLI — Codex, Claude Code, Cursor, Grok, OpenCode, Pi — sending a turn to its own model API under the operator's own subscription. That is a deal the operator already made with that vendor deliberately, and it is the only channel that may carry source code, diffs, file contents, terminal output, or prompt text off this machine.

Everything else is a leak, including the well-meant kind: analytics, crash reporting, "anonymous" usage pings, remote log shipping, a debug endpoint, a prefetch, a provider adapter that quietly widens what it puts in a payload. Intent does not enter into it. A host we did not choose receiving bytes we did not review is the failure, whether it got there by an attacker, a contributor, or a dependency.

Two things follow, and they are why the invariants below exist:

- **Code we did not choose must not run here.** Anything fetched and executed gets the same access to the data as our own code, so a runtime download is an egress path with extra steps.
- **The rule binds the merged tree, not our commits.** Upstream code ships into the same process with the same access. That is what the audit process below is for.

### Where data legitimately goes

Every outbound path this fork has, and what it may carry. A path that is not on this list is a finding.

| Path | Carries code or prompts | Status |
| --- | --- | --- |
| Provider CLIs (Codex, Claude Code, Cursor, Grok, OpenCode, Pi) | Yes — this is the authorized harness | The product |
| Source-control hosts (GitHub, GitLab, Bitbucket, Azure DevOps) | Yes — but to the repo's own remote, under the operator's credentials | Authorized |
| T3 Connect relay (`app.t3.codes` plus a cloudflared tunnel) | Yes — the entire session | Opt-in per environment via `t3 connect`, never on by default. See the note below. |
| `t3 triage` diagnostic issue (public issue on `pingdotgg/t3code`) | Yes — logs, DB contents, terminal output | **Removed** — invariant 4 |
| PostHog analytics | Event metadata | **Removed** — invariant 1 |
| npm registry, at runtime | No, but pulls executable code onto the machine | **Removed** — invariants 2 and 3 |
| `cloudflared` binary download | No, but is an executable | Pinned version, sha256-verified, fetched only when the operator turns on T3 Connect (`packages/shared/src/relayClient.ts`) |
| litellm pricing table (`raw.githubusercontent.com`) | No — a rates JSON, cached for a day | Read-only fetch (`apps/server/src/usage/UsageService.ts`) |
| Open VSX theme search (`open-vsx.org`) | No — a theme query from the web client | Read-only fetch (`apps/web/src/openVsxThemes.ts`) |
| OTLP traces and metrics export | No — span metadata, but includes workspace and worktree paths | Operator-configured, off by default. See the note below (`apps/server/src/observability/Layers/Observability.ts`) |
| Hosted app auth (`app.t3.codes`, Clerk) | No — account identity | Only on the hosted-web and relay paths |

**T3 Connect is the open one.** This fork has not disabled it, and it is the one available path that would carry everything — code, prompts, diffs, terminal output — through a third party. It takes a deliberate `t3 connect` to start, so nothing leaks by accident, but enabling it on a machine holding proprietary code is an authorization decision, not a convenience. Local network and Tailscale reach the same clients without it. If we ever decide the relay is out of bounds here, that becomes a fifth invariant with a choke point and a tripwire, like the four below.

**OTLP export is the other operator switch.** Setting `otlpTracesUrl` or `otlpMetricsUrl` makes the server forward its spans to that URL every ten seconds, alongside the local `server.trace.ndjson` it always writes. The spans carry operation names, provider kind, model names, thread and turn ids, and attachment counts — not prompt text, file contents, diffs, or terminal output. They do carry `terminal.cwd`, `checkpoint.cwd`, and `claude.query.cwd`, so a collector learns the paths of the repositories worked on here, which is enough to identify projects and clients. Nothing filters span attributes; the only redaction in the pipeline covers HTTP header names. Both settings are empty by default and are set from `settings.json` or `T3CODE_OTLP_*`, never from the Settings UI, which only reports whether export is on. Pointing them at a collector on a machine holding proprietary code is an authorization decision, the same shape as T3 Connect.

### The invariants

The rule above is enforced in review. These four leak paths are closed in code instead, so they cannot come back quietly. They are invariants, not preferences. Restoring any of them is a regression no matter how the change arrives — an upstream merge, a dependency bump, a "harmless" revert. Every touch point carries a `[fork:lockdown]` marker:

```
git grep -n "fork:lockdown"   # every lockdown touch point, at any time
```

1. **No telemetry leaves the machine.** `apps/server/src/telemetry/AnalyticsService.ts` binds the live layer to the no-op service, so the PostHog client is never constructed, no flush fiber runs, no identity file is read, and no environment variable can turn sending back on. Tripwire: `AnalyticsService.test.ts` enables telemetry in config and asserts zero outbound requests.
2. **No executable code arrives from the npm registry at runtime.** `apps/server/src/cloud/pinnedRuntime.ts` is the single choke point covering both server self-update and boot-service installs. Upstream downloads `t3@<version>` on demand; this fork reuses a complete runtime already on disk and hard-errors otherwise, so an update can only ever run a build we provisioned. Tripwires: `pinnedRuntime.test.ts` (a process runner that dies on any spawn) and `selfUpdate.test.ts`.
3. **Remote hosts run our build, never a published package.** Upstream's SSH launcher falls back to `npx t3@<version>` when no `t3` is on the remote PATH. This fork removes that fallback entirely (`REMOTE_RUNNER_SCRIPT` in `packages/ssh/src/tunnel.ts`) and fails with provisioning instructions instead. Tripwire: `tunnel.test.ts` asserts the generated script contains no npm or npx exec path. See below for how provisioning works.
4. **Diagnostic bundles never leave the machine.** Upstream ships `t3 triage` (`apps/server/src/cli/triage.ts`), which seeds a local coding agent to investigate the state database, provider event log, and terminal logs, then file the findings as a public issue on `pingdotgg/t3code`. Here that evidence *is* the proprietary material, and upstream's redaction step covers credentials and home paths but not source, prompt text, or repo identities. This fork does not register the command and does not carry its playbook or issue template. Tripwire: `bin.test.ts` asserts `triage` is absent from the CLI.

The Pi provider is a separate fork concern with its own marker and document: `git grep -n "fork:pi"` and `docs/internals/fork-pi-provider.md`.

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
- **The invariant files themselves.** Anything under `apps/server/src/telemetry/`, `apps/server/src/cloud/`, or `packages/ssh/`, plus the CLI registration in `apps/server/src/bin.ts`. Conflicts here are expected and always resolve toward the fork.
- **Anything that reads outside the workspace.** Environment variables, `~/.t3` state, secrets, SSH config, git credentials — especially where the value then flows into a request body, a log line, or a provider prompt.
- **Provider adapters.** A new endpoint or a widened prompt payload changes where our source code gets sent. The harness is authorized; an adapter sending more than the turn to somewhere else is not.
- **CI and build config.** `.github/workflows`, build scripts, and Electron entitlements can exfiltrate or weaken the shipped app without touching product code.
- **Auth, pairing, and permission paths.** Anything that widens who can connect, or what a connected client may do, is a data-access change.

Then, before pushing the merge:

- Run the tripwires: the telemetry, pinned-runtime, self-update, tunnel, and CLI-registration tests above. They are the automated half of this audit and they must pass on the merged tree, not just on the fork's side.
- Confirm `git grep -n "fork:lockdown"` still finds every marker — a vanished marker means an upstream hunk overwrote a lockdown edit.
- If something in the diff is unclear, it does not merge until it is understood. "Probably fine" is not an audit result.

### Remote environments (Coder / SSH)

This fork is deployed to remote SSH hosts (e.g. Coder workspaces) from the local checkout, never from the published npm package. Provisioning works like this:

- `scripts/setup-remote-t3.sh <ssh-host> [remote-dir]` rsyncs this checkout to the remote, builds `apps/server/dist/bin.mjs` there (mise-pinned node 24 + repo pnpm, `--frozen-lockfile`), and installs a `~/.local/bin/t3` shim pointing at that build. The launcher finds the shim via its `command -v t3` branch.
- The script is idempotent: re-run it after changing the fork, then disconnect and reconnect the environment in the desktop app so the launcher restarts the server from the new build.
- Do not reintroduce the npm install fallback — it would silently swap this fork's server for the upstream published one on any unprovisioned host, which is invariant 3.
- The remote host needs mise (`curl -fsSL https://mise.run | sh`) and a C toolchain for node-pty; everything else the script handles.

## Test data

An empty database is a bad test. Seed your worktree's `.t3` with a copy of real data instead of pointing at live state:

- Copy from `~/.t3/userdata` (the developer's real data, the most realistic test set) or `~/.t3/dev`. Worktree state lives at `<worktree>/.t3/userdata`.
- Snapshot the database with `VACUUM INTO`, which is safe even while a server has the source open and yields one consistent file:

  ```bash
  mkdir -p .t3/userdata
  rm -f .t3/userdata/state.sqlite*  # VACUUM INTO refuses to overwrite
  bun -e "new (require('bun:sqlite').Database)(process.env.HOME + '/.t3/userdata/state.sqlite', { readonly: true }).run(\"VACUUM INTO '.t3/userdata/state.sqlite'\")"
  ```

  A plain `cp` is only safe when no server has the source open, and must bring the `-wal` and `-shm` siblings along. A live file copy is a corrupt copy.

- Bring `secrets` and `settings.json` only if the flow under test needs them.
- Copy in, never symlink. Data flows one way: into your sandbox, never back out.

## Verifying

- Smallest proof that the change works. `vp test run <files>` for the tests you touched, targeted lint and typecheck for the scope you changed.
- **Do not run repo-wide checks.** No `vp check`, no `vp run -r test`, no `vp run -r typecheck` unless I ask. CI owns the full suite.
- Backend behavior changes ship with focused tests for that behavior.
- The server is event-sourced and its async flows emit typed receipts. Wait on receipts and worker drains, never on sleeps or polling. A test that needs a timeout to pass is wrong.
- Upon request, user-visible frontend changes should get one integrated pass in a real client: `test-t3-app` for web, `test-t3-mobile` for mobile. The primary agent does this once after integrating. Subagents do not launch their own dev servers. Ask permission before doing computer use or spinning up browsers.

## Pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- UI changes need before/after images. Motion or timing needs a short video.
- Upload PR evidence to GitHub. Never commit PR-only screenshots or assets such as `.github/pr-assets/`.
- One concern per PR. If the description says "also", split it.
- When babysitting: poll checks and comments newer than the last push, verify each bot finding against the source, fix real ones, dismiss false positives with a written reason. Stay quiet when nothing is new. Stop when the bots are green on the latest commit.

## Plans and work artifacts

- Do not commit implementation plans, research notes, or agent scratch files. Keep temporary working material outside the worktree. `.plans/` is gitignored only as a safety net for legacy tooling.
- Track active maintainer work in the GitHub issue or project item that owns it. External proposals follow `CONTRIBUTING.md` and belong in Ideas discussions.
- Put durable architecture, constraints, and decisions in `docs/internals/`. Update those docs when the product changes so agents find current facts instead of abandoned intentions.
- A merged PR is the implementation record. Close or update its tracking item when the work lands; do not preserve a second checklist in the repository.

## How it works

Clients send typed WebSocket requests. The server turns them into _commands_, a pure _decider_ turns commands into persisted _events_, and a _projector_ derives the read model the UI renders. Provider CLIs run as subprocesses; per-provider _adapters_ translate their native protocols into orchestration events. Side effects run in queue-backed _reactors_ that emit _receipts_ when milestones land. Each turn ends with a _checkpoint_, a hidden git ref, so the app can diff and restore.

Full glossary with file links: `docs/internals/glossary.md`

## Where code lives

- `apps/server` - WebSocket, orchestration, providers, checkpointing. Effect-heavy: read `.repos/effect-smol/LLMS.md` before writing Effect code.
- `apps/web` - React/Vite UI. `apps/desktop` wraps it, `apps/mobile` is React Native, `apps/marketing` is the site.
- `packages/contracts` - Effect/Schema contracts plus small derived helpers. No heavy runtime logic.
- `packages/shared` - shared runtime utils, subpath exports, no barrel.
- `packages/client-runtime` - client code shared by web and mobile.
- `.repos/` - vendored read-only references. Prefer their patterns over invented ones. Never edit or import from them. Sync with `vpr sync:repos` when bumping the matching dependency.

## Taste

- Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb.
- Inferred types over annotations. `any` is the enemy.
- Comments describe how a thing is used, and move when the code moves. To be used mostly to describe functions, not to annotate every line of behavior.
- Our users drive agents all day and notice a dropped frame, a lying spinner, and a stale label. No continuously repainting animations; they peg the GPU on high-refresh displays.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.

## Additional tips

- Don't verify with browsers or computer use unless the user explicitly agrees or requests it.
- Security is important, but should not be over-indexed on, especially for dev mode/maintainer-only features.
