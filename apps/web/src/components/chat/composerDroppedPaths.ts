/**
 * OS file drops carry a filesystem path the browser deliberately hides. When
 * the client runs on the environment's machine that path is worth more to the
 * agent than the bytes are: it can read the file (or walk the folder) in
 * place, with no upload and no size cap. Resolving it lets the composer turn a
 * dropped file or folder into a mention instead of refusing it as an
 * unattachable file.
 *
 * Two sources, in order of trust:
 * - Electron's `webUtils.getPathForFile`, through the desktop bridge. Exact,
 *   and the only source that survives a Chromium drop from Finder/Explorer.
 * - The drag's `text/uri-list`, which Firefox and most GTK file managers
 *   populate with `file://` URIs alongside the files themselves.
 */
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";

import { classifyComposerAttachmentFile } from "./composerAttachmentFiles";

/**
 * A dropped item paired with the path it came from. `path` is null whenever
 * the drop source gave bytes but no location, which is every browser that
 * withholds `text/uri-list`.
 */
export interface DroppedComposerItem {
  readonly file: File;
  readonly path: string | null;
}

export interface DroppedComposerSplit {
  /** Items to stage as attachments, in drop order. */
  readonly attachments: File[];
  /** Mention text for items resolved to a path, in drop order. */
  readonly mentions: string[];
}

/** Read a `file://` line back into a filesystem path, ignoring anything else. */
function parseFileUri(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  // A remote host in a file URI names another machine's disk; only the local
  // form ("" or "localhost") describes a path this environment can open.
  if (url.protocol !== "file:" || (url.host !== "" && url.host !== "localhost")) {
    return null;
  }
  try {
    const decoded = decodeURIComponent(url.pathname);
    // Windows URIs carry the drive as "/C:/…"; the leading slash is not part
    // of the path.
    return /^\/[a-zA-Z]:[/\\]/.test(decoded) ? decoded.slice(1) : decoded;
  } catch {
    return null;
  }
}

/** Paths named by a drag's `text/uri-list`, in the order the source listed them. */
export function parseFileUriList(uriList: string): ReadonlyArray<string> {
  return uriList
    .split(/\r?\n/)
    .map(parseFileUri)
    .filter((path): path is string => path !== null);
}

/**
 * Pair each dropped file with its path. The URI list is only trusted when it
 * lines up one-for-one with the files, since that is the only case where its
 * order is known to describe the same items.
 */
export function resolveDroppedComposerItems(input: {
  readonly files: ReadonlyArray<File>;
  readonly uriList: string;
  readonly readFilePath: ((file: File) => string | null) | null;
}): ReadonlyArray<DroppedComposerItem> {
  const uriPaths = parseFileUriList(input.uriList);
  const alignedUriPaths = uriPaths.length === input.files.length ? uriPaths : [];
  return input.files.map((file, index) => ({
    file,
    path: input.readFilePath?.(file) || (alignedUriPaths[index] ?? null),
  }));
}

const normalizeSeparators = (path: string): string => path.replaceAll("\\", "/");

/**
 * Paths inside the workspace are mentioned relative to it, matching what a
 * drag from the file tree produces. Anything outside keeps its absolute form,
 * which is what the agent needs to find it.
 */
export function droppedPathMention(path: string, workspaceRoot: string | null): string {
  const trimmed = normalizeSeparators(path).replace(/\/+$/, "");
  const root = workspaceRoot === null ? "" : normalizeSeparators(workspaceRoot).replace(/\/+$/, "");
  const relative =
    root.length > 0 && trimmed.startsWith(`${root}/`) ? trimmed.slice(root.length + 1) : path;
  return serializeComposerFileLink(relative);
}

/**
 * Route each dropped item to the composer path that suits it: images still
 * attach, because every provider ingests them inline, and everything else
 * with a resolved path becomes a mention. Items with no path fall back to
 * attaching, so a drop the client cannot locate behaves as it always has.
 */
export function splitDroppedComposerItems(input: {
  readonly items: ReadonlyArray<DroppedComposerItem>;
  readonly workspaceRoot: string | null;
}): DroppedComposerSplit {
  const attachments: File[] = [];
  const mentions: string[] = [];
  for (const item of input.items) {
    if (item.path === null || classifyComposerAttachmentFile(item.file) === "image") {
      attachments.push(item.file);
      continue;
    }
    mentions.push(droppedPathMention(item.path, input.workspaceRoot));
  }
  return { attachments, mentions };
}
