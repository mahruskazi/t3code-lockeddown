import * as Schema from "effect/Schema";
import { USAGE_RANGES } from "@t3tools/shared/usageFormat";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";

const STORAGE_KEY = "t3code:usage-page-preferences:v1";
const MetricSchema = Schema.Literals(["cost", "tokens", "limits"]);
const UsagePagePreferencesSchema = Schema.Struct({
  metric: MetricSchema,
  range: Schema.Literals(USAGE_RANGES),
});
export type UsagePagePreferences = typeof UsagePagePreferencesSchema.Type;

const DEFAULTS: UsagePagePreferences = { metric: "cost", range: "30d" };

// The range used to be stored as a plain day count, which month to date cannot
// express: its length changes as the month goes on. Preferences saved under
// the old shape are read once and rewritten on the next save.
const LegacyPreferencesSchema = Schema.Struct({
  metric: MetricSchema,
  windowDays: Schema.Literals([1, 7, 30, 90]),
});
const LEGACY_RANGES = { 1: "24h", 7: "7d", 30: "30d", 90: "90d" } as const;

export function readUsagePagePreferences(): UsagePagePreferences {
  try {
    return getLocalStorageItem(STORAGE_KEY, UsagePagePreferencesSchema) ?? DEFAULTS;
  } catch (error) {
    try {
      const legacy = getLocalStorageItem(STORAGE_KEY, LegacyPreferencesSchema);
      if (legacy !== null)
        return { metric: legacy.metric, range: LEGACY_RANGES[legacy.windowDays] };
    } catch {
      // Not the old shape either, so report the original failure below.
    }
    console.error("Could not read Usage page preferences.", error);
    return DEFAULTS;
  }
}

export function saveUsagePagePreferences(preferences: UsagePagePreferences): void {
  try {
    setLocalStorageItem(STORAGE_KEY, preferences, UsagePagePreferencesSchema);
  } catch (error) {
    console.error("Could not save Usage page preferences.", error);
  }
}
