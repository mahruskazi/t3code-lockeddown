import { userMessageByTurnId, type MessageId, type OrchestrationThread } from "@t3tools/contracts";

/**
 * One selectable entry in the rewind picker: the state the thread returns to
 * when the turn that follows it is discarded.
 */
export interface RewindPoint {
  /** Checkpoint turn count to rewind to. */
  readonly turnCount: number;
  /** The user prompt that opened the turn being discarded. */
  readonly prompt: string;
  /** Id of that user message, for scrolling the timeline to it. */
  readonly messageId: MessageId | null;
  /** Number of files the discarded turn touched. */
  readonly fileCount: number;
  /** When the discarded turn finished. */
  readonly completedAt: string | null;
  /** How many turns are discarded by rewinding here. */
  readonly discardedTurnCount: number;
}

const collapseWhitespace = (value: string) => value.replace(/\s+/gu, " ").trim();

/**
 * Builds the rewind picker's list from a thread, newest first.
 *
 * A point is offered per completed turn: choosing the turn-N entry rewinds to
 * turn N-1, so the listed prompt is the one that gets replayable again. Turns
 * without a resolvable checkpoint are skipped, since the server can only
 * rewind to a checkpoint it recorded.
 */
export function buildRewindPoints(thread: OrchestrationThread | null): RewindPoint[] {
  if (!thread) {
    return [];
  }

  const openerByTurnId = userMessageByTurnId(thread.messages);

  const ordered = thread.checkpoints
    .filter((checkpoint) => checkpoint.checkpointTurnCount > 0)
    .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount);

  const latestTurnCount = ordered.at(-1)?.checkpointTurnCount ?? 0;

  return ordered
    .map((checkpoint) => {
      const opener = openerByTurnId.get(checkpoint.turnId);
      const prompt = collapseWhitespace(opener?.text ?? "");
      return {
        turnCount: checkpoint.checkpointTurnCount - 1,
        prompt: prompt || "(no prompt recorded)",
        messageId: opener?.id ?? null,
        fileCount: checkpoint.files.length,
        completedAt: checkpoint.completedAt ?? null,
        discardedTurnCount: Math.max(1, latestTurnCount - checkpoint.checkpointTurnCount + 1),
      } satisfies RewindPoint;
    })
    .toReversed();
}
