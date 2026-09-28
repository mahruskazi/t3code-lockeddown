import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Argument, Command } from "effect/unstable/cli";
import * as CliError from "effect/unstable/cli/CliError";

import * as NetService from "@t3tools/shared/Net";
import packageJson from "../package.json" with { type: "json" };
import { authCommand } from "./cli/auth.ts";
import { appCommand } from "./cli/app.ts";
import { connectCommand } from "./cli/connect.ts";
import { pairCommand } from "./cli/pair.ts";
import { hasCloudPublicConfig } from "./cloud/publicConfig.ts";
import { sharedServerCommandFlags } from "./cli/config.ts";
import { isEntrypoint } from "./entrypoint.ts";
import { projectCommand } from "./cli/project.ts";
import { runServerCommand, serveCommand, startCommand } from "./cli/server.ts";
import { serviceCommand } from "./cli/service.ts";
import { uninstallCommand } from "./cli/uninstall.ts";
import { claudeHistoryCommand } from "./cli/claudeHistory.ts";
import { serviceLauncherCommand } from "./cli/serviceLauncher.ts";
import { servicePreflightCommand } from "./cli/servicePreflight.ts";
import { sshHelperCommand } from "./cli/sshHelper.ts";
import { themeCommand } from "./cli/theme.ts";
import { traceCommand } from "./cli/trace.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

const connectPublicConfigMissingMessage =
  "T3 Connect commands are unavailable: this build is missing T3 Connect public configuration.";

class ConnectPublicConfigMissingError extends CliError.UserError {
  override get message() {
    return connectPublicConfigMissingMessage;
  }
}

const connectUnavailableCommand = Command.make("connect", {
  command: Argument.String("command").pipe(Argument.variadic),
}).pipe(
  Command.withDescription("T3 Connect is unavailable in builds without public configuration."),
  Command.unlisted,
  Command.withHandler(() =>
    Effect.fail(
      new CliError.ShowHelp({
        commandPath: ["t3", "connect"],
        errors: [new ConnectPublicConfigMissingError({ cause: connectPublicConfigMissingMessage })],
      }),
    ),
  ),
);

/**
 * [fork:lockdown] Upstream registers a `triage` command that seeds a local
 * coding agent to read the state database, provider event log, and terminal
 * logs, then file a public issue on pingdotgg/t3code. On a machine holding
 * proprietary code that evidence is the confidential material, and upstream's
 * redaction step covers credentials and home paths but not source, prompts, or
 * repo identities. This fork does not register it.
 *
 * [fork:lockdown] Upstream also registers `update`, which downloads a
 * pingdotgg/t3code GitHub release archive and runs it. This fork runs only
 * builds it provisioned (invariant 2), so it does not register that either.
 * `cli/update.ts` stays because `uninstall` reuses its launcher helpers.
 * Tripwire: bin.test.ts asserts `triage` and `update` are absent from the CLI.
 */
export const makeCli = ({ cloudEnabled = hasCloudPublicConfig } = {}) =>
  Command.make("t3", { ...sharedServerCommandFlags }).pipe(
    Command.withDescription("Run the T3 Code server."),
    Command.withHandler((flags) => runServerCommand(flags)),
    Command.withSubcommands([
      startCommand,
      serveCommand,
      appCommand,
      pairCommand,
      authCommand,
      projectCommand,
      serviceCommand,
      uninstallCommand,
      serviceLauncherCommand,
      claudeHistoryCommand,
      servicePreflightCommand,
      sshHelperCommand,
      themeCommand,
      traceCommand,
      cloudEnabled ? connectCommand : connectUnavailableCommand,
    ]),
  );

export const cli = makeCli();

if (
  isEntrypoint({
    moduleUrl: import.meta.url,
    entryPath: process.argv[1],
    runtimeMain: import.meta.main,
  })
) {
  Command.run(cli, { version: packageJson.version }).pipe(
    Effect.scoped,
    Effect.provide(CliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
