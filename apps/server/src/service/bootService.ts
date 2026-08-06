/**
 * BootService - install T3 Code as a systemd user service.
 *
 * The unit execs the T3 Code entry point that installed it. Nothing is
 * downloaded: there is no pinned runtime install and no update launcher, so
 * `t3 service install` works on a machine with no internet access.
 *
 * @module BootService
 */
import {
  HostProcessArguments,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

const BOOT_SERVICE_NAME = "t3code";
export const BOOT_SERVICE_UNIT_FILE = `${BOOT_SERVICE_NAME}.service`;
export const BOOT_SERVICE_UNIT_ENV = "T3_BOOT_SERVICE_UNIT";

/** systemd expands `%` specifiers, including in unquoted append-log paths. */
export function escapeSystemdSpecifiers(value: string): string {
  return value.replaceAll("%", "%%");
}

export function quoteSystemdValue(value: string): string {
  const escaped = escapeSystemdSpecifiers(value);
  return /[\s"'\\]/.test(escaped)
    ? `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : escaped;
}

export interface BootServicePlan {
  readonly nodePath: string;
  readonly entryPath: string;
  readonly baseDir: string;
  readonly logPath: string;
  readonly unitPath: string;
}

/** Pure renderer: service units cannot rely on the user's shell or PATH. */
export function renderBootServiceUnit(plan: BootServicePlan): string {
  // The user manager has no reliable network-online target; server networking retries itself.
  return [
    "[Unit]",
    "Description=T3 Code server",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    "WorkingDirectory=%h",
    `Environment=T3CODE_HOME=${quoteSystemdValue(plan.baseDir)}`,
    `Environment=${BOOT_SERVICE_UNIT_ENV}=${BOOT_SERVICE_UNIT_FILE}`,
    `ExecStart=${quoteSystemdValue(plan.nodePath)} ${quoteSystemdValue(plan.entryPath)}`,
    "KillMode=control-group",
    "Restart=always",
    "RestartSec=5",
    `StandardOutput=append:${escapeSystemdSpecifiers(plan.logPath)}`,
    `StandardError=append:${escapeSystemdSpecifiers(plan.logPath)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export class BootServiceUnsupportedError extends Schema.TaggedErrorClass<BootServiceUnsupportedError>()(
  "BootServiceUnsupportedError",
  { platform: Schema.String },
) {
  override get message(): string {
    return `Background setup currently supports Linux with systemd; this machine reports '${this.platform}'.`;
  }
}

export class BootServiceCommandError extends Schema.TaggedErrorClass<BootServiceCommandError>()(
  "BootServiceCommandError",
  {
    step: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    stdoutLength: Schema.optional(Schema.Number),
    stderrLength: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.exitCode === undefined
      ? `Background setup failed while ${this.step}.`
      : `Background setup failed while ${this.step} (exit code ${this.exitCode}).`;
  }
}

export class BootServiceInstallError extends Schema.TaggedErrorClass<BootServiceInstallError>()(
  "BootServiceInstallError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not set up the T3 Code background service.";
  }
}

export type BootServiceError =
  | BootServiceUnsupportedError
  | BootServiceCommandError
  | BootServiceInstallError;

export interface BootServiceStatus {
  readonly supported: boolean;
  readonly installed: boolean;
  readonly current: boolean;
  readonly unitPath: string;
  readonly logPath: string;
}

export class BootService extends Context.Service<
  BootService,
  {
    readonly install: Effect.Effect<BootServicePlan, BootServiceError>;
    readonly uninstall: Effect.Effect<boolean, BootServiceError>;
    readonly status: Effect.Effect<BootServiceStatus, BootServiceError>;
  }
>()("t3/service/bootService") {}

export interface BootServiceHost {
  readonly execPath: string;
  readonly entryPath?: string;
}

export const make = Effect.fn("service.boot_service.make")(function* (input: {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly host?: BootServiceHost;
}) {
  const hostExecPath = yield* HostProcessExecutablePath;
  const hostArguments = yield* HostProcessArguments;
  const platform = yield* HostProcessPlatform;
  const homeDir = yield* Config.string("HOME").pipe(Config.withDefault(""));
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const host = input.host ?? { execPath: hostExecPath };

  const unitDir = path.join(homeDir, ".config", "systemd", "user");
  const unitPath = path.join(unitDir, BOOT_SERVICE_UNIT_FILE);
  const logPath = path.join(input.logsDir, "boot-service.log");
  // The unit runs the same entry point that installed it, so a service
  // install never has to reach a package registry.
  const entryPath = host.entryPath ?? path.resolve(hostArguments[1] ?? "");
  const writeDurably = (filePath: string, contents: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = path.dirname(filePath);
        yield* fs.makeDirectory(directory, { recursive: true });
        const tempPath = yield* fs.makeTempFileScoped({ directory, prefix: ".service-write-" });
        yield* fs.writeFileString(tempPath, contents, { mode: 0o600 });
        yield* (yield* fs.open(tempPath, { flag: "r" })).sync;
        yield* fs.rename(tempPath, filePath);
        yield* (yield* fs.open(directory, { flag: "r" })).sync;
      }),
    ).pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
  const plan: BootServicePlan = {
    nodePath: host.execPath,
    entryPath,
    baseDir: input.baseDir,
    logPath,
    unitPath,
  };

  const requireSystemdLinux = Effect.gen(function* () {
    if (platform !== "linux" || homeDir === "") {
      return yield* new BootServiceUnsupportedError({ platform });
    }
  });

  const runStep = Effect.fn("service.boot_service.run_step")(function* (
    step: string,
    command: string,
    args: ReadonlyArray<string>,
    options?: { readonly timeout?: Duration.Input },
  ) {
    return yield* runner.run({ command, args, timeout: options?.timeout }).pipe(
      Effect.mapError((cause) => new BootServiceCommandError({ step, cause })),
      Effect.filterOrFail(
        (result) => result.code === 0,
        (result) =>
          new BootServiceCommandError({
            step,
            exitCode: Number(result.code),
            stdoutLength: result.stdout.length,
            stderrLength: result.stderr.length,
          }),
      ),
      Effect.tapError((error) =>
        DateTime.now.pipe(
          Effect.flatMap((now) =>
            fs.writeFileString(logPath, `${DateTime.formatIso(now)} ${error.message}\n`, {
              flag: "a",
            }),
          ),
          Effect.ignore,
        ),
      ),
    );
  });

  const install: BootService["Service"]["install"] = Effect.gen(function* () {
    yield* requireSystemdLinux;
    yield* fs
      .makeDirectory(input.logsDir, { recursive: true })
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));

    const installed = yield* fs
      .exists(unitPath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
    if (installed) {
      yield* runStep("stopping the installed service", "systemctl", [
        "--user",
        "stop",
        BOOT_SERVICE_UNIT_FILE,
      ]);
    }

    yield* Effect.gen(function* () {
      yield* fs
        .makeDirectory(unitDir, { recursive: true })
        .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
      yield* writeDurably(unitPath, renderBootServiceUnit(plan));

      yield* runStep("reloading systemd user units", "systemctl", ["--user", "daemon-reload"]);
      yield* runStep("enabling the service", "systemctl", [
        "--user",
        "enable",
        BOOT_SERVICE_UNIT_FILE,
      ]);
      yield* runStep("enabling lingering for this user", "loginctl", ["enable-linger"]);
      // Start last. No administrative state write occurs after this succeeds.
      yield* runStep("starting the service", "systemctl", [
        "--user",
        "restart",
        BOOT_SERVICE_UNIT_FILE,
      ]);
    }).pipe(
      Effect.tapError(() =>
        installed
          ? runStep("restarting the service after a failed update", "systemctl", [
              "--user",
              "restart",
              BOOT_SERVICE_UNIT_FILE,
            ]).pipe(Effect.ignore)
          : Effect.void,
      ),
    );
    return plan;
  }).pipe(Effect.withSpan("service.boot_service.install"));

  const uninstall: BootService["Service"]["uninstall"] = Effect.gen(function* () {
    yield* requireSystemdLinux;
    if (
      !(yield* fs
        .exists(unitPath)
        .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause }))))
    )
      return false;
    yield* runStep("stopping the service", "systemctl", [
      "--user",
      "disable",
      "--now",
      BOOT_SERVICE_UNIT_FILE,
    ]);
    yield* fs
      .remove(unitPath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
    yield* runStep("reloading systemd user units", "systemctl", ["--user", "daemon-reload"]);
    return true;
  }).pipe(Effect.withSpan("service.boot_service.uninstall"));

  const status: BootService["Service"]["status"] = Effect.gen(function* () {
    if (platform !== "linux" || homeDir === "") {
      return { supported: false, installed: false, current: false, unitPath, logPath };
    }
    if (!(yield* fs.exists(unitPath))) {
      return { supported: true, installed: false, current: false, unitPath, logPath };
    }
    const unit = yield* fs.readFileString(unitPath);
    return {
      supported: true,
      installed: true,
      current: unit === renderBootServiceUnit(plan),
      unitPath,
      logPath,
    };
  }).pipe(
    Effect.mapError((cause) => new BootServiceInstallError({ cause })),
    Effect.withSpan("service.boot_service.status"),
  );

  return BootService.of({ install, uninstall, status });
});

export const layer = (input: {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly host?: BootServiceHost;
}) => Layer.effect(BootService, make(input));
