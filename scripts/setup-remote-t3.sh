#!/bin/sh
# Sync this T3 Code checkout to a remote host over SSH, build the server
# there, and install a `t3` shim on the remote PATH so the desktop app's
# SSH launcher runs this fork instead of installing `t3` from npm.
#
# [fork:lockdown] The SSH launcher's remote runner only ever execs a `t3`
# already on PATH; this fork removed the npm/npx fallback entirely, so an
# unprovisioned host fails loudly instead of pulling upstream's package.
#
# Usage:
#   scripts/setup-remote-t3.sh <ssh-host> [remote-dir]
#
#   <ssh-host>    SSH destination or config alias, e.g. coder.my-workspace
#   [remote-dir]  Checkout location on the remote (default: ~/t3code)
#
# Idempotent: re-run after pulling fork updates to resync and rebuild.
# After a rebuild, disconnect and reconnect the environment in the desktop
# app so the launcher restarts the server from the new build.
set -eu

HOST="${1:?usage: setup-remote-t3.sh <ssh-host> [remote-dir]}"
REMOTE_DIR="${2:-t3code}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$(sed -n 's/^  "name": "\(.*\)",$/\1/p' "$REPO_ROOT/apps/server/package.json" | head -1)" != "t3" ]; then
  echo "error: $REPO_ROOT does not look like a T3 Code checkout" >&2
  exit 1
fi

PNPM_VERSION="$(sed -n 's/^  "packageManager": "pnpm@\(.*\)",$/\1/p' "$REPO_ROOT/package.json")"
if [ -z "$PNPM_VERSION" ]; then
  echo "error: could not read pnpm version from package.json" >&2
  exit 1
fi

echo "==> Syncing source to $HOST:$REMOTE_DIR"
rsync -az --delete --info=stats1 \
  --exclude '.git/' \
  --exclude '.repos/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude 'release-app/' \
  --exclude '.t3/' \
  --exclude '.expo/' \
  --exclude '.DS_Store' \
  "$REPO_ROOT/" "$HOST:$REMOTE_DIR/"

echo "==> Building on $HOST"
ssh "$HOST" sh -s -- "$REMOTE_DIR" "$PNPM_VERSION" <<'REMOTE'
set -eu
REMOTE_DIR="$1"
PNPM_VERSION="$2"

PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"

if ! command -v mise >/dev/null 2>&1; then
  echo "error: mise not found on remote. Install it first:" >&2
  echo "  curl -fsSL https://mise.run | sh" >&2
  exit 1
fi

mise use -g "node@24" "pnpm@$PNPM_VERSION" >/dev/null

if ! command -v cc >/dev/null 2>&1 && ! command -v gcc >/dev/null 2>&1; then
  echo "warning: no C compiler found; node-pty may fail to build" >&2
fi

cd "$HOME/$REMOTE_DIR"
echo "--> pnpm install (node $(node --version), pnpm $(pnpm --version))"
pnpm install --frozen-lockfile

echo "--> building web client"
pnpm --dir apps/web run build

echo "--> building server bundle"
pnpm --dir apps/server run build:bundle

mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/t3" <<SHIM
#!/bin/sh
NODE="\$HOME/.local/share/mise/shims/node"
[ -x "\$NODE" ] || NODE=node
exec "\$NODE" "\$HOME/$REMOTE_DIR/apps/server/dist/bin.mjs" "\$@"
SHIM
chmod 755 "$HOME/.local/bin/t3"

echo "--> shim installed: $HOME/.local/bin/t3 -> $HOME/$REMOTE_DIR/apps/server/dist/bin.mjs"
"$HOME/.local/bin/t3" --version || true
REMOTE

echo
echo "Done. Disconnect and reconnect the environment in the desktop app so"
echo "the SSH launcher restarts the server from this build."
