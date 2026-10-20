import { parseUf2, type Uf2Image } from "./uf2";

import { parseReleaseManifest, type FirmwareRelease } from "./manifest";
export { parseReleaseManifest, MAX_FIRMWARE_BYTES, type FirmwareRelease } from "./manifest";

const MANIFEST_URL = "/firmware/manifest.json";

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(60_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readBounded(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maximum) {
    throw new Error("The firmware download is larger than expected.");
  }
  if (!response.body) throw new Error("The firmware download was empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new Error("The firmware download is larger than expected.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function loadRelease(signal?: AbortSignal): Promise<FirmwareRelease | null> {
  const response = await fetch(MANIFEST_URL, {
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    signal: requestSignal(signal),
  });
  if (!response.ok) {
    throw new Error("Couldn’t check the firmware release. Please try again.");
  }
  const bytes = await readBounded(response, 16 * 1024);
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("The firmware catalog could not be read. Please try again later.");
  }
  return parseReleaseManifest(manifest);
}

export async function downloadFirmware(
  release: FirmwareRelease,
  signal?: AbortSignal,
): Promise<{ image: Uf2Image; bytes: Uint8Array }> {
  // Revalidate even when called outside the installer component.
  const checked = parseReleaseManifest({ schemaVersion: 1, release })!;
  const response = await fetch(checked.uf2Url, {
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    signal: requestSignal(signal),
  });
  if (!response.ok) throw new Error("Couldn’t download the firmware. Please try again.");
  const bytes = await readBounded(response, checked.bytes);
  if (bytes.byteLength !== checked.bytes) {
    throw new Error("The firmware download is incomplete. Please try again.");
  }
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  const actual = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (actual !== checked.sha256) {
    throw new Error("The firmware integrity check failed. Nothing has been written to your badge.");
  }
  return { image: parseUf2(bytes), bytes };
}
