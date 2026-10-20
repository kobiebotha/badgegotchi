import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkFirmware } from "../../scripts/check-firmware";
import { prepareFirmware } from "../../scripts/prepare-firmware";
import { firmwareFixture } from "../firmwareFixture";

describe("firmware release publication", () => {
  let directory: string;
  let publicDirectory: string;
  let input: string;
  let bytes: Uint8Array;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "badgegotchi-publishing-"));
    publicDirectory = join(directory, "public");
    input = join(directory, "synthetic-test-only.uf2");
    bytes = firmwareFixture(3);
    await writeFile(input, bytes);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function publish() {
    return prepareFirmware(
      { uf2: input, version: "0.1.0+test", description: "Test fixture only." },
      publicDirectory,
    );
  }

  it("stages exact bytes and a manifest accepted by the build guard", async () => {
    const result = await publish();
    const digest = createHash("sha256").update(bytes).digest("hex");
    expect(await readFile(result.artifactPath)).toEqual(Buffer.from(bytes));
    expect(result.manifest.release).toEqual({
      version: "0.1.0+test",
      board: "tufty2350",
      name: "Badgegotchi",
      description: "Test fixture only.",
      uf2Url: `/firmware/badgegotchi-0.1.0+test-${digest.slice(0, 12)}.uf2`,
      sha256: digest,
      bytes: bytes.length,
    });
    expect(JSON.parse(await readFile(result.manifestPath, "utf8")))
      .toEqual(result.manifest);
    expect(await checkFirmware(publicDirectory)).toEqual(result.manifest.release);
    expect((await readdir(join(publicDirectory, "firmware"))).sort()).toEqual([
      result.manifest.release.uf2Url.split("/").at(-1),
      "manifest.json",
    ]);
  });

  it("allows repeat publication of identical bytes without changing the release", async () => {
    const result = await publish();
    const previousManifest = await readFile(result.manifestPath);
    await publish();
    expect(await readFile(result.manifestPath)).toEqual(previousManifest);
    expect(await readFile(result.artifactPath)).toEqual(Buffer.from(bytes));
  });

  it("refuses to replace differing bytes at an existing artifact path", async () => {
    const result = await publish();
    const previousManifest = await readFile(result.manifestPath);
    const different = Buffer.alloc(bytes.length);
    await writeFile(result.artifactPath, different);
    await expect(publish()).rejects.toThrow("Refusing to replace different bytes");
    expect(await readFile(result.artifactPath)).toEqual(different);
    expect(await readFile(result.manifestPath)).toEqual(previousManifest);
  });

  it.each(["../escape", "/absolute", "", ".hidden", "1/2", "a".repeat(65)])(
    "rejects unsafe version %j before publishing anything",
    async (version) => {
      await expect(prepareFirmware({ uf2: input, version }, publicDirectory))
        .rejects.toThrow("Version must");
      expect(await readdir(directory)).toEqual(["synthetic-test-only.uf2"]);
    },
  );

  it("keeps the previous release when a new UF2 fails validation", async () => {
    const result = await publish();
    const previousManifest = await readFile(result.manifestPath);
    await writeFile(input, new Uint8Array(bytes.length));
    await expect(prepareFirmware(
      { uf2: input, version: "0.2.0" },
      publicDirectory,
    )).rejects.toThrow("Invalid UF2");
    expect(await readFile(result.manifestPath)).toEqual(previousManifest);
    expect(await checkFirmware(publicDirectory)).toEqual(result.manifest.release);
  });

  it.each(["missing", "truncated", "tampered"])(
    "fails the build when a released artifact is %s",
    async (failure) => {
      const result = await publish();
      if (failure === "missing") await unlink(result.artifactPath);
      if (failure === "truncated") await writeFile(result.artifactPath, bytes.slice(0, 512));
      if (failure === "tampered") {
        const modified = bytes.slice();
        modified[32] ^= 1;
        await writeFile(result.artifactPath, modified);
      }
      await expect(checkFirmware(publicDirectory)).rejects.toThrow(
        failure === "missing" ? "ENOENT" : failure === "truncated" ? "size" : "SHA-256",
      );
    },
  );

  it("still validates UF2 when a malformed artifact has a matching size and digest", async () => {
    const result = await publish();
    const malformed = new Uint8Array(bytes.length);
    const digest = createHash("sha256").update(malformed).digest("hex");
    const release = {
      ...result.manifest.release,
      sha256: digest,
      uf2Url: `/firmware/badgegotchi-0.1.0+test-${digest.slice(0, 12)}.uf2`,
    };
    await writeFile(join(publicDirectory, release.uf2Url.slice(1)), malformed);
    await writeFile(
      result.manifestPath,
      JSON.stringify({ schemaVersion: 1, release }),
    );
    await expect(checkFirmware(publicDirectory)).rejects.toThrow("Invalid UF2");
  });

  it("accepts an explicitly unavailable release but rejects unsupported catalog versions", async () => {
    const result = await publish();
    await unlink(result.artifactPath);
    await writeFile(
      result.manifestPath,
      JSON.stringify({ schemaVersion: 1, release: null }),
    );
    expect(await checkFirmware(publicDirectory)).toBeNull();
    await writeFile(
      result.manifestPath,
      JSON.stringify({ schemaVersion: 2, release: null }),
    );
    await expect(checkFirmware(publicDirectory)).rejects.toThrow("not supported");
  });
});
