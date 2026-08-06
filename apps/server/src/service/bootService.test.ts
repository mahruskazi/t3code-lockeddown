import { expect, it } from "@effect/vitest";

import * as BootService from "./bootService.ts";

it("execs the installing entry point directly", () => {
  const unit = BootService.renderBootServiceUnit({
    nodePath: "/usr/bin/node",
    entryPath: "/home/theo/.npm/_npx/t3/dist/bin.mjs",
    baseDir: "/home/theo/.t3",
    logPath: "/home/theo/.t3/userdata/logs/boot-service.log",
    unitPath: "/home/theo/.config/systemd/user/t3code.service",
  });

  expect(unit).toContain(
    "ExecStart=/usr/bin/node /home/theo/.npm/_npx/t3/dist/bin.mjs",
  );
  // Nothing in the unit points at a downloaded runtime: the locked-down build
  // never installs one.
  expect(unit).not.toContain("runtime/versions");
  expect(unit).toContain("Environment=T3CODE_HOME=/home/theo/.t3");
});

it("quotes paths that would otherwise split on whitespace", () => {
  const unit = BootService.renderBootServiceUnit({
    nodePath: "/usr/local/my node/bin/node",
    entryPath: "/home/theo/T3 Code/dist/bin.mjs",
    baseDir: "/home/theo/.t3",
    logPath: "/home/theo/.t3/userdata/logs/boot-service.log",
    unitPath: "/home/theo/.config/systemd/user/t3code.service",
  });

  expect(unit).toContain(
    'ExecStart="/usr/local/my node/bin/node" "/home/theo/T3 Code/dist/bin.mjs"',
  );
});

it("escapes systemd specifiers in append-log paths", () => {
  expect(BootService.escapeSystemdSpecifiers("/logs/%h/boot-service.log")).toBe(
    "/logs/%%h/boot-service.log",
  );
});
