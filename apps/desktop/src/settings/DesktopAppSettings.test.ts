import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "./DesktopAppSettings.ts";

const DesktopSettingsPatch = Schema.Struct({
  linuxPasswordStore: Schema.optionalKey(
    Schema.Literals(["auto", "gnome-libsecret", "kwallet", "kwallet5", "kwallet6"]),
  ),
  mainWindowBounds: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        x: Schema.Number,
        y: Schema.Number,
        width: Schema.Number,
        height: Schema.Number,
      }),
    ),
  ),
  mainWindowMaximized: Schema.optionalKey(Schema.Boolean),
  serverExposureMode: Schema.optionalKey(Schema.Literals(["local-only", "network-accessible"])),
  tailscaleServeEnabled: Schema.optionalKey(Schema.Boolean),
  tailscaleServePort: Schema.optionalKey(Schema.Number),
  updateChannel: Schema.optionalKey(Schema.Literals(["latest", "nightly"])),
  updateChannelConfiguredByUser: Schema.optionalKey(Schema.Boolean),
  wslBackendEnabled: Schema.optionalKey(Schema.Boolean),
  wslMode: Schema.optionalKey(Schema.Literals(["local", "wsl"])),
  wslDistro: Schema.optionalKey(Schema.NullOr(Schema.String)),
  wslOnly: Schema.optionalKey(Schema.Boolean),
});

const decodeDesktopSettingsPatch = Schema.decodeEffect(Schema.fromJsonString(DesktopSettingsPatch));
const encodeDesktopSettingsPatch = Schema.encodeEffect(Schema.fromJsonString(DesktopSettingsPatch));

function makeEnvironmentLayer(baseDir: string, appVersion = "0.0.17") {
  return DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "x64",
    appVersion,
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );
}

const withSettings = <A, E, R>(
  effect: Effect.Effect<
    A,
    E,
    R | DesktopAppSettings.DesktopAppSettings | DesktopEnvironment.DesktopEnvironment
  >,
  options?: { readonly appVersion?: string },
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-settings-test-",
    });
    return yield* effect.pipe(
      Effect.provide(
        DesktopAppSettings.layer.pipe(
          Layer.provideMerge(makeEnvironmentLayer(baseDir, options?.appVersion)),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

function writeSettingsPatch(patch: typeof DesktopSettingsPatch.Type) {
  return Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const encoded = yield* encodeDesktopSettingsPatch(patch);
    yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
    yield* fileSystem.writeFileString(environment.desktopSettingsPath, `${encoded}\n`);
  });
}

describe("DesktopSettings", () => {
  it.effect("loads defaults when no settings file exists", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        assert.deepEqual(yield* settings.load, DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS);
        assert.deepEqual(yield* settings.get, DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS);
      }),
    ),
  );





  it.effect("falls back to defaults when the settings file is malformed", () =>
    withSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(environment.desktopSettingsPath, "{not-json");

        assert.deepEqual(yield* settings.load, DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS);
      }),
    ),
  );








  it.effect("persists wsl backend toggle and normalizes invalid distro names", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        const enable = yield* settings.setWslBackendEnabled(true);
        assert.isTrue(enable.changed);
        assert.equal(enable.settings.wslBackendEnabled, true);

        const distro = yield* settings.setWslDistro("Ubuntu-22.04");
        assert.isTrue(distro.changed);
        assert.equal(distro.settings.wslDistro, "Ubuntu-22.04");

        const reloaded = yield* settings.load;
        assert.equal(reloaded.wslBackendEnabled, true);
        assert.equal(reloaded.wslDistro, "Ubuntu-22.04");

        const reject = yield* settings.setWslDistro("bad name!");
        assert.equal(reject.settings.wslDistro, null);

        const noop = yield* settings.setWslDistro(null);
        assert.isFalse(noop.changed);
      }),
    ),
  );

  it.effect("applies WSL Windows fallback with persisted and volatile updates", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* settings.setWslBackendEnabled(true);
        yield* settings.setWslOnly(true);

        const persistedFallback = yield* settings.applyWslWindowsFallback;
        assert.isTrue(persistedFallback.changed);
        assert.equal(persistedFallback.settings.wslBackendEnabled, false);
        assert.equal(persistedFallback.settings.wslOnly, false);

        const persistedReload = yield* settings.load;
        assert.equal(persistedReload.wslBackendEnabled, false);
        assert.equal(persistedReload.wslOnly, false);

        yield* settings.setWslBackendEnabled(true);
        yield* settings.setWslOnly(true);

        const volatileFallback = yield* settings.applyWslWindowsFallbackInMemory;
        assert.isTrue(volatileFallback.changed);
        assert.equal(volatileFallback.settings.wslBackendEnabled, false);
        assert.equal(volatileFallback.settings.wslOnly, false);

        const current = yield* settings.get;
        assert.equal(current.wslBackendEnabled, false);
        assert.equal(current.wslOnly, false);

        const diskReload = yield* settings.load;
        assert.equal(diskReload.wslBackendEnabled, true);
        assert.equal(diskReload.wslOnly, true);
      }),
    ),
  );

  it.effect("migrates legacy wslMode=wsl to wslBackendEnabled on load", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* writeSettingsPatch({
          wslMode: "wsl",
          wslDistro: "Ubuntu-22.04",
        });
        const loaded = yield* settings.load;
        assert.equal(loaded.wslBackendEnabled, true);
        assert.equal(loaded.wslDistro, "Ubuntu-22.04");
      }),
    ),
  );

  it.effect("drops invalid persisted wsl distro values on load", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* writeSettingsPatch({
          wslBackendEnabled: true,
          wslDistro: "bad/name",
        });
        const loaded = yield* settings.load;
        assert.equal(loaded.wslBackendEnabled, true);
        assert.equal(loaded.wslDistro, null);
      }),
    ),
  );
});
