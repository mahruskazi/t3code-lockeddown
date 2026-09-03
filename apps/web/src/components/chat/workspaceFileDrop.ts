export interface WorkspaceFileDragEvent {
  readonly dataTransfer: {
    readonly types: ReadonlyArray<string>;
    readonly files: Iterable<File>;
    getData(format: string): string;
    dropEffect: string;
  };
  readonly relatedTarget: EventTarget | null;
  readonly currentTarget: {
    contains(target: Node | null): boolean;
  };
  preventDefault(): void;
}

export interface WorkspaceFileDrop {
  readonly files: File[];
  /**
   * The drag's `text/uri-list`, empty when the source withheld one. Carried
   * alongside the bytes because it is the only place a browser exposes where
   * a dropped file actually lives.
   */
  readonly uriList: string;
}

export interface WorkspaceFileDropHost {
  setDragActive(active: boolean): void;
  addDrop(drop: WorkspaceFileDrop): void;
}

function isFileDrag(event: WorkspaceFileDragEvent): boolean {
  return event.dataTransfer.types.includes("Files");
}

function movedWithinDropTarget(event: WorkspaceFileDragEvent): boolean {
  return event.relatedTarget !== null && event.currentTarget.contains(event.relatedTarget as Node);
}

export function makeWorkspaceFileDropHandlers(host: WorkspaceFileDropHost) {
  return {
    onDragEnter(event: WorkspaceFileDragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      if (movedWithinDropTarget(event)) return;
      host.setDragActive(true);
    },
    onDragOver(event: WorkspaceFileDragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      host.setDragActive(true);
    },
    onDragLeave(event: WorkspaceFileDragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      if (movedWithinDropTarget(event)) return;
      host.setDragActive(false);
    },
    onDrop(event: WorkspaceFileDragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      host.setDragActive(false);
      host.addDrop({
        files: Array.from(event.dataTransfer.files),
        uriList: event.dataTransfer.getData("text/uri-list"),
      });
    },
  };
}
