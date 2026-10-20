import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { checkApp } from "../../scripts/check-app";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function stagedApp() {
  const root = await mkdtemp(join(tmpdir(), "badge-app-publishing-"));
  directories.push(root);
  await mkdir(join(root, "badge-app"));
  const init = Buffer.from("print('fixture')\n");
  const zip = Buffer.from("package fixture");
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const release = {
    version: "0.1.0-alpha.1", appId: "badgegotchi", name: "Badgegotchi", board: "tufty2350", runtimeMpy: 7942,
    description: "Test", zipUrl: "/badge-app/app.zip", zipBytes: zip.length, zipSha256: hash(zip),
    files: [{ path: "__init__.py", url: "/badge-app/__init__.py", bytes: init.length, sha256: hash(init) }],
  };
  await writeFile(join(root, "badge-app/manifest.json"), JSON.stringify({ schemaVersion: 1, release }));
  await writeFile(join(root, "badge-app/app.zip"), zip);
  await writeFile(join(root, "badge-app/__init__.py"), init);
  return { root, init };
}

it("checks a staged app and rejects altered bytes even when file sizes match", async () => {
  const { root, init } = await stagedApp();
  expect((await checkApp(root))?.appId).toBe("badgegotchi");
  await writeFile(join(root, "badge-app/__init__.py"), Buffer.alloc(init.length));
  await expect(checkApp(root)).rejects.toThrow("integrity check failed");
});

it("rejects an artifact symlink pointing outside the release directory", async () => {
  const { root, init } = await stagedApp();
  await writeFile(join(root, "private.py"), init);
  await rm(join(root, "badge-app/__init__.py"));
  await symlink(join(root, "private.py"), join(root, "badge-app/__init__.py"));
  await expect(checkApp(root)).rejects.toThrow("outside public/badge-app");
});

it("does not treat a missing ZIP as an unpublished release", async () => {
  const { root } = await stagedApp();
  await rm(join(root, "badge-app/app.zip"));
  await expect(checkApp(root)).rejects.toThrow();
});
