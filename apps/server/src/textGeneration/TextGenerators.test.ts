import { it } from "@effect/vitest";
import {
  type ManagedPolicySummary,
  ProviderInstanceId,
  type TextGeneratorConfig,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { expect, vi } from "vite-plus/test";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGenerators from "./TextGenerators.ts";

const ID = ProviderInstanceId.make("router");

const layer = (generator: Partial<TextGeneratorConfig>, policy?: ManagedPolicySummary) =>
  Layer.effect(TextGenerators.TextGenerators, TextGenerators.make).pipe(
    Layer.provideMerge(
      ServerSettings.layerTest(
        {
          textGenerators: {
            [ID]: { kind: "openaiCompatible", baseUrl: "https://api.test/v1", ...generator },
          },
        },
        policy,
      ),
    ),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
  );

const request = {
  operation: "generateThreadTitle",
  cwd: "/unused",
  prompt: "Name this thread.",
  outputSchema: Schema.Struct({ title: Schema.String }),
  modelSelection: { instanceId: ID, model: "some/model" },
} as const;

// [fork:lockdown] Tripwire: text generators would send a task's input (a staged diff, a prompt) to
// a model API outside a provider harness. Every kind refuses generation and model listing, with
// or without a key, and fetch is never called.
it.effect.each(["openaiCompatible", "anthropic"] as const)(
  "%s never sends a request to its model API",
  (kind) =>
    Effect.gen(function* () {
      const upstream = vi.fn<typeof fetch>(async () => Response.json({}));
      const generators = yield* TextGenerators.TextGenerators.pipe(
        Effect.provide(layer({ kind, apiKey: "secret" })),
      );
      const run = yield* generators.runner(ID);
      expect(run).toBeDefined();
      const failure = yield* Effect.flip(
        run!(request).pipe(Effect.provideService(FetchHttpClient.Fetch, upstream)),
      );
      expect(failure.detail).toContain("sends text only through coding agents");
      yield* Effect.flip(
        generators
          .listModels({ id: ID, refresh: true })
          .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream)),
      );
      yield* Effect.flip(
        generators
          .listModels({
            id: ProviderInstanceId.make("draft"),
            config: { kind, baseUrl: "http://127.0.0.1:11434/v1", apiKey: "", enabled: true },
            test: true,
            model: "local/model",
          })
          .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream)),
      );
      expect(upstream).not.toHaveBeenCalled();
    }),
);

it.effect("a turned-off text generator fails instead of calling its API", () =>
  Effect.gen(function* () {
    const upstream = vi.fn<typeof fetch>();
    const generators = yield* TextGenerators.TextGenerators.pipe(
      Effect.provide(layer({ enabled: false, label: "OpenRouter" })),
    );
    const run = yield* generators.runner(ID);
    const failure = yield* Effect.flip(
      run!(request).pipe(Effect.provideService(FetchHttpClient.Fetch, upstream)),
    );
    expect(failure.detail).toBe("OpenRouter is off. Turn it on in Settings → Providers.");
    expect(upstream).not.toHaveBeenCalled();
  }),
);
