#!/bin/sh
# Install dependencies, build a local macOS T3 Code desktop app from this
# checkout, and install it into /Applications (or another application directory).
set -eu

usage() {
  cat <<'EOF'
Usage: scripts/install-macos-app.sh [options]

Build and install T3 Code from this source checkout.

Options:
  --arch <arm64|x64|universal>  Build architecture (default: current Mac)
  --destination <directory>     Application directory (default: /Applications)
  --skip-deps                   Skip `vp install --frozen-lockfile`
  --yes                         Replace an existing app without confirmation
  --help                        Show this help

The build uses a local preview version, which omits the release update feed so
this source-built app cannot replace itself with an upstream release.
EOF
}

fail() {
  echo "error: $*" >&2
  exit 1
}

ARCH=""
DESTINATION="/Applications"
SKIP_DEPS=0
ASSUME_YES=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --arch)
      [ "$#" -ge 2 ] || fail "--arch requires a value"
      ARCH="$2"
      shift 2
      ;;
    --destination)
      [ "$#" -ge 2 ] || fail "--destination requires a value"
      DESTINATION="$2"
      shift 2
      ;;
    --skip-deps)
      SKIP_DEPS=1
      shift
      ;;
    --yes)
      ASSUME_YES=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

[ "$(uname -s)" = "Darwin" ] || fail "this installer only supports macOS"
command -v vp >/dev/null 2>&1 || fail "Vite+ (vp) is required; see docs/operations/development.md"
command -v hdiutil >/dev/null 2>&1 || fail "hdiutil is required"
command -v ditto >/dev/null 2>&1 || fail "ditto is required"
command -v plutil >/dev/null 2>&1 || fail "plutil is required"

rust_is_supported() {
  rustc_path="$1"
  version="$("$rustc_path" --version 2>/dev/null | awk '{ print $2 }')"
  major="$(printf '%s' "$version" | cut -d. -f1)"
  minor="$(printf '%s' "$version" | cut -d. -f2)"
  case "$major:$minor" in
    *[!0-9:]*|:*) return 1 ;;
  esac
  [ "$major" -gt 1 ] || { [ "$major" -eq 1 ] && [ "$minor" -ge 95 ]; }
}

# The locked sysinfo release requires Rust 1.95. CI builds with stable Rust, but
# a developer's PATH may put an older Nix nightly ahead of an already-installed
# Homebrew stable toolchain.
if ! command -v rustc >/dev/null 2>&1 || ! rust_is_supported "$(command -v rustc)"; then
  for rust_bin in /opt/homebrew/opt/rust/bin /usr/local/opt/rust/bin; do
    if [ -x "$rust_bin/rustc" ] && rust_is_supported "$rust_bin/rustc"; then
      PATH="$rust_bin:$PATH"
      export PATH
      break
    fi
  done
fi
command -v cargo >/dev/null 2>&1 || fail "Cargo is required to build the resource monitor"
command -v rustc >/dev/null 2>&1 || fail "Rust 1.95 or newer is required"
rust_is_supported "$(command -v rustc)" ||
  fail "Rust 1.95 or newer is required (found $(rustc --version))"
echo "==> Using $(rustc --version)"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [ ! -f package.json ] || [ ! -f apps/server/package.json ]; then
  fail "$REPO_ROOT does not look like a T3 Code checkout"
fi

if [ -z "$ARCH" ]; then
  case "$(uname -m)" in
    arm64) ARCH="arm64" ;;
    x86_64) ARCH="x64" ;;
    *) fail "unsupported Mac architecture: $(uname -m)" ;;
  esac
fi

case "$ARCH" in
  arm64|x64|universal) ;;
  *) fail "unsupported architecture: $ARCH" ;;
esac

