import { it } from "@effect/vitest";
import { DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { expect } from "vite-plus/test";
import * as ServerSettings from "../serverSettings.ts";
import * as CloudSpeech from "./CloudSpeech.ts";

// [fork:lockdown] Tripwire: with a key saved for every provider, cloud transcription and the
// OpenRouter catalog still fail, and no request is made (the layer has no HTTP client to use).
it.effect("refuses cloud transcription even with a saved key", () =>
  Effect.gen(function* () {
    const service = yield* CloudSpeech.CloudSpeech.pipe(
      Effect.provide(
        CloudSpeech.layer.pipe(Layer.provide(ServerSettings.ServerSettingsService.layerTest())),
      ),
    );
    const pcm = new Uint8Array(new Float32Array([0, 0.5]).buffer);
    for (const provider of ["openai", "xai", "openrouter"] as const) {
      yield* service.setKey(provider, Redacted.make("saved"));
      const error = yield* Effect.flip(
        service.transcribe(provider, pcm, DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS, "openai/whisper"),
      );
      expect(error).toMatchObject({ _tag: "CloudSpeechError", provider, reason: "unavailable" });
    }
    expect(yield* service.configured).toEqual({ openai: false, xai: false, openrouter: false });
    expect((yield* Effect.flip(service.models))._tag).toBe("CloudSpeechError");
  }),
);
