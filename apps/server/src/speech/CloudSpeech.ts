import {
  CloudSpeechError,
  type CloudSpeechModel,
  type ServerSettingsError,
  type CloudSpeechKeys,
  type CloudSpeechProvider,
  type SecretReference,
  type SpeechTranscriptionOptions,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as ServerSettings from "../serverSettings.ts";
import type { SpeechInvalidAudioError } from "./SpeechService.ts";

export class CloudSpeech extends Context.Service<
  CloudSpeech,
  {
    readonly configured: Effect.Effect<CloudSpeechKeys, ServerSettingsError>;
    /** OpenRouter's public transcription catalog, cached briefly on this server. */
    readonly models: Effect.Effect<ReadonlyArray<CloudSpeechModel>, CloudSpeechError>;
    readonly setKey: (
      provider: CloudSpeechProvider,
      key: Redacted.Redacted<string> | SecretReference | null,
    ) => Effect.Effect<void, ServerSettingsError>;
    readonly transcribe: (
      provider: CloudSpeechProvider,
      pcm: Uint8Array,
      options: SpeechTranscriptionOptions,
      model?: string | undefined,
    ) => Effect.Effect<string, CloudSpeechError | SpeechInvalidAudioError | ServerSettingsError>;
  }
>()("t3/speech/CloudSpeech") {}

// [fork:lockdown] Upstream uploads the recording (prompt text before it is typed) to OpenAI, xAI
// or OpenRouter, outside a provider harness. This fork refuses both calls without a request and
// does not advertise cloudVoiceTranscription (ServerEnvironment.ts). Tripwire: CloudSpeech.test.ts.
export const layer = Layer.effect(
  CloudSpeech,
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const refused = (provider: CloudSpeechProvider) =>
      new CloudSpeechError({ provider, reason: "unavailable" });
    return CloudSpeech.of({
      configured: Effect.succeed({ openai: false, xai: false, openrouter: false }),
      models: Effect.fail(refused("openrouter")),
      setKey: Effect.fn("CloudSpeech.setKey")(function* (provider, key) {
        yield* settings.updateSettings({
          cloudSpeechCredentials: {
            [provider]: Redacted.isRedacted(key) ? Redacted.value(key) : (key ?? ""),
          },
        });
      }),
      transcribe: Effect.fn("CloudSpeech.transcribe")(function* (provider) {
        return yield* refused(provider);
      }),
    });
  }),
);
