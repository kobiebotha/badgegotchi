import { describe, expect, it } from "vitest";
import { parseAppManifest, MAX_APP_BYTES } from "../../src/installer/appManifest";

function manifest() {
  return {
    schemaVersion: 1,
    release: {
      version: "0.1.0-alpha.1", appId: "badgegotchi", name: "Badgegotchi", board: "tufty2350", runtimeMpy: 7942,
      description: "Local alpha", zipUrl: "/badge-app/0.1.0-alpha.1/app.zip", zipBytes: 1000, zipSha256: "a".repeat(64),
      files: [
        { path: "__init__.py", url: "/badge-app/0.1.0-alpha.1/__init__.py", bytes: 20, sha256: "b".repeat(64) },
        { path: "lib/native.mpy", url: "/badge-app/0.1.0-alpha.1/lib/native.mpy", bytes: 800, sha256: "c".repeat(64) },
      ],
    },
  };
}

describe("Badgeware app release boundary", () => {
  it("accepts qualified ABI and a complete app, or explicit unpublished status", () => {
    expect(parseAppManifest(manifest())?.files).toHaveLength(2);
    expect(parseAppManifest({ schemaVersion: 1, release: null })).toBeNull();
  });
  it.each(["../main.py", "lib/../../main.py", "/main.py", "lib\\main.py", "lib//main.py", "lib/%2e%2e/main.py", ".hidden", "CON.py", "lib/trailing."])("rejects unsafe FAT path %s", (path) => {
    const input = manifest();
    input.release.files[1].path = path;
    expect(() => parseAppManifest(input)).toThrow("invalid");
  });
  it.each(["https://example.com/native.mpy", "//example.com/native.mpy", "/badge-app/../secret", "/badge-app/file?download=1", "/badge-app/%2fsecret"])("rejects untrusted artifact URL %s", (url) => {
    const input = manifest();
    input.release.files[1].url = url;
    expect(() => parseAppManifest(input)).toThrow("invalid");
  });
  it("rejects case aliases and a file used as a parent directory", () => {
    for (const path of ["__INIT__.py", "__init__.py/child"]) {
      const input = manifest(); input.release.files[1].path = path;
      expect(() => parseAppManifest(input)).toThrow("invalid");
    }
  });
  it("rejects a different runtime before any native code is offered", () => {
    const input = manifest(); input.release.runtimeMpy = 7943;
    expect(() => parseAppManifest(input)).toThrow("invalid");
  });
  it("requires the launcher entry and limits total uncompressed size", () => {
    const noEntry = manifest(); noEntry.release.files.shift();
    expect(() => parseAppManifest(noEntry)).toThrow("invalid");
    const oversized = manifest(); oversized.release.files[1].bytes = MAX_APP_BYTES;
    expect(() => parseAppManifest(oversized)).toThrow("invalid");
  });
});
