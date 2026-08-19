import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";
import type { DraftThreadEnvMode } from "../composerDraftStore";

interface ThreadContextLike {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  branch?: string | null;
  worktreePath?: string | null;
  envMode?: DraftThreadEnvMode;
}

interface NewThreadHandler {
  (
    projectRef: ScopedProjectRef,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: DraftThreadEnvMode;
      startFromOrigin?: boolean;
      inheritThreadSettings?: boolean;
    },
    // The opened draft's identity, which most callers have no use for.
  ): Promise<unknown>;
}

export interface ChatThreadActionContext {
  readonly activeDraftThread: ThreadContextLike | null;
  readonly activeThread: ThreadContextLike | undefined;
  readonly defaultProjectRef: ScopedProjectRef | null;
  readonly handleNewThread: NewThreadHandler;
}

export function resolveNewDraftStartFromOrigin(input: {
  envMode: DraftThreadEnvMode;
  newWorktreesStartFromOrigin: boolean;
}): boolean {
  return input.envMode === "worktree" && input.newWorktreesStartFromOrigin;
}

export function resolveThreadActionProjectRef(
  context: ChatThreadActionContext,
): ScopedProjectRef | null {
  if (context.activeThread) {
    return scopeProjectRef(context.activeThread.environmentId, context.activeThread.projectId);
  }
  if (context.activeDraftThread) {
    return scopeProjectRef(
      context.activeDraftThread.environmentId,
      context.activeDraftThread.projectId,
    );
  }
  return context.defaultProjectRef;
}

export function resolveThreadActionWorkspace(
  context: Pick<ChatThreadActionContext, "activeDraftThread" | "activeThread">,
): {
  branch: string | null;
  worktreePath: string | null;
  envMode: DraftThreadEnvMode;
  startFromOrigin: false;
} | null {
  const source = context.activeThread ?? context.activeDraftThread;
  if (!source) return null;

  const worktreePath = source.worktreePath ?? null;
  return {
    branch: source.branch ?? null,
    worktreePath,
    envMode: source.envMode ?? (worktreePath ? "worktree" : "local"),
    // This is an existing checkout. Origin is only meaningful while creating
    // a brand-new worktree from the configured defaults.
    startFromOrigin: false,
  };
}

// Contextual new-thread entry points always preserve the project. The
// duplicate-context shortcut can additionally opt into the viewed thread's
// settings and checkout; ordinary creation uses configured/sticky defaults.
export async function startNewThreadFromContext(
  context: ChatThreadActionContext,
  options: { inheritThreadSettings?: boolean } = {},
): Promise<boolean> {
  const projectRef = resolveThreadActionProjectRef(context);
  if (!projectRef) {
    return false;
  }

  await context.handleNewThread(
    projectRef,
    options.inheritThreadSettings
      ? {
          ...resolveThreadActionWorkspace(context),
          inheritThreadSettings: true,
        }
      : undefined,
  );
  return true;
}
