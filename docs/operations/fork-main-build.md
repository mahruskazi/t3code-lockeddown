# Fork main build

`.github/workflows/fork-main-build.yml` builds every push to `main` and replaces the rolling
`main-build` prerelease with:

- `T3-Code-<version>-arm64.zip` and `.dmg`: the Apple Silicon desktop app.
- `t3-<version>-linux-x64.tar.gz` and `t3-<version>-linux-arm64.tar.gz`: self-contained `t3`
  server archives for remote hosts.
- `SHA256SUMS.txt`, and `main-build.json`, the manifest the desktop updater reads.

Versions are `<apps/desktop version>-main.<run number>`, so each build is newer than the last.
The repository is public, so Actions minutes are free. `workflow_dispatch` builds any branch, but
only `main` publishes. Builds are ad-hoc signed and not notarized: the first install needs
**System Settings → Privacy & Security → Open Anyway**. Do not turn off Gatekeeper.

## Desktop updates

A build from this workflow has `url: https://github.com/mahruskazi/t3code-lockeddown/releases/download/main-build`
in its `app-update.yml`. On macOS, `ElectronForkUpdater` recognizes that exact URL and replaces
electron-updater, whose Squirrel.Mac install refuses an ad-hoc signed update. The usual update
pill and **Settings → Maintenance → Updates** still check, download and install.

Downloading saves the zip into `.t3code-update` beside the app and checks its sha256 against
`main-build.json`. It then checks that the extracted app passes `codesign --verify --deep
--strict` and has the running app's bundle id and the offered version. Install starts a detached
helper and quits. The helper waits for the app to exit, swaps the bundles with two renames, and
opens the new one. If the move or the launch fails, it puts the old app back. The folder holding
the app must be writable, and the app must not be running from a translocated location.

Builds from any other source, local builds included, keep upstream's updater. A managed-policy
`feedUrl` does not apply to fork builds.

## Remote hosts

The SSH launcher runs the `t3` on the remote `PATH` and never downloads one (invariant 3). To use a
prebuilt archive instead of `scripts/setup-remote-t3.sh`, install it on the host yourself:

```sh
gh release download main-build -R mahruskazi/t3code-lockeddown -p 't3-*-linux-x64.tar.gz' -p SHA256SUMS.txt
grep linux-x64 SHA256SUMS.txt | sha256sum -c -
rm -rf ~/.local/share/t3 && mkdir -p ~/.local/share/t3 ~/.local/bin
tar -xzf t3-*-linux-x64.tar.gz -C ~/.local/share/t3
ln -sfn ~/.local/share/t3/t3-*-linux-x64/t3 ~/.local/bin/t3
```

Then reconnect the environment from the desktop app.
