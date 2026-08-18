/**
 * PiTextGeneration — commit messages, PR content, branch names, and thread
 * titles generated through a one-shot `pi --mode rpc --no-session` run.
 *
 * Mirrors GrokTextGeneration: build the shared prompt, stream the assistant
 * text, extract the JSON object, decode against the operation's schema.
 *
 * [fork:pi] This module is fork-local. See docs/internals/fork-pi-provider.md.
 *
 * @module textGeneration/PiTextGeneration
 */
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { type ModelSelection, type PiSettings, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import {
  assistantDeltaFromMessageUpdate,
  PI_PROCESS_EXITED_EVENT,
  parsePiAgentEnd,
  splitPiModelSlug,
} from "../provider/piRpc/PiRpcModel.ts";
import { makePiRpcProcess } from "../provider/piRpc/PiRpcProcess.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const PI_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runPiJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const outputRef = yield* Ref.make("");
      const doneDeferred = yield* Deferred.make<void, TextGenerationError>();

      const rpc = yield* makePiRpcProcess({
        binaryPath: piSettings.binaryPath,
        args: ["--mode", "rpc", "--no-session"],
        cwd,
        env: environment,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, commandSpawner),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to start Pi for text generation.",
              cause,
            }),
        ),
      );

      yield* Stream.runForEach(rpc.events, (event) =>
        Effect.gen(function* () {
          switch (event.type) {
            case "message_update": {
              const delta = assistantDeltaFromMessageUpdate(event);
              if (delta?.kind === "text_delta") {
                yield* Ref.update(outputRef, (current) => current + delta.delta);
              }
              return;
            }
            case "agent_end": {
              const outcome = parsePiAgentEnd(event);
              if (outcome.willRetry) {
                return;
              }
              if (outcome.errorMessage !== undefined) {
                return yield* Deferred.fail(
                  doneDeferred,
                  new TextGenerationError({ operation, detail: outcome.errorMessage }),
                ).pipe(Effect.asVoid);
              }
              return yield* Deferred.succeed(doneDeferred, undefined).pipe(Effect.asVoid);
            }
            case PI_PROCESS_EXITED_EVENT:
              return yield* Deferred.fail(
                doneDeferred,
                new TextGenerationError({
                  operation,
                  detail: "Pi exited before finishing text generation.",
                }),
              ).pipe(Effect.asVoid);
            default:
              return;
          }
        }),
      ).pipe(Effect.ignore, Effect.forkScoped);

      const requestedModel = splitPiModelSlug(modelSelection.model);
      if (requestedModel) {
        yield* rpc
          .request({
            type: "set_model",
            provider: requestedModel.provider,
            modelId: requestedModel.modelId,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation,
                  detail: "Failed to set Pi model for text generation.",
                  cause,
                }),
            ),
          );
      }

      // The prompt ack may only arrive at end-of-turn on some Pi versions;
      // run it concurrently and rely on agent_end for settlement.
      yield* rpc
        .request({ type: "prompt", message: prompt }, { timeout: Duration.millis(PI_TIMEOUT_MS) })
        .pipe(
          Effect.tapError((cause) =>
            Deferred.fail(
              doneDeferred,
              new TextGenerationError({
                operation,
                detail: `Pi prompt failed: ${cause.message}`,
              }),
            ),
          ),
          Effect.ignore,
          Effect.forkScoped,
        );

      yield* Deferred.await(doneDeferred).pipe(
        Effect.timeoutOption(PI_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(new TextGenerationError({ operation, detail: "Pi request timed out." })),
            onSome: () => Effect.void,
          }),
        ),
      );

      const trimmed = (yield* Ref.get(outputRef)).trim();
      if (!trimmed) {
        return yield* new TextGenerationError({
          operation,
          detail: "Pi returned empty output.",
        });
      }

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(trimmed)).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Pi returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "Pi text generation failed.",
              cause,
            }),
      ),
      Effect.scoped,
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("PiTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });

      const generated = yield* runPiJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("PiTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

      const generated = yield* runPiJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("PiTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runPiJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("PiTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });

      const generated = yield* runPiJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
