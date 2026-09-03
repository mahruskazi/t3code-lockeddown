import { describe, expect, it, vi } from "@effect/vitest";
import {
  makeWorkspaceFileDropHandlers,
  type WorkspaceFileDragEvent,
  type WorkspaceFileDropHost,
} from "./workspaceFileDrop";

function makeDragEvent(options?: {
  types?: string[];
  files?: File[];
  uriList?: string;
  movedWithinTarget?: boolean;
}) {
  const preventDefault = vi.fn();
  const event = {
    dataTransfer: {
      types: options?.types ?? ["Files"],
      files: options?.files ?? [],
      getData: (format: string) => (format === "text/uri-list" ? (options?.uriList ?? "") : ""),
      dropEffect: "none",
    },
    relatedTarget: options?.movedWithinTarget ? ({} as EventTarget) : null,
    currentTarget: {
      contains: () => options?.movedWithinTarget ?? false,
    },
    preventDefault,
  } satisfies WorkspaceFileDragEvent;
  return { event, preventDefault };
}

function makeHost() {
  const setDragActive = vi.fn();
  const addDrop = vi.fn();
  const host = { setDragActive, addDrop } satisfies WorkspaceFileDropHost;
  return { host, setDragActive, addDrop };
}

describe("makeWorkspaceFileDropHandlers", () => {
  it("activates the target for an external file drag", () => {
    const { host, setDragActive } = makeHost();
    const { event, preventDefault } = makeDragEvent();

    makeWorkspaceFileDropHandlers(host).onDragEnter(event);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(setDragActive).toHaveBeenCalledWith(true);
  });

  it("ignores non-file drags", () => {
    const { host, setDragActive } = makeHost();
    const { event, preventDefault } = makeDragEvent({ types: ["text/plain"] });

    makeWorkspaceFileDropHandlers(host).onDragOver(event);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(setDragActive).not.toHaveBeenCalled();
  });

  it("does not flicker when the drag moves between children", () => {
    const { host, setDragActive } = makeHost();
    const { event } = makeDragEvent({ movedWithinTarget: true });

    const handlers = makeWorkspaceFileDropHandlers(host);
    handlers.onDragEnter(event);
    handlers.onDragLeave(event);

    expect(setDragActive).not.toHaveBeenCalled();
  });

  it("forwards dropped files with the drag's uri list and clears the active state", () => {
    const file = new File(["contents"], "example.txt", { type: "text/plain" });
    const { host, setDragActive, addDrop } = makeHost();
    const { event } = makeDragEvent({ files: [file], uriList: "file:///tmp/example.txt" });

    makeWorkspaceFileDropHandlers(host).onDrop(event);

    expect(setDragActive).toHaveBeenCalledWith(false);
    expect(addDrop).toHaveBeenCalledWith({
      files: [file],
      uriList: "file:///tmp/example.txt",
    });
  });
});
