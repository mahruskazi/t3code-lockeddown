// [fork:pi] Pi is a fork-local provider; this whole file is fork code.
import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";

/**
 * Environment overrides Pi honours for its own state, in the order Pi applies
 * them. Mirrors `ENV_SESSION_DIR` / `ENV_AGENT_DIR` in the CLI's `config.ts`.
 */
const PI_SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";
const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/**
 * Resolves the directory Pi writes session transcripts into.
 *
 * Pi stores one JSONL file per session under `<agentDir>/sessions/<encoded-cwd>/`,
 * so the returned path is a root to walk, not a flat directory. Resolution
 * order matches Pi's own: an explicit session dir wins, then an agent dir
 * override, then `~/.pi/agent/sessions`.
 *
 * `PiSettings` carries no home path today, so only the environment can move
 * this. Reading the server's own environment is right: the adapter spawns `pi`
 * with the same variables inherited.
 */
export const resolvePiSessionsDir = Effect.fn("resolvePiSessionsDir")(function* (
  env: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;

  const sessionDir = env[PI_SESSION_DIR_ENV]?.trim();
  if (sessionDir !== undefined && sessionDir.length > 0) {
    return path.resolve(expandHomePath(sessionDir));
  }

  const agentDir = env[PI_AGENT_DIR_ENV]?.trim();
  if (agentDir !== undefined && agentDir.length > 0) {
    return path.resolve(expandHomePath(agentDir), "sessions");
  }

  return path.resolve(NodeOS.homedir(), ".pi", "agent", "sessions");
});
