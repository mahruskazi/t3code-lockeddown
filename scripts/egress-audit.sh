#!/usr/bin/env bash
# Egress audit for fork syncs: fail when a diff adds a network hostname that is
# not on the allowlist, and surface changes to files that control what leaves
# the machine (telemetry, updater, relay, cloud auth).
#
# Usage:
#   scripts/egress-audit.sh <base> <head>     audit added lines in base..head
#   scripts/egress-audit.sh --seed [<rev>]    print every hostname in the tree
#                                             at <rev> (default HEAD), for
#                                             seeding/refreshing the allowlist
#
# Exit codes: 0 clean (warnings allowed), 1 non-allowlisted hostname added,
# 2 usage or environment error.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
allowlist_file="$repo_root/scripts/egress-allowlist.txt"

# Only shipped code counts. Tests, docs, lockfiles, and the vendored read-only
# references in .repos never run on a user's machine.
code_pathspecs=(
  '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs' '*.sh' '*.swift' '*.kt' '*.rs'
  ':(exclude)*.test.ts' ':(exclude)*.test.tsx' ':(exclude)*.test.mjs'
  ':(exclude)*.integration.ts' ':(exclude)*.integration.test.ts'
  ':(exclude).repos/**' ':(exclude)docs/**' ':(exclude)experiments/**'
  ':(exclude)**/__tests__/**' ':(exclude)**/testing/**' ':(exclude)**/*.stories.tsx'
)

# Paths whose changes decide what the app sends off-machine. Any touch here is
# reported for human review even when no new hostname appears.
sensitive_paths=(
  'apps/server/src/telemetry/'
  'apps/server/src/cloud/'
  'apps/desktop/src/updates/'
  'apps/desktop/src/electron/ElectronUpdater.ts'
  'apps/mobile/src/features/updates/'
  'infra/relay/'
  'packages/shared/src/relayAuth.ts'
  'packages/shared/src/connectAuth.ts'
  'scripts/egress-audit.sh'
  'scripts/egress-allowlist.txt'
  '.github/workflows/'
)

# Code shapes that can hide an endpoint from the hostname scan.
suspicious_patterns='atob\(|fromCharCode|\beval\(|new Function\(|setFeedURL|Buffer\.from\([^)]*(base64|hex)'

extract_hostnames() {
  # stdin: text; stdout: unique lowercase hostnames from URL-shaped strings.
  grep -oiE '(https?|wss?)://[a-z0-9._-]+' | sed -E 's#^[a-z]+://##I' \
    | tr '[:upper:]' '[:lower:]' | sort -u
}

is_allowlisted() {
  local host="$1" entry
  while IFS= read -r entry; do
    entry="${entry%%#*}"
    entry="$(echo "$entry" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
    [ -z "$entry" ] && continue
    if [ "${entry#\*.}" != "$entry" ]; then
      local suffix="${entry#\*.}"
      [ "$host" = "$suffix" ] && return 0
      case "$host" in *."$suffix") return 0 ;; esac
    else
      [ "$host" = "$entry" ] && return 0
    fi
  done <"$allowlist_file"
  return 1
}

if [ "${1:-}" = "--seed" ]; then
  rev="${2:-HEAD}"
  git -C "$repo_root" grep -hIiE '(https?|wss?)://' "$rev" -- "${code_pathspecs[@]}" \
    | extract_hostnames
  exit 0
fi

if [ $# -ne 2 ]; then
  echo "usage: $0 <base> <head> | --seed [<rev>]" >&2
  exit 2
fi
if [ ! -f "$allowlist_file" ]; then
  echo "missing allowlist: $allowlist_file" >&2
  exit 2
fi

base="$1"
head="$2"

added_lines="$(git -C "$repo_root" diff "$base".."$head" -- "${code_pathspecs[@]}" \
  | grep -E '^\+' | grep -vE '^\+\+\+' | sed 's/^+//' || true)"

failures=0

echo "== Egress audit: $base..$head =="

# 1) New hostnames in shipped code must be allowlisted.
new_hosts="$(printf '%s\n' "$added_lines" | extract_hostnames || true)"
violations=""
for host in $new_hosts; do
  if ! is_allowlisted "$host"; then
    violations="$violations$host"$'\n'
  fi
done
if [ -n "$violations" ]; then
  failures=1
  echo ""
  echo "FAIL: added hostnames not on scripts/egress-allowlist.txt:"
  printf '%s' "$violations" | sed 's/^/  - /'
  echo ""
  echo "  Where they were added:"
  for host in $(printf '%s' "$violations"); do
    git -C "$repo_root" diff "$base".."$head" -- "${code_pathspecs[@]}" \
      | grep -nE "^\+.*$host" | head -3 | sed 's/^/    /'
  done
  echo ""
  echo "  Reject the change, or add the hostname to the allowlist in the same"
  echo "  commit with a comment saying why the app needs to reach it."
fi

# 2) Sensitive egress-controlling files: report every touch for human review.
touched="$(git -C "$repo_root" diff --name-only "$base".."$head" -- "${sensitive_paths[@]}" || true)"
if [ -n "$touched" ]; then
  echo ""
  echo "WARN: egress-sensitive files changed (review these hunks by hand):"
  printf '%s\n' "$touched" | sed 's/^/  - /'
fi

# 3) Obfuscation-capable patterns in added lines.
patterns_hit="$(printf '%s\n' "$added_lines" | grep -nE "$suspicious_patterns" | head -10 || true)"
if [ -n "$patterns_hit" ]; then
  echo ""
  echo "WARN: added lines match obfuscation-capable patterns (verify each):"
  printf '%s\n' "$patterns_hit" | sed 's/^/  /'
fi

echo ""
if [ "$failures" -ne 0 ]; then
  echo "RESULT: FAIL"
  exit 1
fi
echo "RESULT: PASS (warnings above, if any, need human eyes but do not block)"
