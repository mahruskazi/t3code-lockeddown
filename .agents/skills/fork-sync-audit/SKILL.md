---
name: fork-sync-audit
description: Forward the mahruskazi/t3code-lockeddown fork onto upstream pingdotgg/t3code main and security-audit the newly pulled-in commits for network egress before pushing. Use when asked to sync, update, fast-forward, or pull upstream into the fork, or to audit an upstream delta for telemetry, exfiltration, or new endpoints.
---

# Fork Sync + Egress Audit

This fork exists so its owner can review every change that could send data off
the machine before adopting it. Syncing and auditing are one task: never push a
sync whose delta you have not audited, and report the audit findings in the
same reply that reports the push.

## Baseline: what egress is already known and accepted

Established by the 2026-08 full audit. Anything NOT on this list that sends
data anywhere is a finding.

- **PostHog telemetry, ON by default** (`apps/server/src/telemetry/AnalyticsService.ts`
  → `us.i.posthog.com`). Sends event names, provider/model names, counts, OS
  platform — no code, prompts, or paths. `Identify.ts` reads
  `~/.codex/auth.json` / `~/.claude.json` and sends a SHA-256 hash of the
  account ID as the distinct ID. Opt-out: `T3CODE_TELEMETRY_ENABLED=false`.
- **Relay client tracing to `api.axiom.co`**: compiled in only when a build
  bakes URL + dataset + token (official builds); source builds have no token,
  so it is inert. Scoped to T3 Connect relay-connection spans.
- **Web client traces** post only to the user's own T3 server
  (`/api/observability/v1/traces`), not to a third party.
- **Opt-in / user-triggered**: T3 Connect relay + Clerk auth, cloudflared
  tunnel, forge APIs (GitHub/GitLab/Bitbucket/Azure), npm registry for
  provider CLI updates, Open VSX theme search, Expo OTA updates,
  electron-updater against GitHub releases (`T3CODE_DISABLE_AUTO_UPDATE`).
- OTLP export from the server is off unless `otlpTracesUrl`/`otlpMetricsUrl`
  are set. Web and mobile clients ship no analytics SDKs and no crash
  reporters.

## Sync procedure

1. `git remote add upstream https://github.com/pingdotgg/t3code` (ignore
   "already exists"), then `git fetch upstream main --no-tags`.
2. Record the merge base: `base=$(git merge-base origin/main upstream/main)`.
   Sanity-check the fork has no content drift:
   `git diff $base..origin/main --stat` should be empty (this fork carries
   its own files — this skill, `scripts/egress-audit.sh`,
   `scripts/egress-allowlist.txt`, `.github/workflows/egress-audit.yml` — so
   those appearing is expected; anything else, stop and ask).
3. **Audit before pushing** (next section). Only proceed to push on PASS or
   on warnings you have personally verified and can explain.
4. Merge, preserving the fork's convention of merge commits:
   `git checkout main && git merge --ff-only origin/main` (refresh local),
   then `git merge upstream/main -m "Merge branch 'pingdotgg:main' into main"`.
   Conflicts should only ever touch the fork-owned files above; resolve by
   keeping the fork's versions and re-applying upstream's intent if it
   changed the same area.
5. `git push -u origin main` (retry on network failure with backoff).

## Audit procedure

Run the same check CI runs, over the full incoming range:

```sh
scripts/egress-audit.sh "$base" upstream/main
```

- **FAIL (non-allowlisted hostname added)**: read the diff hunks the script
  prints. Decide: benign (docs link, test fixture that slipped the path
  filters, demo data) → add to `scripts/egress-allowlist.txt` with a comment,
  in the sync commit, and say so in your report. Real new egress → do NOT
  push; report the finding with file:line, what is sent, when it fires, and
  whether it is opt-in.
- **WARN (egress-sensitive files changed)**: read every changed hunk in those
  files — telemetry, updater, cloud/relay, and this tooling itself. Answer
  for each: does it change *what* is sent, *where* it goes, or *when* it is
  on? A moved line is fine; a new `.record(` call needs its properties read;
  a changed default (e.g. telemetry enabled flag, feed URL, baked trace
  config) is a finding even with no new hostname.
- **WARN (obfuscation patterns)**: `atob`/`eval`/`new Function`/base64
  decoding near anything network-shaped is a finding until proven otherwise;
  known-benign uses today are Clerk publishable-key decoding
  (`packages/shared/src/relayAuth.ts`) and ANSI/NUL char constants.
- Also scan beyond the script's reach when the delta warrants it:
  `pnpm-lock.yaml` changes mean new/updated dependencies — list any brand-new
  packages in the report; changes under `.github/workflows/` can exfiltrate
  secrets in CI and deserve a read even though they never ship to users.

The hostname check only sees added lines in shipped code (tests, docs,
`.repos/`, `experiments/` are excluded). Deletions and moved-unchanged lines
never fail it; brand-new egress mechanisms that construct URLs dynamically are
exactly what the WARN sections exist to catch — do not skip them.

## Report format

Lead with the verdict: pushed or blocked, and why. Then: commit count and
range synced, audit result (new hostnames with disposition, sensitive-file
review conclusions, new dependencies), and any allowlist changes made. Keep
the accepted-egress baseline above up to date — if a sync legitimately
changes it (new documented telemetry, a removed endpoint), update this file
in the same commit.
