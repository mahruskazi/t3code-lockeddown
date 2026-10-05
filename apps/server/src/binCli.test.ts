import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/cli";
import * as TestConsole from "effect/testing/TestConsole";

import * as NetService from "@t3tools/shared/Net";

import { makeCli } from "./binCli.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

const helpOutput = (cloudEnabled: boolean) =>
  Effect.gen(function* () {
    yield* Command.runWith(makeCli({ cloudEnabled }), { version: "0.0.0" })(["--help"]);
    return (
      (yield* TestConsole.logLines).findLast((line): line is string => typeof line === "string") ??
      ""
    );
  }).pipe(Effect.provide(Layer.mergeAll(CliRuntimeLayer, TestConsole.layer)));

// [fork:lockdown] Tripwire: `t3 triage` seeds a coding agent to mine the state
// database, provider event log, and terminal logs for evidence and file it in a
// public upstream issue. `t3 update` downloads a pingdotgg/t3code release
// archive from GitHub and runs it (invariant 2). This fork registers neither;
// an upstream merge that restores either registration fails here.
it.effect("does not register the upstream triage or self-download update commands", () =>
  Effect.gen(function* () {
    for (const cloudEnabled of [true, false]) {
      const output = yield* helpOutput(cloudEnabled);

      // The sibling commands prove the subcommand list is what is being read.
      assert.match(output, /^\s+uninstall\b/m);
      assert.match(output, /^\s+project\b/m);
      assert.notInclude(output, "triage");
      assert.notMatch(output, /^\s+update\b/m);
    }
  }),
);
