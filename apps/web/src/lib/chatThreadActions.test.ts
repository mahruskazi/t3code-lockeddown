import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  resolveThreadActionProjectRef,
  resolveThreadActionWorkspace,
  resolveNewDraftStartFromOrigin,
  startNewThreadFromContext,
  type ChatThreadActionContext,
} from "./chatThreadActions";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const FALLBACK_PROJECT_ID = ProjectId.make("project-2");

function createContext(overrides: Partial<ChatThreadActionContext> = {}): ChatThreadActionContext {
  return {
    activeDraftThread: null,
    activeThread: undefined,
    defaultProjectRef: scopeProjectRef(ENVIRONMENT_ID, FALLBACK_PROJECT_ID),
    handleNewThread: async () => {},
    ...overrides,
  };
}

describe("chatThreadActions", () => {
  it("only applies the start-from-origin default to new worktree drafts", () => {
    expect(
      resolveNewDraftStartFromOrigin({
        envMode: "worktree",
        newWorktreesStartFromOrigin: true,
      }),
    ).toBe(true);
    expect(
      resolveNewDraftStartFromOrigin({
        envMode: "local",
        newWorktreesStartFromOrigin: true,
      }),
    ).toBe(false);
  });

  it("prefers the active thread project when resolving thread actions", () => {
    const projectRef = resolveThreadActionProjectRef(
      createContext({
        activeThread: {
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
        },
      }),
    );

    expect(projectRef).toEqual(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID));
  });

  it("falls back to the active draft thread project when there is no active thread", () => {
    const projectRef = resolveThreadActionProjectRef(
      createContext({
        activeDraftThread: {
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
        },
      }),
    );

    expect(projectRef).toEqual(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID));
  });

  it("falls back to the default project ref when there is no active thread context", () => {
    const projectRef = resolveThreadActionProjectRef(
      createContext({
        defaultProjectRef: scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID),
      }),
    );

    expect(projectRef).toEqual(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID));
  });

  it("inherits the project and checkout from context", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});

    const didStart = await startNewThreadFromContext(
      createContext({
        activeThread: {
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          branch: "feature/sidebar-groups",
          worktreePath: "/repo/.worktrees/sidebar-groups",
        },
        handleNewThread,
      }),
      { inheritThreadSettings: true },
    );

    expect(didStart).toBe(true);
    expect(handleNewThread).toHaveBeenCalledWith(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), {
      branch: "feature/sidebar-groups",
      worktreePath: "/repo/.worktrees/sidebar-groups",
      envMode: "worktree",
      startFromOrigin: false,
      inheritThreadSettings: true,
    });
  });

  it("uses normal new-thread defaults unless inheritance is requested", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});

    await startNewThreadFromContext(
      createContext({
        activeThread: {
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          branch: "feature/sidebar-groups",
          worktreePath: "/repo/.worktrees/sidebar-groups",
        },
        handleNewThread,
      }),
    );

    expect(handleNewThread).toHaveBeenCalledWith(
      scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID),
      undefined,
    );
  });

  it("preserves a draft's explicit local checkout mode", () => {
    expect(
      resolveThreadActionWorkspace({
        activeThread: undefined,
        activeDraftThread: {
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          branch: "main",
          worktreePath: null,
          envMode: "local",
        },
      }),
    ).toEqual({
      branch: "main",
      worktreePath: null,
      envMode: "local",
      startFromOrigin: false,
    });
  });

  it("does not start a thread when there is no project context", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});

    const didStart = await startNewThreadFromContext(
      createContext({
        defaultProjectRef: null,
        handleNewThread,
      }),
    );

    expect(didStart).toBe(false);
    expect(handleNewThread).not.toHaveBeenCalled();
  });
});
