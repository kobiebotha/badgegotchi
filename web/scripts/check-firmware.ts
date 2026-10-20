import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseReleaseManifest } from "../src/installer/manifest.ts";
import { parseUf2 } from "../src/installer/uf2.ts";

const PUBLIC_DIRECTORY = fileURLToPath(new URL("../public/", import.meta.url));

/** A release must be complete before Vite copies public/ into a deployment. */
export async function checkFirmware(publicDirectory = PUBLIC_DIRECTORY) {
  const manifestPath = resolve(publicDirectory, "firmware/manifest.json");
  const manifestStats = await stat(manifestPath);
  if (!manifestStats.isFile() || manifestStats.size > 16 * 1024) {
    throw new Error("Firmware manifest must be a JSON file of at most 16 KiB.");
  }
  const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  const release = parseReleaseManifest(manifest);
  if (release === null) return null;

  // parseReleaseManifest fixes the path to /firmware/<version>-<digest>.uf2
  // with a restricted filename; it cannot resolve outside public/.
  const artifactPath = resolve(publicDirectory, release.uf2Url.slice(1));
  const artifactStats = await stat(artifactPath);
  if (!artifactStats.isFile() || artifactStats.size !== release.bytes) {
    throw new Error("Firmware artifact size does not match the release manifest.");
  }
  const bytes = await readFile(artifactPath);
  if (bytes.length !== release.bytes) {
    throw new Error("Firmware artifact changed while it was being checked.");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== release.sha256) {
    throw new Error("Firmware artifact SHA-256 does not match the release manifest.");
  }
  parseUf2(bytes);
  return release;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  checkFirmware().then((release) => {
    console.log(
      release
        ? `Firmware release ${release.version}: manifest, SHA-256 and UF2 checks passed.`
        : "Firmware catalog checked: no installable release is published.",
    );
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Firmware validation failed.");
    process.exitCode = 1;
  });
}
