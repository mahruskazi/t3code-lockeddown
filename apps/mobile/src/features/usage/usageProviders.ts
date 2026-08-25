import type { UsageProviderKind } from "@t3tools/contracts";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

/**
 * Series and table order. The chart stacks providers from the bottom in this
 * order, so it also fixes which band sits on top of the bars.
 */
// [fork:pi] `pi` stacks last.
export const PROVIDER_ORDER: readonly UsageProviderKind[] = ["codex", "claude", "pi"];

export const PROVIDER_LABEL: Record<UsageProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  // [fork:pi]
  pi: "Pi",
};

/**
 * Claude's brand orange holds in both themes; Codex is neutral and must flip
 * with the theme or its bars vanish against the matching background. Pi's own
 * mark is monochrome, so its band gets an indigo that stays legible either way
 * and cannot be confused with Codex's neutral.
 */
export function useProviderColors(): Record<UsageProviderKind, string> {
  const { themeAppearance: scheme } = useAppearancePreferences();
  return {
    claude: "#d97757",
    codex: scheme === "dark" ? "#e6e6e6" : "#3c3c43",
    // [fork:pi]
    pi: "#818cf8",
  };
}
