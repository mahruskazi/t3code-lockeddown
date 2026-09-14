// @effect-diagnostics globalDate:off -- A fixed instant keeps calendar-window assertions deterministic.
import { describe, expect, it, vi } from "vite-plus/test";

import {
  enumerateHourStarts,
  formatDateTimeShort,
  formatHourShort,
  formatRelativeHourShort,
  makeWindow,
} from "./usageFormat.ts";

describe("hourly usage formatting", () => {
  it("enumerates 24 fixed buckets across a rolling window", () => {
    const hours = enumerateHourStarts("2026-08-10T12:37:00.000Z", "2026-08-11T12:37:00.000Z");

    expect(hours).toHaveLength(24);
    expect(hours[0]).toBe("2026-08-10T12:37:00.000Z");
    expect(hours[23]).toBe("2026-08-11T11:37:00.000Z");
  });

  it("formats rolling instants in the requested time zone", () => {
    expect(formatHourShort("2026-08-11T00:37:00.000Z", "UTC")).toBe("12 AM");
    expect(formatHourShort("2026-08-11T12:37:00.000Z", "UTC")).toBe("12 PM");
    expect(formatDateTimeShort("2026-08-11T17:37:00.000Z", "UTC")).toBe("Aug 11, 5 PM");
  });

  it("disambiguates repeated hours during a fall-back transition", () => {
    expect(formatHourShort("2026-11-01T05:37:00.000Z", "America/New_York")).toBe("1 AM EDT");
    expect(formatHourShort("2026-11-01T06:37:00.000Z", "America/New_York")).toBe("1 AM EST");
  });

  it("makes hourly tooltip dates relative to the window in its requested time zone", () => {
    const windowEnd = "2026-08-11T14:37:00.000Z";

    expect(formatRelativeHourShort("2026-08-10T17:37:00.000Z", windowEnd, "UTC")).toBe(
      "5 PM yesterday",
    );
    expect(formatRelativeHourShort("2026-08-11T14:37:00.000Z", windowEnd, "UTC")).toBe(
      "2 PM today",
    );
    expect(
      formatRelativeHourShort(
        "2026-08-11T01:37:00.000Z",
        "2026-08-11T10:37:00.000Z",
        "America/Los_Angeles",
      ),
    ).toBe("6 PM yesterday");
  });

  it("builds an exact minute-aligned 24-hour request", () => {
    const window = makeWindow("24h", new Date("2026-08-11T12:37:42.123Z"));

    expect(window.resolution).toBe("hour");
    expect(window.sinceTime).toBe("2026-08-10T12:37:00.000Z");
    expect(window.untilTime).toBe("2026-08-11T12:37:00.000Z");
  });

  it("runs month to date from the 1st of the viewer's month through today", () => {
    const window = inZone("America/Los_Angeles", () =>
      makeWindow("mtd", new Date("2026-09-13T18:00:00.000Z")),
    );

    expect(window.resolution).toBe("day");
    expect(window.sinceDay).toBe("2026-09-01");
    expect(window.untilDay).toBe("2026-09-13");
  });

  it("keeps month to date a single day on the 1st", () => {
    const window = inZone("UTC", () => makeWindow("mtd", new Date("2026-09-01T18:00:00.000Z")));

    expect(window.sinceDay).toBe("2026-09-01");
    expect(window.untilDay).toBe("2026-09-01");
  });

  it("ends month to date on the viewer's calendar day, not UTC's", () => {
    // Still Sep 30 in Los Angeles, so the window must not roll into October.
    const window = inZone("America/Los_Angeles", () =>
      makeWindow("mtd", new Date("2026-10-01T04:00:00.000Z")),
    );

    expect(window.sinceDay).toBe("2026-09-01");
    expect(window.untilDay).toBe("2026-09-30");
  });

  it("degrades an unknown resolved zone to UTC instead of crashing", () => {
    const resolved = new Intl.DateTimeFormat().resolvedOptions();
    const resolvedOptions = vi
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({ ...resolved, timeZone: "Etc/Unknown" });

    try {
      const now = new Date("2026-08-11T12:37:42.123Z");

      expect(makeWindow("24h", now).timeZone).toBe("UTC");
      expect(makeWindow("30d", now).timeZone).toBe("UTC");
    } finally {
      resolvedOptions.mockRestore();
    }
  });
});

/** Runs `build` as if the viewer's browser resolved to `timeZone`. */
function inZone<A>(timeZone: string, build: () => A): A {
  const resolved = new Intl.DateTimeFormat().resolvedOptions();
  const spy = vi
    .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
    .mockReturnValue({ ...resolved, timeZone });
  try {
    return build();
  } finally {
    spy.mockRestore();
  }
}
