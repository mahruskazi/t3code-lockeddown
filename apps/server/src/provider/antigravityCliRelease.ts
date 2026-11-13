import * as Schema from "effect/Schema";
import { compareSemverVersions } from "@t3tools/shared/semver";

export const ANTIGRAVITY_CLI_MANIFEST_BASE =
  "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";

const Manifest = Schema.Struct({
  version: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/u)),
  url: Schema.String,
  sha512: Schema.String.check(Schema.isPattern(/^[a-fA-F0-9]{128}$/u)),
});
const decodeManifest = Schema.decodeUnknownOption(Manifest);

export interface AntigravityCliReleaseAsset {
  readonly version: string;
  readonly url: string;
  readonly sha512: string;
  readonly executable: { readonly name: string };
  readonly format: "tar.gz" | "executable";
}

export function antigravityCliTarget(platform: NodeJS.Platform, arch: string, musl = false) {
  if (!["darwin", "linux", "win32"].includes(platform) || !["x64", "arm64"].includes(arch)) {
    return null;
  }
  const os = platform === "win32" ? "windows" : platform;
  return `${os}_${arch === "x64" ? "amd64" : arch}${platform === "linux" && musl ? "_musl" : ""}`;
}

export function parseAntigravityCliRelease(
  value: unknown,
  platform: NodeJS.Platform,
  arch: string,
  musl = false,
): AntigravityCliReleaseAsset | null {
  const decoded = decodeManifest(value);
  if (decoded._tag === "None" || antigravityCliTarget(platform, arch, musl) === null) return null;
  const manifest = decoded.value;
  if (compareSemverVersions(manifest.version, "1.5.0") < 0) return null;
  const os = platform === "darwin" ? "mac" : platform === "win32" ? "windows" : "linux";
  const cpu = arch === "x64" ? "x64" : "arm64";
  const suffix = platform === "linux" && musl ? "_musl" : "";
  const extension = platform === "win32" ? "exe" : "tar.gz";
  const folder = `${platform === "win32" ? "windows" : platform}-${arch === "arm64" ? "arm" : "x64"}${suffix ? "-musl" : ""}`;
  const prefix = `https://storage.googleapis.com/antigravity-public/antigravity-cli/${manifest.version}-`;
  const rest = manifest.url.startsWith(prefix) ? manifest.url.slice(prefix.length) : "";
  if (
    !/^\d+\//u.test(rest) ||
    rest.replace(/^\d+\//u, "") !== `${folder}/cli_${os}_${cpu}${suffix}.${extension}`
  ) {
    return null;
  }
  return {
    version: manifest.version,
    url: manifest.url,
    sha512: manifest.sha512.toLowerCase(),
    executable: { name: platform === "win32" ? "agy.exe" : "antigravity" },
    format: platform === "win32" ? "executable" : "tar.gz",
  };
}

// [fork:lockdown] Upstream installs whatever its update manifest names at fetch time. This fork
// installs only this release, its sha512 copied from that manifest, so a reviewed commit fixes the
// bytes (invariant 2). Bump all three constants together. Tripwire: antigravityCliRelease.test.ts.
const PINNED_ANTIGRAVITY_CLI_VERSION = "1.5.7";
const PINNED_ANTIGRAVITY_CLI_BUILD = "6190022064472064";
const PINNED_ANTIGRAVITY_CLI_ASSETS: Readonly<Record<string, readonly [string, string]>> = {
  linux_amd64: [
    "linux-x64/cli_linux_x64.tar.gz",
    "60bca280414ed11723f58b3b671962ae394cc2d0c25e3f58e32e1c6847c978cbc77ec6f40e7f3992001c399d80aeb8b64c9ec892abddd591b12413c5ee6d9fce",
  ],
  linux_arm64: [
    "linux-arm/cli_linux_arm64.tar.gz",
    "bebd69ad1713414b82e370aec6be0e678a413332bf3c835d9ba22e4befff040b6c74e1bf974fd83ebc4c733ed6e37d2bdc1caae58027c2b326dd04d630bfebb1",
  ],
  linux_amd64_musl: [
    "linux-x64-musl/cli_linux_x64_musl.tar.gz",
    "3617bdb940c328fa1013c114049b2600c1dc7b864e8ea68ec636b606f2a900b8f79f1575e5aacc4375d73a1d973029c64870c6e875d64a5c8c22800d7768ec38",
  ],
  linux_arm64_musl: [
    "linux-arm-musl/cli_linux_arm64_musl.tar.gz",
    "a5f6cfdcb4b98878930add1911f43553726735f30c2575b744bd8fb88d143f8c5073aa1bc2aa4236b9eef22ddf1fb10b99a62687b532519fe761f0c1a7708cc5",
  ],
  darwin_arm64: [
    "darwin-arm/cli_mac_arm64.tar.gz",
    "c9746409083a9b15c217757aa2ef399ee7d4398602a30038583ea45196fc27d1662745341e45a116c07be19c08587de1e5929e365d2a46aea385fa33f0c2396a",
  ],
  darwin_amd64: [
    "darwin-x64/cli_mac_x64.tar.gz",
    "554190daa4a9faac612d902121f46bedf2e6200c3a07461f5eee8e7c6772b5192956751ffaf67835057fc666d139875522a2d0f92b45745176e3b95c167d5a48",
  ],
  windows_amd64: [
    "windows-x64/cli_windows_x64.exe",
    "d7303a9ac4597b4efea5dfdf40f648525ab5825badde2fabdb96a57196b71f6f16b645370e7933cc93a532389367799222b8356944454abe646d93c7ff2b1b38",
  ],
  windows_arm64: [
    "windows-arm/cli_windows_arm64.exe",
    "7e364822f2ed51d9caecc8279d33edfb7e5a20c19b95d0d2ab7bec2e61dff3250e19dd74ced40249abc28894c64fadb78b683bd549becbfd4a82d13a26b35e69",
  ],
};

/** The pinned release for this machine, or null where none is pinned. */
export function pinnedAntigravityCliRelease(
  platform: NodeJS.Platform,
  arch: string,
  musl = false,
): AntigravityCliReleaseAsset | null {
  const target = antigravityCliTarget(platform, arch, musl);
  const pinned = target === null ? undefined : PINNED_ANTIGRAVITY_CLI_ASSETS[target];
  if (pinned === undefined) return null;
  const [file, sha512] = pinned;
  return parseAntigravityCliRelease(
    {
      version: PINNED_ANTIGRAVITY_CLI_VERSION,
      url: `https://storage.googleapis.com/antigravity-public/antigravity-cli/${PINNED_ANTIGRAVITY_CLI_VERSION}-${PINNED_ANTIGRAVITY_CLI_BUILD}/${file}`,
      sha512,
    },
    platform,
    arch,
    musl,
  );
}
