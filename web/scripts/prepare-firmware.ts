import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseUf2 } from "../src/installer/uf2.ts";

type FirmwareOptions = {
  uf2: string;
  version: string;
  description?: string;
};

const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const DEFAULT_DESCRIPTION = "Badgegotchi firmware for Tufty 2350.";
const PUBLIC_DIRECTORY = fileURLToPath(new URL("../public/", import.meta.url));

const usage = `Prepare a qualified Badgegotchi firmware release.

Usage:
  node --experimental-strip-types scripts/prepare-firmware.ts \\
    --uf2 /path/to/badgegotchi.uf2 --version 0.1.0 \\
    --description "Initial Tufty 2350 release."

The input must be a real, credential-free firmware release. UF2 validation
does not prove that the image boots or implements Badgegotchi.
This command stages an immutable artifact and atomically updates the local
public/firmware/manifest.json. It does not deploy, push, or access USB.
`;

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function parseArguments(args: string[]): FirmwareOptions {
  const values = new Map<string, string>();
  const allowed = new Set(["--uf2", "--version", "--description"]);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!allowed.has(flag)) throw new Error(`Unknown argument: ${flag}`);
    if (values.has(flag)) throw new Error(`Repeated argument: ${flag}`);
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    values.set(flag, value);
  }
  const uf2 = values.get("--uf2");
  const version = values.get("--version");
  if (!uf2 || !version) throw new Error("--uf2 and --version are required.");
  return { uf2, version, description: values.get("--description") };
}

/**
 * Stages only validated release bytes. publicDirectory is injectable so release
 * tests can use a temporary directory without changing the shipped manifest.
 */
export async function prepareFirmware(
  options: FirmwareOptions,
  publicDirectory = PUBLIC_DIRECTORY,
) {
  if (!VERSION_PATTERN.test(options.version)) {
    throw new Error(
      "Version must be 1–64 characters: start with a letter or number, then use letters, numbers, dots, underscores, + or -.",
    );
  }
  const description = options.description ?? DEFAULT_DESCRIPTION;
  if (!description.trim() || description.length > 500) {
    throw new Error("Description must contain 1–500 characters.");
  }

  const bytes = await readFile(resolve(options.uf2));
  // Reject malformed, incomplete, wrong-family and out-of-window images before
  // creating a directory, artifact, or manifest.
  const image = parseUf2(bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const filename = `badgegotchi-${options.version}-${sha256.slice(0, 12)}.uf2`;
  const firmwareDirectory = resolve(publicDirectory, "firmware");
  const artifactPath = resolve(firmwareDirectory, filename);
  const manifestPath = resolve(firmwareDirectory, "manifest.json");
  const release = {
    version: options.version,
    board: "tufty2350",
    name: "Badgegotchi",
    description,
    uf2Url: `/firmware/${filename}`,
    sha256,
    bytes: bytes.length,
  };
  const manifest = { schemaVersion: 1, release };

  await mkdir(firmwareDirectory, { recursive: true });
  try {
    // Exclusive creation prevents a truncated hash collision, accidental
    // replacement, or a concurrent writer from changing published bytes.
    await writeFile(artifactPath, bytes, { flag: "wx" });
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
    const existing = await readFile(artifactPath);
    if (!existing.equals(bytes)) {
      throw new Error(`Refusing to replace different bytes at ${artifactPath}`);
    }
  }

  // The manifest is the publication pointer: only replace it after the complete
  // artifact exists. A failed manifest write leaves the previous release intact.
  const temporaryManifest = resolve(
    firmwareDirectory,
    `.manifest-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(
      temporaryManifest,
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx" },
    );
    await rename(temporaryManifest, manifestPath);
  } finally {
    await unlink(temporaryManifest).catch((error: unknown) => {
      if (!hasCode(error, "ENOENT")) throw error;
    });
  }
  return { manifest, artifactPath, manifestPath, image };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(usage);
    return;
  }
  const result = await prepareFirmware(parseArguments(args));
  console.log(`Prepared Badgegotchi ${result.manifest.release.version}`);
  console.log(`Artifact: ${result.artifactPath}`);
  console.log(`SHA-256: ${result.manifest.release.sha256}`);
  console.log(`Manifest: ${result.manifestPath}`);
  console.log("Staged locally. Hardware qualification and deployment are separate.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Firmware preparation failed.");
    process.exitCode = 1;
  });
}
