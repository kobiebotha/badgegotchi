import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseAppManifest } from "../src/installer/appManifest.ts";

const PUBLIC_DIRECTORY = fileURLToPath(new URL("../public/", import.meta.url));

/** Validate every deployable app byte against the manifest before Vite builds. */
export async function checkApp(publicDirectory = PUBLIC_DIRECTORY) {
  const root = await realpath(resolve(publicDirectory, "badge-app"));
  async function readLocal(url: string, maximum: number) {
    const path = await realpath(resolve(publicDirectory, url.slice(1)));
    if (!path.startsWith(`${root}${sep}`)) throw new Error("App artifact is outside public/badge-app.");
    const info = await stat(path);
    if (!info.isFile() || info.size > maximum) throw new Error(`Invalid app artifact size: ${url}`);
    return readFile(path);
  }
  const manifest = await readLocal("/badge-app/manifest.json", 64 * 1024);
  const release = parseAppManifest(JSON.parse(manifest.toString("utf8")));
  if (!release) return null;
  const artifacts = [
    { url: release.zipUrl, bytes: release.zipBytes, sha256: release.zipSha256 },
    ...release.files,
  ];
  for (const artifact of artifacts) {
    const bytes = await readLocal(artifact.url, artifact.bytes);
    if (bytes.length !== artifact.bytes || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
      throw new Error(`App artifact integrity check failed: ${artifact.url}`);
    }
  }
  return release;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  checkApp().then((release) => {
    console.log(release ? `App release ${release.version}: all package hashes passed.` : "App catalog checked: no release is published.");
  }).catch((error: unknown) => { console.error(error instanceof Error ? error.message : "App validation failed."); process.exitCode = 1; });
}
