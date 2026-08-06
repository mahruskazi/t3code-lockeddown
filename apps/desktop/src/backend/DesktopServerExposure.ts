/**
 * DesktopServerExposure - where the supervised backend listens.
 *
 * The locked-down build binds loopback only. There is no LAN mode, no tunnel,
 * and no advertised endpoint beyond `127.0.0.1`, so this service exists to
 * hand the backend its port and to describe that single local endpoint.
 *
 * @module DesktopServerExposure
 */
import {
  createAdvertisedEndpoint,
  type CreateAdvertisedEndpointInput,
} from "@t3tools/shared/advertisedEndpoint";
import type {
  AdvertisedEndpoint,
  AdvertisedEndpointProvider,
  DesktopServerExposureState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export const DESKTOP_LOOPBACK_HOST = "127.0.0.1";

const DESKTOP_CORE_ENDPOINT_PROVIDER: AdvertisedEndpointProvider = {
  id: "desktop-core",
  label: "Desktop",
  kind: "core",
  isAddon: false,
};

export interface DesktopServerExposureBackendConfig {
  readonly port: number;
  readonly bindHost: string;
  readonly httpBaseUrl: URL;
}

export class DesktopServerExposure extends Context.Service<
  DesktopServerExposure,
  {
    readonly getState: Effect.Effect<DesktopServerExposureState>;
    readonly backendConfig: Effect.Effect<DesktopServerExposureBackendConfig>;
    readonly configureFromSettings: (input: {
      readonly port: number;
    }) => Effect.Effect<DesktopServerExposureState>;
    readonly getAdvertisedEndpoints: Effect.Effect<readonly AdvertisedEndpoint[]>;
  }
>()("@t3tools/desktop/backend/DesktopServerExposure") {}

const loopbackHttpUrl = (port: number): string => `http://${DESKTOP_LOOPBACK_HOST}:${port}`;

const toContractState = (): DesktopServerExposureState => ({
  mode: "local-only",
  endpointUrl: null,
  advertisedHost: null,
});

const localEndpointInput = (port: number): CreateAdvertisedEndpointInput => ({
  id: "desktop-local",
  label: "This computer",
  provider: DESKTOP_CORE_ENDPOINT_PROVIDER,
  source: "desktop-core",
  reachability: "loopback",
  status: "available",
  httpBaseUrl: loopbackHttpUrl(port),
  description: "Only reachable from this machine.",
});

export const make = Effect.gen(function* () {
  const portRef = yield* Ref.make(0);

  const backendConfig: DesktopServerExposure["Service"]["backendConfig"] = Effect.map(
    Ref.get(portRef),
    (port) => ({
      port,
      bindHost: DESKTOP_LOOPBACK_HOST,
      httpBaseUrl: new URL(loopbackHttpUrl(port)),
    }),
  );

  return DesktopServerExposure.of({
    getState: Effect.sync(toContractState),
    backendConfig,
    configureFromSettings: (input) =>
      Ref.set(portRef, input.port).pipe(Effect.as(toContractState())),
    getAdvertisedEndpoints: Effect.map(Ref.get(portRef), (port) => [
      createAdvertisedEndpoint(localEndpointInput(port)),
    ]),
  });
});

export const layer = Layer.effect(DesktopServerExposure, make);
