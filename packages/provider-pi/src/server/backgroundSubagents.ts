import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// T3 stops a running child by sending this extension command with the child's id.
export const PI_SUBAGENT_STOP_COMMAND = "t3-subagent-stop";

// Extensions publish RPC metadata with appendEntry(), independently of tool
// names, formatted output, and model-visible result delivery.
// New or changed transcript items since the extension's last entry, keyed by a stable id.
const Activity = Schema.Struct({
  id: Schema.NonEmptyString,
  kind: Schema.Literals(["message", "tool"]),
  status: Schema.optional(Schema.Literals(["running", "completed", "failed"])),
  text: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
  input: Schema.optional(Schema.String),
  output: Schema.optional(Schema.String),
});

const Lifecycle = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.NonEmptyString,
  toolCallId: Schema.NonEmptyString,
  status: Schema.Literals(["running", "completed", "failed", "interrupted"]),
  title: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  model: Schema.optional(Schema.NullOr(Schema.String)),
  progress: Schema.optional(Schema.NullOr(Schema.String)),
  result: Schema.optional(Schema.NullOr(Schema.String)),
  activity: Schema.optional(Schema.Array(Activity)),
});
const Entry = Schema.Struct({
  type: Schema.Literal("custom"),
  customType: Schema.Literal("t3-subagent"),
  data: Lifecycle,
});
const decode = Schema.decodeUnknownOption(Entry);

export type PiBackgroundSubagentUpdate = typeof Lifecycle.Type;
export type PiBackgroundSubagentActivity = typeof Activity.Type;

export function piBackgroundSubagentEntryUpdate(entry: unknown): PiBackgroundSubagentUpdate | null {
  const decoded = decode(entry);
  if (Option.isNone(decoded)) return null;
  const data = decoded.value.data;
  return {
    ...data,
    ...(data.title === undefined ? {} : { title: data.title.slice(0, 160) }),
    ...(data.prompt === undefined ? {} : { prompt: data.prompt.slice(0, 10_000) }),
    ...(data.model === undefined ? {} : { model: data.model?.slice(0, 512) ?? null }),
    ...(data.progress === undefined ? {} : { progress: data.progress?.slice(0, 200) ?? null }),
    ...(data.result === undefined ? {} : { result: data.result?.slice(0, 10_000) ?? null }),
    ...(data.activity === undefined
      ? {}
      : {
          activity: data.activity.slice(0, 100).map((item) => ({
            ...item,
            id: item.id.slice(0, 256),
            ...(item.text === undefined ? {} : { text: item.text.slice(0, 10_000) }),
            ...(item.toolName === undefined ? {} : { toolName: item.toolName.slice(0, 256) }),
            ...(item.input === undefined ? {} : { input: item.input.slice(0, 4_000) }),
            ...(item.output === undefined ? {} : { output: item.output.slice(0, 10_000) }),
          })),
        }),
  };
}
