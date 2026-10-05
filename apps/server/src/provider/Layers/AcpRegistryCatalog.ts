import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import * as AcpRegistrySupport from "../acp/AcpRegistrySupport.ts";
import * as AcpRegistryRuntimeCoordinator from "../acp/AcpRegistryRuntimeCoordinator.ts";

const registryDisabled = () =>
  new AcpRegistrySupport.AcpRegistryError({
    reason: "registry_unavailable",
    detail:
      "This build does not install agents from the ACP Registry. Install the agent yourself and choose the Local command source.",
  });

/**
 * [fork:lockdown] Upstream's catalog reads the public ACP Registry
 * (cdn.agentclientprotocol.com) at runtime and then downloads the agent it
 * names, as a release archive or an `npx` / `uvx` package, and runs it on this
 * environment's code. The registry content is chosen by a third party when it
 * is fetched, so that is code we did not choose (invariant 2) handed the same
 * access as a provider harness. Only the `local` source, an executable the
 * operator installed, reaches the real catalog; every registry operation fails
 * before it can touch the network or a package manager.
 * Tripwire: AcpRegistryCatalog.test.ts.
 */
export const lockDownAcpRegistryCatalog = (
  catalog: AcpRegistrySupport.AcpRegistryCatalog["Service"],
): AcpRegistrySupport.AcpRegistryCatalog["Service"] => ({
  search: () => Effect.fail(registryDisabled()),
  prepare: () => Effect.fail(registryDisabled()),
  inspect: (settings, environment) =>
    settings.source === "local"
      ? catalog.inspect(settings, environment)
      : Effect.fail(registryDisabled()),
  resolve: (settings, cwd, environment) =>
    settings.source === "local"
      ? catalog.resolve(settings, cwd, environment)
      : Effect.fail(registryDisabled()),
  // Removes files under T3's own tools directory; it never fetches.
  uninstallManagedBinary: catalog.uninstallManagedBinary,
});

/** Server-lifetime ACP Registry catalog shared by setup, snapshots, and turn launch. */
export const AcpRegistryCatalogLive = Layer.merge(
  Layer.effect(
    AcpRegistrySupport.AcpRegistryCatalog,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const catalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir: config.providerStatusCacheDir,
        toolsDir: path.join(config.baseDir, "tools"),
      });
      return lockDownAcpRegistryCatalog(catalog);
    }),
  ),
  AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator.layer,
);
