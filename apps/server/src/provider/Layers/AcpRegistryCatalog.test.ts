import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AcpRegistryPrepareInput, AcpRegistrySettings } from "@t3tools/contracts";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AcpRegistrySupport from "../acp/AcpRegistrySupport.ts";
import { AcpRegistryCatalogLive } from "./AcpRegistryCatalog.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const prepareInput = Schema.decodeSync(AcpRegistryPrepareInput)({ agentId: "devin" });
const registrySettings = decodeSettings({ source: "registry", agentId: "devin" });
const localSettings = decodeSettings({ source: "local", commandPath: process.execPath });

// Both die on any call: no registry operation may reach the network or a
// package manager.
const NoEgressLayer = Layer.mergeAll(
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => Effect.die(`unexpected HTTP request: ${request.url}`)),
  ),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("unexpected process spawn")),
  ),
);

const CatalogLayer = AcpRegistryCatalogLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-acp-registry-lockdown-" }),
      ServerSettings.layerTest(),
      Layer.succeed(HostProcessPlatform, "linux"),
      Layer.succeed(HostProcessArchitecture, "x64"),
      Layer.succeed(HostProcessEnvironment, { PATH: "/usr/bin:/bin" }),
    ),
  ),
  Layer.provide(NoEgressLayer),
  Layer.provide(NodeServices.layer),
);

const expectRegistryUnavailable = <A>(
  effect: Effect.Effect<A, AcpRegistrySupport.AcpRegistryError>,
) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(effect);
    assert.strictEqual(error.reason, "registry_unavailable");
  });

// [fork:lockdown] Tripwire: the ACP Registry downloads and runs agents a third
// party names at fetch time (invariant 2). The live catalog must refuse every
// registry operation without a request or a spawn, while an operator-installed
// local command still resolves. An upstream merge that rewires the live layer
// to the unrestricted catalog fails here.
it.layer(CatalogLayer)("ACP Registry lockdown", (it) => {
  it.effect("refuses registry operations without touching the network", () =>
    Effect.gen(function* () {
      const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
      yield* expectRegistryUnavailable(catalog.search({ query: "devin" }));
      yield* expectRegistryUnavailable(catalog.prepare(prepareInput));
      yield* expectRegistryUnavailable(catalog.inspect(registrySettings));
      yield* expectRegistryUnavailable(catalog.resolve(registrySettings, process.cwd()));
    }),
  );

  it.effect("still resolves an operator-installed local command", () =>
    Effect.gen(function* () {
      const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
      const resolved = yield* catalog.resolve(localSettings, process.cwd());
      assert.strictEqual(resolved.distribution, "local");
      assert.strictEqual(resolved.spawn.command, process.execPath);
    }),
  );
});
