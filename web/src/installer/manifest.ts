export interface FirmwareRelease {
  version: string;
  board: "tufty2350";
  name: string;
  description: string;
  uf2Url: string;
  sha256: string;
  bytes: number;
}

// A UF2 stores a 256-byte flash page in each 512-byte block. The WebUSB writer
// reserves the final MiB. Allow one optional RP2350-E10 prefix block as well.
export const MAX_FIRMWARE_BYTES = 30 * 1024 * 1024 + 512;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only publisher-controlled, same-origin, content-addressed releases. */
export function parseReleaseManifest(value: unknown): FirmwareRelease | null {
  if (!object(value) || value.schemaVersion !== 1) {
    throw new Error("This firmware catalog is not supported. Please reload later.");
  }
  if (value.release === null) return null;
  const release = value.release;
  if (
    !object(release) ||
    typeof release.version !== "string" ||
    !VERSION.test(release.version) ||
    release.board !== "tufty2350" ||
    typeof release.name !== "string" ||
    release.name.length < 1 ||
    release.name.length > 120 ||
    typeof release.description !== "string" ||
    release.description.length > 500 ||
    typeof release.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(release.sha256) ||
    typeof release.bytes !== "number" ||
    !Number.isSafeInteger(release.bytes) ||
    release.bytes <= 0 ||
    release.bytes > MAX_FIRMWARE_BYTES ||
    release.bytes % 512 !== 0 ||
    release.uf2Url !==
      `/firmware/badgegotchi-${release.version}-${release.sha256.slice(0, 12)}.uf2`
  ) {
    throw new Error("The firmware release information is invalid. Installation is unavailable.");
  }
  return {
    version: release.version,
    board: release.board,
    name: release.name,
    description: release.description,
    sha256: release.sha256,
    bytes: release.bytes,
    uf2Url: release.uf2Url as string,
  };
}

