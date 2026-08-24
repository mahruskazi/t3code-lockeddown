import type { OrchestrationThread } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildRewindPoints } from "./rewindPoints.logic.ts";

const thread = (input: {
  readonly checkpoints: ReadonlyArray<{
    readonly turn: number;
    readonly files?: number;
  }>;
  readonly prompts: ReadonlyArray<{ readonly turn: number; readonly text: string }>;
}) =>
  ({
    messages: input.prompts.map((prompt) => ({
      id: `message-${prompt.turn}`,
      role: "user",
      text: prompt.text,
      turnId: `turn-${prompt.turn}`,
      streaming: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })),
    checkpoints: input.checkpoints.map((checkpoint) => ({
      turnId: `turn-${checkpoint.turn}`,
      checkpointTurnCount: checkpoint.turn,
      checkpointRef: `refs/t3/checkpoints/${checkpoint.turn}`,
      status: "ready",
      files: Array.from({ length: checkpoint.files ?? 0 }, (_, index) => ({
        path: `file-${index}.ts`,
        kind: "modified",
        additions: 1,
        deletions: 0,
      })),
      assistantMessageId: null,
      completedAt: "2026-01-01T00:00:00.000Z",
    })),
  }) as unknown as OrchestrationThread;

describe("buildRewindPoints", () => {
  it("returns nothing for a missing thread or one with no turns", () => {
    expect(buildRewindPoints(null)).toEqual([]);
    expect(buildRewindPoints(thread({ checkpoints: [], prompts: [] }))).toEqual([]);
  });

  it("lists newest first and targets the turn before each prompt", () => {
    const points = buildRewindPoints(
      thread({
        checkpoints: [
          { turn: 1, files: 2 },
          { turn: 2, files: 1 },
          { turn: 3, files: 0 },
        ],
        prompts: [
          { turn: 1, text: "first" },
          { turn: 2, text: "second" },
          { turn: 3, text: "third" },
        ],
      }),
    );

    expect(points.map((point) => point.prompt)).toEqual(["third", "second", "first"]);
    // Rewinding "undoes" the listed prompt, so it targets the preceding turn.
    expect(points.map((point) => point.turnCount)).toEqual([2, 1, 0]);
    expect(points.map((point) => point.fileCount)).toEqual([0, 1, 2]);
    expect(points.map((point) => point.messageId)).toEqual(["message-3", "message-2", "message-1"]);
  });

  it("counts how many turns each point discards", () => {
    const points = buildRewindPoints(
      thread({
        checkpoints: [{ turn: 1 }, { turn: 2 }, { turn: 3 }],
        prompts: [
          { turn: 1, text: "first" },
          { turn: 2, text: "second" },
          { turn: 3, text: "third" },
        ],
      }),
    );

    expect(points.map((point) => point.discardedTurnCount)).toEqual([1, 2, 3]);
  });

  it("keeps a turn whose prompt is missing rather than dropping the point", () => {
    const points = buildRewindPoints(thread({ checkpoints: [{ turn: 1 }], prompts: [] }));

    expect(points).toHaveLength(1);
    expect(points[0]?.prompt).toBe("(no prompt recorded)");
    expect(points[0]?.messageId).toBeNull();
  });

  it("ignores the turn-0 baseline checkpoint", () => {
    const points = buildRewindPoints(
      thread({
        checkpoints: [{ turn: 0 }, { turn: 1 }],
        prompts: [{ turn: 1, text: "first" }],
      }),
    );

    expect(points).toHaveLength(1);
    expect(points[0]?.turnCount).toBe(0);
  });

  it("collapses whitespace in prompts so rows stay single-line", () => {
    const points = buildRewindPoints(
      thread({
        checkpoints: [{ turn: 1 }],
        prompts: [{ turn: 1, text: "  first\n\nline  " }],
      }),
    );

    expect(points[0]?.prompt).toBe("first line");
  });
});
