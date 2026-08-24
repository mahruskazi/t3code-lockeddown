import type { OrchestrationThread } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { buildRewindPoints, type RewindPoint } from "./rewindPoints.logic.ts";

export interface RewindThreadRequest {
  readonly turnCount: number;
  readonly restoreFiles: boolean;
  readonly includeSummary: boolean;
}

interface RewindThreadDialogProps {
  readonly open: boolean;
  readonly thread: OrchestrationThread | null;
  readonly disabledReason: string | null;
  readonly isRewinding: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRewind: (request: RewindThreadRequest) => void;
}

const pluralize = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * The `/tree` picker: choose how far back to rewind, then whether the working
 * tree comes with it and whether the agent keeps a note of what was undone.
 */
export function RewindThreadDialog({
  open,
  thread,
  disabledReason,
  isRewinding,
  onOpenChange,
  onRewind,
}: RewindThreadDialogProps) {
  const points = useMemo(() => buildRewindPoints(thread), [thread]);
  const [selectedTurnCount, setSelectedTurnCount] = useState<number | null>(null);
  const [restoreFiles, setRestoreFiles] = useState(true);
  const [includeSummary, setIncludeSummary] = useState(false);

  // Each opening starts from the most recent point with the default axes, so a
  // choice made in one rewind never silently carries into the next.
  useEffect(() => {
    if (open) {
      setSelectedTurnCount(points[0]?.turnCount ?? null);
      setRestoreFiles(true);
      setIncludeSummary(false);
    }
  }, [open, points]);

  const selectedPoint =
    points.find((point) => point.turnCount === selectedTurnCount) ?? points[0] ?? null;
  const canRewind = selectedPoint !== null && disabledReason === null && !isRewinding;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isRewinding) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Rewind conversation</DialogTitle>
          <DialogDescription>
            Pick the message to rewind to. Everything after it is discarded from this thread.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="space-y-4">
          {points.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              This thread has no completed turns to rewind to yet.
            </p>
          ) : (
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {points.map((point) => (
                <RewindPointRow
                  key={point.turnCount}
                  point={point}
                  selected={selectedPoint?.turnCount === point.turnCount}
                  onSelect={() => {
                    setSelectedTurnCount(point.turnCount);
                  }}
                />
              ))}
            </div>
          )}

          {points.length > 0 && (
            <div className="space-y-2 border-border/70 border-t pt-3">
              <label className="flex cursor-pointer items-start gap-2.5">
                <Checkbox
                  checked={restoreFiles}
                  onCheckedChange={(checked) => {
                    setRestoreFiles(checked === true);
                  }}
                />
                <span className="grid gap-0.5">
                  <span className="font-medium text-sm">Also restore code changes</span>
                  <span className="text-muted-foreground text-xs">
                    Returns the working tree to this checkpoint. Leave off to rewind only the
                    conversation and keep the files as they are now.
                  </span>
                </span>
              </label>

              <label className="flex cursor-pointer items-start gap-2.5">
                <Checkbox
                  checked={includeSummary}
                  onCheckedChange={(checked) => {
                    setIncludeSummary(checked === true);
                  }}
                />
                <span className="grid gap-0.5">
                  <span className="font-medium text-sm">Keep a summary of the discarded work</span>
                  <span className="text-muted-foreground text-xs">
                    Gives the agent a short note of what was tried and undone, sent with your next
                    message.
                  </span>
                </span>
              </label>
            </div>
          )}

          {disabledReason !== null && <p className="text-destructive text-xs">{disabledReason}</p>}
        </DialogPanel>

        <DialogFooter>
          <Button
            variant="ghost"
            disabled={isRewinding}
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!canRewind}
            onClick={() => {
              if (selectedPoint) {
                onRewind({
                  turnCount: selectedPoint.turnCount,
                  restoreFiles,
                  includeSummary,
                });
              }
            }}
          >
            {isRewinding
              ? "Rewinding…"
              : selectedPoint
                ? `Rewind ${pluralize(selectedPoint.discardedTurnCount, "turn")}`
                : "Rewind"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function RewindPointRow({
  point,
  selected,
  onSelect,
}: {
  readonly point: RewindPoint;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full rounded-lg border px-3 py-2 text-left transition-colors",
        selected ? "border-primary/64 bg-primary/8" : "border-transparent hover:bg-muted/40",
      )}
    >
      <p className="truncate font-medium text-sm">{point.prompt}</p>
      <p className="text-muted-foreground text-xs">
        Discards {pluralize(point.discardedTurnCount, "turn")} ·{" "}
        {point.fileCount === 0 ? "no file changes" : pluralize(point.fileCount, "file")}
      </p>
    </button>
  );
}
