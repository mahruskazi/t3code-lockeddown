import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import {
  ensurePinnedRuntimeInstalled,
  pinnedRuntimePaths,
  PinnedRuntimeInstallError,
} from "./pinnedRuntime.ts";

// [fork:lockdown] Tripwire: pinned runtimes must never be downloaded from
// the npm registry. A runner that dies on any invocation proves no process
// (npm or otherwise) is spawned by the install path.
const forbiddenRunner = ProcessRunner.ProcessRunner.of({
  run: () => Effect.die("this fork must never spawn a process to install a pinned runtime"),
});

const seedPinnedRuntime = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  baseDir: string,
  version: string,
) {
  const paths = pinnedRuntimePaths(path, baseDir, version);
  yield* fs.makeDirectory(path.dirname(paths.entryPath), { recursive: true });
  yield* fs.writeFileString(paths.entryPath, "export {};\n");
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
        runner: forbiddenRunner,
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
        runner: forbiddenRunner,
        validate: () =>
          Effect.fail(new PinnedRuntimeInstallError({ step: "validating the runtime" })),
      }).pipe(Effect.flip);

      assert.equal(yield* fs.readFileString(seeded.entryPath), "broken\n");
    }),
  );

  it.effect("refuses to install a missing pinned runtime from npm", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-test-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, "1.2.3");

      const error = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        runner: forbiddenRunner,
        validate: () => Effect.die("a missing runtime must never be validated"),
      }).pipe(Effect.flip);

      assert.equal(error._tag, "PinnedRuntimeInstallError");
      assert.include(error.message, "refusing to download t3@1.2.3 from the npm registry");
      assert.include(error.message, "scripts/setup-remote-t3.sh");
      assert.isFalse(yield* fs.exists(finalPaths.versionDir));
    }),
  );

  it.effect("refuses an incomplete pinned runtime and leaves it in place", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-test-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, "1.2.3");
      const partialPath = path.join(finalPaths.versionDir, "partial");
      yield* fs.makeDirectory(finalPaths.versionDir, { recursive: true });
      yield* fs.writeFileString(partialPath, "incomplete\n");

      const error = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        runner: forbiddenRunner,
        validate: () => Effect.die("an incomplete runtime must never be validated"),
      }).pipe(Effect.flip);

      assert.include(error.message, "refusing to download t3@1.2.3");
      assert.isTrue(yield* fs.exists(partialPath));
    }),
  );
});
