import type { OrchestrationThread } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildRewindPoints, DEFAULT_REWIND_OPTIONS } from "./rewindPoints.logic.ts";

/**
 * Builds a thread the way the projections really do: user messages carry a null
 * turnId, and the turn is only identifiable from the assistant reply that
 * follows. A fixture that puts a turnId on the prompt would pass while the real
 * app renders "(no prompt recorded)" for every row.
 */
const thread = (input: {
  readonly checkpoints: ReadonlyArray<{
    readonly turn: number;
    readonly files?: number;
  }>;
  readonly prompts: ReadonlyArray<{ readonly turn: number; readonly text: string }>;
}) =>
  ({
    messages: input.prompts.flatMap((prompt) => [
      {
        id: `message-${prompt.turn}`,
        role: "user",
        text: prompt.text,
        turnId: null,
        streaming: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: `assistant-${prompt.turn}`,
        role: "assistant",
        text: "ok",
        turnId: `turn-${prompt.turn}`,
        streaming: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]),
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

describe("DEFAULT_REWIND_OPTIONS", () => {
  it("leaves both axes off so a rewind touches only the conversation", () => {
    // Restoring the working tree can discard uncommitted work, so the picker
    // must never arrive pre-armed to do it.
    expect(DEFAULT_REWIND_OPTIONS.restoreFiles).toBe(false);
    expect(DEFAULT_REWIND_OPTIONS.includeSummary).toBe(false);
  });
});

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

  it("resolves prompts queued while an earlier turn was still running", () => {
    // Sending two messages back to back puts both prompts ahead of both
    // replies. They still have to land on their own turns.
    const points = buildRewindPoints({
      checkpoints: [1, 2].map((turn) => ({
        turnId: `turn-${turn}`,
        checkpointTurnCount: turn,
        checkpointRef: `r${turn}`,
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: "2026-01-01T00:00:00.000Z",
      })),
      messages: [
        { id: "u1", role: "user", text: "first", turnId: null },
        { id: "u2", role: "user", text: "second", turnId: null },
        { id: "a1", role: "assistant", text: "ok", turnId: "turn-1" },
        { id: "a2", role: "assistant", text: "ok", turnId: "turn-2" },
      ].map((message) => ({
        ...message,
        streaming: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      })),
    } as unknown as OrchestrationThread);

    expect(points.map((point) => point.prompt)).toEqual(["second", "first"]);
  });

  it("ignores later assistant messages in the same turn", () => {
    const points = buildRewindPoints({
      checkpoints: [
        {
          turnId: "turn-1",
          checkpointTurnCount: 1,
          checkpointRef: "r1",
          status: "ready",
          files: [],
          assistantMessageId: null,
          completedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      messages: [
        { id: "u1", role: "user", text: "the real prompt", turnId: null },
        { id: "a1", role: "assistant", text: "thinking", turnId: "turn-1" },
        { id: "a2", role: "assistant", text: "still going", turnId: "turn-1" },
      ].map((message) => ({
        ...message,
        streaming: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      })),
    } as unknown as OrchestrationThread);

    expect(points[0]?.prompt).toBe("the real prompt");
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
