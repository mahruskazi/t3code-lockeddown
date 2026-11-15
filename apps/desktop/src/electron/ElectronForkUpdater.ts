// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off -- Implements electron-updater's imperative, event-emitting API at the Electron boundary, like ElectronUpdater.make.
// [fork:lockdown] Fork macOS builds are ad-hoc signed, which Squirrel.Mac refuses to install, so
// this implements ElectronUpdater for the fork's main-build release and swaps the bundle itself.
// Only FORK_MAIN_BUILD_FEED_URL is read; a build installs after its sha256, codesign, bundle id
// and version match. docs/operations/fork-main-build.md
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { app } from "electron";

import * as ElectronUpdater from "./ElectronUpdater.ts";

export const FORK_MAIN_BUILD_FEED_URL =
  "https://github.com/mahruskazi/t3code-lockeddown/releases/download/main-build";
const FORK_MAIN_BUILD_MANIFEST = "main-build.json";
const STAGE_DIR_NAME = ".t3code-update";
const CHECK_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const run = NodeUtil.promisify(NodeChildProcess.execFile);

const ManifestFile = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[\w.() -]+\.zip$/)),
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  size: Schema.Number,
});
export const MainBuildManifest = Schema.Struct({
  version: Schema.String,
  commit: Schema.String,
  publishedAt: Schema.optional(Schema.String),
  /** Keyed by `<platform>-<arch>`, such as `darwin-arm64`. */
  files: Schema.Record(Schema.String, ManifestFile),
});
export type MainBuildManifest = typeof MainBuildManifest.Type;
const decodeManifest = Schema.decodeUnknownSync(MainBuildManifest);

/** Whether app-update.yml names the fork's main-build feed, which is how CI marks fork builds. */
export function isForkMainBuildFeed(appUpdateYml: string): boolean {
  return appUpdateYml.split("\n").some((line) => {
    const match = /^url:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line.trim());
    return match?.[1]?.replace(/\/+$/, "") === FORK_MAIN_BUILD_FEED_URL;
  });
}

// The helper outlives the app: it waits for this process to exit, swaps the bundles with two
// renames, and reopens the app. If the new bundle cannot be moved in or opened, it puts the old
// one back and reopens that instead.
const UPDATE_HELPER = `#!/bin/sh
pid="$1"; app="$2"; incoming="$3"; stage="$4"
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 600 ]; then exit 1; fi
  sleep 0.2
done
previous="$stage/previous.app"
rm -rf "$previous"
if mv "$app" "$previous"; then
  if mv "$incoming" "$app"; then
    if /usr/bin/open "$app"; then
      rm -rf "$stage"
      exit 0
    fi
    rm -rf "$app"
  fi
  mv "$previous" "$app"
fi
/usr/bin/open "$app"
`;

function runningAppBundle(): string | null {
  const bundle = NodePath.resolve(process.execPath, "../../..");
  return bundle.endsWith(".app") ? bundle : null;
}

async function readPlistValue(bundle: string, key: string): Promise<string> {
  const { stdout } = await run(
    "/usr/bin/plutil",
    ["-extract", key, "raw", "-o", "-", NodePath.join(bundle, "Contents/Info.plist")],
    { encoding: "utf8", timeout: CHECK_TIMEOUT_MS },
  );
  return stdout.trim();
}

