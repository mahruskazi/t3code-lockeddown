import { describe, expect, it } from "@effect/vitest";

import {
  droppedPathMention,
  parseFileUriList,
  resolveDroppedComposerItems,
  splitDroppedComposerItems,
} from "./composerDroppedPaths";

const textFile = (name: string) => new File(["contents"], name, { type: "text/plain" });
const imageFile = (name: string) => new File(["bytes"], name, { type: "image/png" });
/** What a dropped folder looks like: no bytes, no type. */
const folder = (name: string) => new File([], name, { type: "" });

describe("parseFileUriList", () => {
  it("reads local file URIs and decodes escapes", () => {
    expect(parseFileUriList("file:///home/dev/my%20notes.md\r\nfile:///home/dev/src")).toEqual([
      "/home/dev/my notes.md",
      "/home/dev/src",
    ]);
  });

  it("drops comments, blanks, and URIs that are not local files", () => {
    expect(
      parseFileUriList(
        ["# comment", "", "https://example.com/a.txt", "file://other-host/etc/passwd"].join("\n"),
      ),
    ).toEqual([]);
  });

  it("strips the leading slash from a Windows drive URI", () => {
    expect(parseFileUriList("file:///C:/Users/dev/notes.md")).toEqual(["C:/Users/dev/notes.md"]);
  });
});

describe("resolveDroppedComposerItems", () => {
  it("prefers the desktop bridge path over the uri list", () => {
    const file = textFile("notes.md");

    const items = resolveDroppedComposerItems({
      files: [file],
      uriList: "file:///elsewhere/notes.md",
      readFilePath: () => "/home/dev/notes.md",
    });

    expect(items).toEqual([{ file, path: "/home/dev/notes.md" }]);
  });

  it("falls back to the uri list when the bridge has no path", () => {
    const items = resolveDroppedComposerItems({
      files: [textFile("a.md"), textFile("b.md")],
      uriList: "file:///home/dev/a.md\nfile:///home/dev/b.md",
      readFilePath: () => null,
    });

    expect(items.map((item) => item.path)).toEqual(["/home/dev/a.md", "/home/dev/b.md"]);
  });

  it("ignores a uri list that does not line up with the dropped files", () => {
    const items = resolveDroppedComposerItems({
      files: [textFile("a.md"), textFile("b.md")],
      uriList: "file:///home/dev/a.md",
      readFilePath: null,
    });

    expect(items.map((item) => item.path)).toEqual([null, null]);
  });
});

describe("droppedPathMention", () => {
  it("mentions a workspace file by its relative path", () => {
    expect(droppedPathMention("/repo/src/app.ts", "/repo")).toBe("[app.ts](src/app.ts)");
  });

  it("keeps paths outside the workspace absolute", () => {
    expect(droppedPathMention("/home/dev/spec.pdf", "/repo")).toBe(
      "[spec.pdf](/home/dev/spec.pdf)",
    );
  });

  it("does not treat a sibling directory as inside the workspace", () => {
    expect(droppedPathMention("/repo-other/app.ts", "/repo")).toBe("[app.ts](/repo-other/app.ts)");
  });

  it("relativizes across separator styles and a trailing root slash", () => {
    expect(droppedPathMention("C:\\repo\\src\\app.ts", "C:\\repo\\")).toBe("[app.ts](src/app.ts)");
  });
});

describe("splitDroppedComposerItems", () => {
  it("mentions files and folders while images keep attaching", () => {
    const image = imageFile("shot.png");

    const split = splitDroppedComposerItems({
      items: [
        { file: textFile("app.ts"), path: "/repo/src/app.ts" },
        { file: folder("fixtures"), path: "/repo/test/fixtures" },
        { file: image, path: "/repo/shot.png" },
      ],
      workspaceRoot: "/repo",
    });

    expect(split.mentions).toEqual(["[app.ts](src/app.ts)", "[fixtures](test/fixtures)"]);
    expect(split.attachments).toEqual([image]);
  });

  it("attaches items the client could not locate", () => {
    const file = textFile("app.ts");

    const split = splitDroppedComposerItems({
      items: [{ file, path: null }],
      workspaceRoot: "/repo",
    });

    expect(split.mentions).toEqual([]);
    expect(split.attachments).toEqual([file]);
  });
});
