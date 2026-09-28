import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import type { UsageRange } from "@t3tools/shared/usageFormat";
import type { UsageChartMetric } from "./UsageProviderChart";
import { resolveShortcutCommand, type ShortcutEventLike } from "../../keybindings";

export type UsageMetric = UsageChartMetric | "limits";
export const METRIC_OPTIONS = [
  { value: "cost", label: "Cost", command: "usage.cost" },
  { value: "tokens", label: "Tokens", command: "usage.tokens" },
  { value: "limits", label: "Limits", command: "usage.limits" },
] as const satisfies readonly { value: UsageMetric; label: string; command: KeybindingCommand }[];

export const WINDOW_OPTIONS = [
  { value: "24h", label: "Past 24h", command: "usage.period.day" },
  { value: "7d", label: "7 days", command: "usage.period.week" },
  { value: "30d", label: "30 days", command: "usage.period.month" },
  { value: "90d", label: "90 days", command: "usage.period.quarter" },
] as const satisfies readonly { value: UsageRange; label: string; command: KeybindingCommand }[];

/** Every selectable period: the shortcut-bearing ones plus month to date. */
export const RANGE_OPTIONS = [
  ...WINDOW_OPTIONS,
  { value: "mtd", label: "This month", command: undefined },
] as const satisfies readonly {
  value: UsageRange;
  label: string;
  command: KeybindingCommand | undefined;
}[];

/** Resolves page shortcuts without taking letters from fields or popup controls. */
export function resolveUsageShortcut(
  event: ShortcutEventLike & { target: EventTarget | null },
  keybindings: ResolvedKeybindingsConfig,
) {
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable ||
      target.closest('[role="dialog"], [aria-modal="true"], [data-slot$="popup"]'))
  ) {
    return null;
  }

  return resolveShortcutCommand(event, keybindings, {
    context: { usagePageOpen: true },
  });
}
