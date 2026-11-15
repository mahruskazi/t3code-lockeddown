import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({
  app: { getVersion: () => "0.1.9-main.10", isPackaged: true, quit: () => undefined },
}));

import * as ElectronForkUpdater from "./ElectronForkUpdater.ts";

const manifest = (version: string) => ({
  version,
  commit: "0123456789abcdef0123456789abcdef01234567",
  files: {
    "darwin-arm64": { name: `T3-Code-${version}-arm64.zip`, sha256: "a".repeat(64), size: 1 },
  },
});

const checkAgainst = (body: unknown, status = 200) =>
  Effect.gen(function* () {
    using _fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(body), { status }));
    const updater = ElectronForkUpdater.make({ fileKey: "darwin-arm64" });
    const events: Array<{ readonly name: string; readonly args: ReadonlyArray<unknown> }> = [];
    for (const name of ["update-available", "update-not-available"]) {
      yield* updater.on(name, (...args: ReadonlyArray<unknown>) => events.push({ name, args }));
    }
    const result = yield* Effect.result(updater.checkForUpdates);
    return { events, result };
  }).pipe(Effect.scoped);

describe("ElectronForkUpdater", () => {
  it("recognizes only the fork's main-build feed in app-update.yml", () => {
    const feed = ElectronForkUpdater.FORK_MAIN_BUILD_FEED_URL;
    assert.isTrue(ElectronForkUpdater.isForkMainBuildFeed(`provider: generic\nurl: ${feed}\n`));
    assert.isTrue(ElectronForkUpdater.isForkMainBuildFeed(`provider: generic\nurl: '${feed}/'\n`));
    assert.isFalse(
      ElectronForkUpdater.isForkMainBuildFeed("provider: github\nowner: pingdotgg\nrepo: t3code\n"),
    );
    assert.isFalse(
      ElectronForkUpdater.isForkMainBuildFeed(`provider: generic\nurl: ${feed}.evil.example\n`),
    );
  });

  it.effect("offers only a newer build than the running one", () =>
    Effect.gen(function* () {
      const newer = yield* checkAgainst(manifest("0.1.9-main.11"));
      assert.deepStrictEqual(
        newer.events.map((event) => event.name),
        ["update-available"],
      );
      assert.deepInclude(newer.events[0]?.args[0], { version: "0.1.9-main.11" });

      for (const version of ["0.1.9-main.10", "0.1.9-main.9"]) {
        const notNewer = yield* checkAgainst(manifest(version));
        assert.deepStrictEqual(
          notNewer.events.map((event) => event.name),
          ["update-not-available"],
        );
      }
    }),
  );

  it.effect("fails the check on a missing or malformed manifest", () =>
    Effect.gen(function* () {
      const missing = yield* checkAgainst({}, 404);
      assert.isTrue(missing.result._tag === "Failure");
      const malformed = yield* checkAgainst({ ...manifest("0.1.9-main.11"), files: { x: {} } });
      assert.isTrue(malformed.result._tag === "Failure");
      assert.deepStrictEqual(malformed.events, []);
    }),
  );
});
