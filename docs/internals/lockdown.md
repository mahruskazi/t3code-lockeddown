# Lockdown

This fork removes every network path that leaves the machine on the app's own
initiative, and every configuration knob that could turn one back on. The goal
is a build that runs correctly with no internet connection and cannot be
made to phone home by flipping a setting.

## What was removed

| Area | What it did | Status |
| --- | --- | --- |
| PostHog analytics | Buffered anonymous events and POSTed them to `us.i.posthog.com` on a 1s flush loop. On by default with a hardcoded project key. | Deleted (`apps/server/src/telemetry/`) |
| OTLP export | Forwarded server, desktop, and browser spans/metrics to a configured collector; mobile shipped an Axiom default. | Exporters deleted. Tracing still writes to the local rotating trace file. |
| T3 Connect | Clerk auth, the relay, managed Cloudflare tunnels, CLI OAuth, device linking, agent-activity publishing. | Deleted, including `infra/relay` and the `t3 connect` command group. |
| Server self-update | Downloaded pinned runtimes and `t3@<version>` from npm, then restarted through a launcher. | Deleted, along with the launcher/rollback protocol. |
| Desktop auto-update | electron-updater checked GitHub releases and downloaded installers. | Deleted, along with update channels and the update UI. |
| Provider update checks | Queried `registry.npmjs.org` for provider CLI versions. | The fetch is gone; advisories report the installed version and the manual update command. |
| Tailscale | `--share`, `--tailscale`, Tailscale Serve exposure, tailnet endpoint discovery. | Deleted (`packages/tailscale`). |
| Remote/LAN access | `--host`, `T3CODE_HOST`, desktop "network accessible" mode, advertised LAN/tunnel endpoints. | Deleted. The server binds `127.0.0.1`. |
| Mobile app | Only useful against a remotely reachable server, and built entirely on the removed relay stack. | Deleted (`apps/mobile`). |
| Hosted web app | `app.t3.codes` static mode and its hosted pairing flow. | Deleted. |
| Google favicon service | Fetched `google.com/s2/favicons` for every host linked in chat and for preview tabs — leaking browsing to a third party. | Deleted; the bundled globe icon is used instead. |

## What still reaches the network

These are user-initiated and point at hosts the user already chose:

- **Provider CLIs** (Claude Code, Codex, Cursor, Grok, OpenCode) talk to their
  own vendors. That is the product's purpose; T3 Code only spawns them.
- **Git, `jj`, and `gh`** run as they always have.
- **Source-control providers** (GitHub, GitLab, Bitbucket, Azure DevOps) are
  queried only when a project is configured against them.
- **SSH environments** connect out to hosts the user configures.
- **The preview browser** navigates where the user or agent tells it to.

## Invariants worth keeping

- `ServerConfig` has no `host` field. `LOOPBACK_HOST` in
  `apps/server/src/config.ts` is the single bind address.
- `ObservabilityLive` has no exporter delegate. Spans go to the local trace
  file and nowhere else.
- `scripts/lib/public-config.ts` merges `.env` files and injects nothing. If a
  build ever needs to bake in a remote endpoint again, that is the file that
  would have to change.
- `t3 service install` writes a systemd unit that execs the installed entry
  point directly. It must never download a runtime.
