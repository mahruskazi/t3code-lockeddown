import { describe, expect, it } from "vite-plus/test";

import { resolveDesktopPairingUrl } from "./pairingUrls";

describe("settings pairing URL helpers", () => {
  it("builds a direct backend pairing URL", () => {
    expect(resolveDesktopPairingUrl("http://127.0.0.1:3773", "PAIRCODE")).toBe(
      "http://127.0.0.1:3773/pair#token=PAIRCODE",
    );
  });
});
