import {
  MessageId,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationMessage,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { buildRewindSummary } from "./rewindSummary.ts";

const checkpoint = (input: {
  readonly turn: number;
  readonly files?: ReadonlyArray<string>;
}): OrchestrationCheckpointSummary =>
  ({
    turnId: TurnId.make(`turn-${input.turn}`),
    checkpointTurnCount: input.turn,
    checkpointRef: `refs/t3/checkpoints/thread-1/${input.turn}`,
    status: "ready",
    files: (input.files ?? []).map((path) => ({
      path,
      kind: "modified",
      additions: 1,
      deletions: 0,
    })),
    completedAt: "2026-01-01T00:00:00.000Z",
    assistantMessageId: null,
  }) as unknown as OrchestrationCheckpointSummary;

const userMessage = (input: {
  readonly turn: number;
  readonly text: string;
}): OrchestrationMessage =>
  ({
    id: MessageId.make(`message-${input.turn}`),
    role: "user",
    text: input.text,
    turnId: TurnId.make(`turn-${input.turn}`),
    streaming: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }) as unknown as OrchestrationMessage;

describe("buildRewindSummary", () => {
  it("returns null when the rewind discards nothing", () => {
    expect(
      buildRewindSummary({
        turnCount: 2,
        messages: [userMessage({ turn: 1, text: "first" })],
        checkpoints: [checkpoint({ turn: 1 }), checkpoint({ turn: 2 })],
        restoreFiles: true,
      }),
    ).toBeNull();
  });

  it("lists each discarded turn with its prompt and changed files", () => {
    const summary = buildRewindSummary({
      turnCount: 1,
      messages: [
        userMessage({ turn: 1, text: "kept" }),
        userMessage({ turn: 2, text: "add rate limiting" }),
        userMessage({ turn: 3, text: "fix the failing test" }),
      ],
      checkpoints: [
        checkpoint({ turn: 1, files: ["kept.ts"] }),
        checkpoint({ turn: 2, files: ["src/limit.ts", "src/index.ts"] }),
        checkpoint({ turn: 3, files: ["src/limit.test.ts"] }),
      ],
      restoreFiles: true,
    });

    expect(summary).toContain("rewound this conversation to turn 1, discarding the following 2");
    expect(summary).toContain('2. "add rate limiting" — changed src/limit.ts, src/index.ts');
    expect(summary).toContain('3. "fix the failing test" — changed src/limit.test.ts');
    // Turns at or below the target are history the provider still has.
    expect(summary).not.toContain("kept.ts");
  });

  it("says whether the working tree was reverted", () => {
    const input = {
      turnCount: 0,
      messages: [userMessage({ turn: 1, text: "do a thing" })],
      checkpoints: [checkpoint({ turn: 1, files: ["a.ts"] })],
    };

    expect(buildRewindSummary({ ...input, restoreFiles: true })).toContain(
      "were reverted, so the working tree no longer contains them",
    );
    expect(buildRewindSummary({ ...input, restoreFiles: false })).toContain(
      "were left in the working tree",
    );
  });

  it("reports turns that changed no files", () => {
    const summary = buildRewindSummary({
      turnCount: 0,
      messages: [userMessage({ turn: 1, text: "what does this do?" })],
      checkpoints: [checkpoint({ turn: 1, files: [] })],
      restoreFiles: true,
    });

    expect(summary).toContain('1. "what does this do?" — no file changes');
  });

  it("pairs prompts to checkpoints by turn id, not by order", () => {
    const summary = buildRewindSummary({
      turnCount: 0,
      messages: [
        userMessage({ turn: 2, text: "second prompt" }),
        userMessage({ turn: 1, text: "first prompt" }),
      ],
      checkpoints: [checkpoint({ turn: 1 }), checkpoint({ turn: 2 })],
      restoreFiles: true,
    });

    expect(summary).toContain('1. "first prompt"');
    expect(summary).toContain('2. "second prompt"');
  });

  it("caps the turns, files, and prompt length it renders", () => {
    const turns = Array.from({ length: 15 }, (_, index) => index + 1);
    const summary = buildRewindSummary({
      turnCount: 0,
      messages: turns.map((turn) => userMessage({ turn, text: "x".repeat(400) })),
      checkpoints: turns.map((turn) =>
        checkpoint({
          turn,
          files: Array.from({ length: 12 }, (_, index) => `file-${index}.ts`),
        }),
      ),
      restoreFiles: true,
    });

    expect(summary).toContain("(+3 earlier discarded turns omitted)");
    expect(summary).toContain("(+4 more)");
    expect(summary).not.toContain("13. ");
    expect(summary).toContain("…");
  });

  it("collapses whitespace so a multi-line prompt stays one line", () => {
    const summary = buildRewindSummary({
      turnCount: 0,
      messages: [userMessage({ turn: 1, text: "first line\n\nsecond   line" })],
      checkpoints: [checkpoint({ turn: 1 })],
      restoreFiles: true,
    });

    expect(summary).toContain('1. "first line second line"');
  });
});
