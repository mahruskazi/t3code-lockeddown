import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient } from "effect/unstable/http";

import * as ProcessRunner from "../processRunner.ts";
import {
  ensurePinnedRuntimeInstalled,
  pinnedRuntimePaths,
  PinnedRuntimeInstallError,
} from "./pinnedRuntime.ts";

// [fork:lockdown] Tripwire: pinned runtimes must never be downloaded, from
// the npm registry or as a GitHub release archive. A runner and an HTTP client
// that die on any invocation prove the install path neither spawns a process
// (npm, tar, or otherwise) nor makes a request.
const forbiddenRunner = ProcessRunner.ProcessRunner.of({
  run: () => Effect.die("this fork must never spawn a process to install a pinned runtime"),
});
const forbiddenHttpClient = HttpClient.make(() =>
  Effect.die("this fork must never download a pinned runtime"),
);
const PLATFORM = "linux";
const lockedInput = {
  runner: forbiddenRunner,
  httpClient: forbiddenHttpClient,
  releaseBaseUrl: "https://example.invalid/releases",
  platform: PLATFORM,
  arch: "x64",
} as const;

const seedPinnedRuntime = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  baseDir: string,
  version: string,
) {
  const paths = pinnedRuntimePaths(path, baseDir, version, PLATFORM);
  yield* fs.makeDirectory(path.dirname(paths.entryPath), { recursive: true });
  yield* fs.writeFileString(paths.entryPath, "#!/bin/sh\n");
  yield* fs.writeFileString(paths.sentinelPath, `${version}\n`);
  return paths;
});

it.layer(NodeServices.layer)("ensurePinnedRuntimeInstalled", (it) => {
  it.effect("reuses a completed pinned runtime without spawning anything", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-test-" });
      const seeded = yield* seedPinnedRuntime(fs, path, baseDir, "1.2.3");

      let validations = 0;
      const installed = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        ...lockedInput,
        validate: (paths) =>
          Effect.sync(() => {
            validations += 1;
            assert.equal(paths.versionDir, seeded.versionDir);
          }),
      });

      assert.equal(validations, 1);
      assert.deepEqual(installed, seeded);
    }),
  );

  it.effect("preserves a completed runtime when validation fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-test-" });
      const seeded = yield* seedPinnedRuntime(fs, path, baseDir, "1.2.3");
      yield* fs.writeFileString(seeded.entryPath, "broken\n");

      yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        ...lockedInput,
        validate: () =>
          Effect.fail(new PinnedRuntimeInstallError({ step: "validating the runtime" })),
      }).pipe(Effect.flip);

      assert.equal(yield* fs.readFileString(seeded.entryPath), "broken\n");
    }),
  );

  it.effect("refuses to download a missing pinned runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-test-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, "1.2.3", PLATFORM);

      const error = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        ...lockedInput,
        validate: () => Effect.die("a missing runtime must never be validated"),
      }).pipe(Effect.flip);

      assert.equal(error._tag, "PinnedRuntimeInstallError");
      assert.include(error.message, "refusing to download t3 1.2.3");
      assert.include(error.message, finalPaths.entryPath);
      assert.isFalse(yield* fs.exists(finalPaths.versionDir));
    }),
  );

  it.effect("refuses an incomplete pinned runtime and leaves it in place", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-test-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, "1.2.3", PLATFORM);
      const partialPath = path.join(finalPaths.versionDir, "partial");
      yield* fs.makeDirectory(finalPaths.versionDir, { recursive: true });
      yield* fs.writeFileString(partialPath, "incomplete\n");

      const error = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        ...lockedInput,
        validate: () => Effect.die("an incomplete runtime must never be validated"),
      }).pipe(Effect.flip);

      assert.include(error.message, "refusing to download t3 1.2.3");
      assert.isTrue(yield* fs.exists(partialPath));
    }),
  );
});