export function make(options: { readonly fileKey: string; readonly feedUrl?: string }) {
  const feedUrl = options.feedUrl ?? FORK_MAIN_BUILD_FEED_URL;
  const events = new NodeEvents.EventEmitter();
  const { fileKey } = options;
  let channel: string | null = null;
  let allowDowngrade = false;
  let offered: MainBuildManifest | null = null;
  let staged: { readonly app: string; readonly stage: string; readonly incoming: string } | null =
    null;

  const emit = (event: string, ...args: ReadonlyArray<unknown>) => {
    events.emit(event, ...args);
  };

  const fetchManifest = async (): Promise<MainBuildManifest> => {
    const response = await fetch(`${feedUrl}/${FORK_MAIN_BUILD_MANIFEST}`, {
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (response.status === 404) {
      throw new Error("The latest build is being published. Try again in a few minutes.");
    }
    if (!response.ok) {
      throw new Error(`GitHub answered the update check with HTTP ${response.status}.`);
    }
    return decodeManifest(await response.json());
  };

  const check = async () => {
    emit("checking-for-update");
    const manifest = await fetchManifest();
    const order = compareSemverVersions(manifest.version, app.getVersion());
    if (order > 0 || (allowDowngrade && order < 0)) {
      offered = manifest;
      emit("update-available", {
        version: manifest.version,
        releaseName: `main-build ${manifest.commit.slice(0, 7)}`,
        ...(manifest.publishedAt === undefined ? {} : { releaseDate: manifest.publishedAt }),
      });
    } else {
      offered = null;
      emit("update-not-available", { version: manifest.version });
    }
  };

  const download = async () => {
    const manifest = offered;
    if (manifest === null) throw new Error("No update has been offered yet.");
    const file = manifest.files[fileKey];
    if (file === undefined) {
      throw new Error(
        `The latest build has no ${fileKey} download. Build this Mac's architecture from source.`,
      );
    }
    const appBundle = runningAppBundle();
    if (appBundle === null) throw new Error("T3 Code is not running from an app bundle.");
    if (appBundle.includes("/AppTranslocation/")) {
      throw new Error(
        "macOS is running T3 Code from a temporary location. Move it to Applications and reopen it to update.",
      );
    }
    try {
      NodeFS.accessSync(NodePath.dirname(appBundle), NodeFS.constants.W_OK);
      NodeFS.accessSync(appBundle, NodeFS.constants.W_OK);
    } catch {
      throw new Error(
        "T3 Code can't write to the folder it's installed in. Move it somewhere you can write to, such as Applications, to update.",
      );
    }

    // Beside the app, so the helper's renames stay on one volume.
    const stage = NodePath.join(NodePath.dirname(appBundle), STAGE_DIR_NAME);
    NodeFS.rmSync(stage, { recursive: true, force: true });
    NodeFS.mkdirSync(stage, { mode: 0o700 });
    staged = null;
    const zipPath = NodePath.join(stage, file.name);

    const response = await fetch(`${feedUrl}/${encodeURIComponent(file.name)}`, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok || response.body === null) {
      throw new Error(`GitHub answered the download with HTTP ${response.status}.`);
    }
    const hash = NodeCrypto.createHash("sha256");
    const out = NodeFS.createWriteStream(zipPath, { mode: 0o600 });
    const started = Date.now();
    let transferred = 0;
    let lastPercent = -1;
    try {
      for await (const chunk of response.body) {
        const bytes = chunk as Uint8Array;
        hash.update(bytes);
        transferred += bytes.byteLength;
        if (!out.write(bytes))
          await new Promise<void>((resolve) => out.once("drain", () => resolve()));
        const percent = Math.min(100, Math.floor((transferred / file.size) * 100));
        if (percent !== lastPercent) {
          lastPercent = percent;
          const seconds = Math.max(1, (Date.now() - started) / 1000);
          emit("download-progress", {
            percent,
            transferred,
            total: file.size,
            bytesPerSecond: Math.round(transferred / seconds),
          });
        }
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        out.end((error?: Error | null) => (error ? reject(error) : resolve())),
      );
    }
    if (hash.digest("hex") !== file.sha256) {
      throw new Error(
        "The download didn't match its checksum, so T3 Code didn't install it. Try again.",
      );
    }

    const extracted = NodePath.join(stage, "extracted");
    const unusable = new Error(
      "The downloaded build didn't pass T3 Code's checks, so it wasn't installed. Try again after the next build.",
    );
    let incoming: string;
    try {
      await run("/usr/bin/ditto", ["-x", "-k", zipPath, extracted], {
        timeout: CHECK_TIMEOUT_MS * 4,
      });
      const bundles = NodeFS.readdirSync(extracted).filter((name) => name.endsWith(".app"));
      if (bundles.length !== 1 || bundles[0] === undefined) throw unusable;
      incoming = NodePath.join(extracted, bundles[0]);
      await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", incoming], {
        timeout: CHECK_TIMEOUT_MS * 4,
      });
      const [incomingId, runningId, incomingVersion] = await Promise.all([
        readPlistValue(incoming, "CFBundleIdentifier"),
        readPlistValue(appBundle, "CFBundleIdentifier"),
        readPlistValue(incoming, "CFBundleShortVersionString"),
      ]);
      if (incomingId !== runningId || incomingVersion !== manifest.version) throw unusable;
    } catch {
      throw unusable;
    }
    NodeFS.rmSync(zipPath, { force: true });
    staged = { app: appBundle, stage, incoming };
    emit("update-downloaded", { version: manifest.version });
  };

  const install = () => {
    if (staged === null) throw new Error("No downloaded update is ready to install.");
    const helper = NodePath.join(staged.stage, "install.sh");
    NodeFS.writeFileSync(helper, UPDATE_HELPER, { mode: 0o700 });
    const child = NodeChildProcess.spawn(
      "/bin/sh",
      [helper, String(process.pid), staged.app, staged.incoming, staged.stage],
      {
        detached: true,
        stdio: "ignore",
        cwd: "/",
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      },
    );
    child.unref();
    app.quit();
  };

  const ignore = (_value: unknown) => Effect.void;
  return ElectronUpdater.ElectronUpdater.of({
    // The feed is fixed in this file; mock and policy feeds are ignored for fork builds.
    setFeedURL: ignore,
    setAutoDownload: ignore,
    setAutoInstallOnAppQuit: ignore,
    setChannel: Effect.fn("ElectronForkUpdater.setChannel")(function (value) {
      return Effect.sync(() => {
        channel = value;
      });
    }),
    setAllowPrerelease: ignore,
    allowDowngrade: Effect.sync(() => allowDowngrade),
    setAllowDowngrade: Effect.fn("ElectronForkUpdater.setAllowDowngrade")(function (value) {
      return Effect.sync(() => {
        allowDowngrade = value;
      });
    }),
    setFullChangelog: ignore,
    setDisableDifferentialDownload: ignore,
    checkForUpdates: Effect.tryPromise({
      try: check,
      catch: (cause) => new ElectronUpdater.ElectronUpdaterCheckForUpdatesError({ channel, cause }),
    }),
    downloadUpdate: Effect.tryPromise({
      try: download,
      catch: (cause) => new ElectronUpdater.ElectronUpdaterDownloadUpdateError({ channel, cause }),
    }),
    quitAndInstall: Effect.fn("ElectronForkUpdater.quitAndInstall")(function ({
      isSilent,
      isForceRunAfter,
    }) {
      return Effect.try({
        try: install,
        catch: (cause) =>
          new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
            channel,
            isSilent,
            isForceRunAfter,
            cause,
          }),
      });
    }),
    on: Effect.fn("ElectronForkUpdater.on")(function (eventName, listener) {
      const untyped = listener as unknown as (...args: Array<unknown>) => void;
      return Effect.acquireRelease(
        Effect.sync(() => {
          events.on(eventName, untyped);
        }),
        () =>
          Effect.sync(() => {
            events.removeListener(eventName, untyped);
          }),
      ).pipe(Effect.asVoid);
    }),
  });
}

function readAppUpdateYml(): string {
  try {
    return NodeFS.readFileSync(NodePath.join(process.resourcesPath, "app-update.yml"), "utf8");
  } catch {
    return "";
  }
}

/** The fork updater on a packaged macOS fork build, electron-updater everywhere else. */
export const layer = Layer.effect(
  ElectronUpdater.ElectronUpdater,
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    const arch = yield* HostProcess.Architecture;
    return platform === "darwin" && app.isPackaged && isForkMainBuildFeed(readAppUpdateYml())
      ? make({ fileKey: `${platform}-${arch}` })
      : ElectronUpdater.make;
  }),
);
