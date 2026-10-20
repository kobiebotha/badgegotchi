import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  downloadFirmware,
  loadRelease,
  parseReleaseManifest,
  type FirmwareRelease,
} from "../../src/installer/release";
import { firmwareFixture } from "../firmwareFixture";

function releaseFor(bytes: Uint8Array): FirmwareRelease {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    version: "0.1.0",
    board: "tufty2350",
    name: "Badgegotchi",
    description: "Test fixture only",
    uf2Url: `/firmware/badgegotchi-0.1.0-${sha256.slice(0, 12)}.uf2`,
    sha256,
    bytes: bytes.byteLength,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("curated firmware releases", () => {
  it("distinguishes no published release from a broken catalog", () => {
    expect(parseReleaseManifest({ schemaVersion: 1, release: null })).toBeNull();
    for (const invalid of [null, {}, { schemaVersion: 2, release: null }, { schemaVersion: 1 }]) {
      expect(() => parseReleaseManifest(invalid)).toThrow();
    }
  });

  it("rejects external URLs, traversal, another board, and unbounded files", () => {
    const release = releaseFor(firmwareFixture());
    for (const patch of [
      { uf2Url: "https://example.com/firmware.uf2" },
      { uf2Url: "/firmware/../../firmware.uf2" },
      { uf2Url: "//example.com/firmware.uf2" },
      { version: "../../other" },
      { board: "pico2" },
      { bytes: 512.5 },
      { bytes: 32 * 1024 * 1024 },
      { sha256: "not-a-hash" },
    ]) {
      expect(() => parseReleaseManifest({ schemaVersion: 1, release: { ...release, ...patch } })).toThrow();
    }
  });

  it("loads the unavailable state without account credentials or redirects", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"schemaVersion":1,"release":null}'));
    vi.stubGlobal("fetch", fetch);
    await expect(loadRelease()).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledWith("/firmware/manifest.json", expect.objectContaining({
      cache: "no-store", credentials: "omit", redirect: "error",
    }));
  });

  it("does not treat a network error or SPA fallback as an unpublished release", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("<html>app</html>"));
    vi.stubGlobal("fetch", fetch);
    await expect(loadRelease()).rejects.toThrow("Couldn’t check");
    await expect(loadRelease()).rejects.toThrow("catalog could not be read");
  });

  it("validates bytes and hash before returning parsed firmware", async () => {
    const bytes = firmwareFixture();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array(bytes))));
    const result = await downloadFirmware(releaseFor(bytes));
    expect(result.bytes).toEqual(bytes);
    expect(result.image).toBeDefined();
  });

  it("rejects truncation, changed content and oversized streams", async () => {
    const bytes = firmwareFixture();
    const changed = bytes.slice();
    changed[32] ^= 0xff;
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(bytes.slice(0, -1)))
      .mockResolvedValueOnce(new Response(new Uint8Array(changed)))
      .mockResolvedValueOnce(new Response(new Uint8Array(1024)));
    vi.stubGlobal("fetch", fetch);
    await expect(downloadFirmware(releaseFor(bytes))).rejects.toThrow("incomplete");
    await expect(downloadFirmware(releaseFor(bytes))).rejects.toThrow("integrity check failed");
    await expect(downloadFirmware(releaseFor(bytes))).rejects.toThrow("larger than expected");
  });

  it("rejects invalid UF2 even when a manifest hash matches", async () => {
    const bytes = new Uint8Array(512);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array(bytes))));
    await expect(downloadFirmware(releaseFor(bytes))).rejects.toThrow();
  });

  it("rejects an oversized manifest without reading a huge body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", {
      headers: { "content-length": "1000000" },
    })));
    await expect(loadRelease()).rejects.toThrow("larger than expected");
  });
});