# A preview version deliberately suppresses electron-builder's release publish
# configuration. This keeps a source-built locked-down fork from auto-updating
# itself to an upstream release after installation.
BASE_VERSION="$(sed -n 's/^  "version": "\([^"]*\)",$/\1/p' apps/server/package.json | head -1)"
[ -n "$BASE_VERSION" ] || fail "could not read apps/server/package.json version"
BUILD_VERSION="${BASE_VERSION}-pr.local"
OUTPUT_DIR="$REPO_ROOT/release-local"
DMG_PATH="$OUTPUT_DIR/T3-Code-${BUILD_VERSION}-${ARCH}.dmg"

if [ "$SKIP_DEPS" -eq 0 ]; then
  echo "==> Installing dependencies from the pinned lockfile"
  vp install --frozen-lockfile
else
  echo "==> Skipping dependency installation"
fi

echo "==> Building macOS desktop app ($ARCH)"
vp run dist:desktop:dmg --arch "$ARCH" --build-version "$BUILD_VERSION" --output-dir "$OUTPUT_DIR"
[ -f "$DMG_PATH" ] || fail "build completed without producing $DMG_PATH"

MOUNT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/t3code-install-mount.XXXXXX")"
STAGED_APP=""
BACKUP_APP=""
DESTINATION_APP=""
MOUNTED=0
USE_SUDO=0

run_install() {
  if [ "$USE_SUDO" -eq 1 ]; then
    sudo "$@"
  else
    "$@"
  fi
}

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM

  if [ -n "$BACKUP_APP" ] && [ -e "$BACKUP_APP" ] && [ -n "$DESTINATION_APP" ] && [ ! -e "$DESTINATION_APP" ]; then
    echo "==> Restoring previous application after failed install" >&2
    run_install mv "$BACKUP_APP" "$DESTINATION_APP" || true
  fi
  if [ -n "$STAGED_APP" ] && [ -e "$STAGED_APP" ]; then
    run_install rm -rf "$STAGED_APP" || true
  fi
  if [ "$MOUNTED" -eq 1 ]; then
    hdiutil detach "$MOUNT_DIR" -quiet || true
  fi
  rmdir "$MOUNT_DIR" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

echo "==> Mounting $(basename "$DMG_PATH")"
hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT_DIR" "$DMG_PATH" >/dev/null
MOUNTED=1

SOURCE_APP=""
for candidate in "$MOUNT_DIR"/*.app; do
  if [ -d "$candidate" ]; then
    [ -z "$SOURCE_APP" ] || fail "DMG contains more than one application bundle"
    SOURCE_APP="$candidate"
  fi
done
[ -n "$SOURCE_APP" ] || fail "DMG does not contain an application bundle"

BUNDLE_ID="$(plutil -extract CFBundleIdentifier raw "$SOURCE_APP/Contents/Info.plist")"
[ "$BUNDLE_ID" = "com.t3tools.t3code" ] || fail "unexpected application bundle id: $BUNDLE_ID"

APP_NAME="$(basename "$SOURCE_APP")"
DESTINATION="${DESTINATION%/}"
[ -n "$DESTINATION" ] || DESTINATION="/"
DESTINATION_APP="$DESTINATION/$APP_NAME"
STAGED_APP="$DESTINATION/.${APP_NAME}.install.$$"
BACKUP_APP="$DESTINATION/.${APP_NAME}.backup.$$"

if [ -e "$DESTINATION_APP" ] && [ "$ASSUME_YES" -ne 1 ]; then
  printf 'Replace %s with this source build? [y/N] ' "$DESTINATION_APP"
  read -r answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) echo "Install cancelled."; exit 0 ;;
  esac
fi

if [ ! -d "$DESTINATION" ]; then
  parent="$(dirname "$DESTINATION")"
  if [ -w "$parent" ]; then
    mkdir -p "$DESTINATION"
  else
    command -v sudo >/dev/null 2>&1 || fail "$DESTINATION does not exist and sudo is unavailable"
    USE_SUDO=1
    run_install mkdir -p "$DESTINATION"
  fi
elif [ ! -w "$DESTINATION" ]; then
  command -v sudo >/dev/null 2>&1 || fail "$DESTINATION is not writable and sudo is unavailable"
  USE_SUDO=1
fi

# Do not replace an application that is currently executing. The script never
# kills processes; the user remains in control of when T3 Code exits.
EXECUTABLE_NAME="$(plutil -extract CFBundleExecutable raw "$SOURCE_APP/Contents/Info.plist")"
if pgrep -x "$EXECUTABLE_NAME" >/dev/null 2>&1; then
  fail "T3 Code is running; quit it and run this installer again"
fi

run_install rm -rf "$STAGED_APP" "$BACKUP_APP"
echo "==> Staging $APP_NAME"
run_install ditto "$SOURCE_APP" "$STAGED_APP"
[ -x "$STAGED_APP/Contents/MacOS/$EXECUTABLE_NAME" ] || fail "staged application is incomplete"

if [ -e "$DESTINATION_APP" ]; then
  run_install mv "$DESTINATION_APP" "$BACKUP_APP"
fi
run_install mv "$STAGED_APP" "$DESTINATION_APP"
STAGED_APP=""

if [ -e "$BACKUP_APP" ]; then
  run_install rm -rf "$BACKUP_APP"
fi
BACKUP_APP=""

echo
echo "Installed: $DESTINATION_APP"
echo "Artifact:  $DMG_PATH"
echo "Version:   $BUILD_VERSION"
echo
echo "This local build is not notarized. If macOS blocks the first launch,"
echo "right-click the app in Finder and choose Open."
