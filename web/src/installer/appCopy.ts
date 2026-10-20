import { parseAppManifest } from "./appManifest";
import { sha256, type PreparedApp } from "./appRelease";

// Keep the supported API surface explicit; the directory picker is not in all
// versions of lib.dom and is deliberately optional in the page.
export interface AppFileHandle {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{
    write(bytes: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  }>;
  isSameEntry(other: AppEntry): Promise<boolean>;
}
export interface AppDirectoryHandle {
  kind: "directory";
  name: string;
  entries(): AsyncIterableIterator<[string, AppEntry]>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<AppDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<AppFileHandle>;
  removeEntry(name: string): Promise<void>;
  isSameEntry(other: AppEntry): Promise<boolean>;
}
type AppEntry = AppDirectoryHandle | AppFileHandle;
type PickerWindow = Window & {
  showDirectoryPicker?: (options: { id: string; mode: "readwrite" }) => Promise<AppDirectoryHandle>;
};
export interface CopyProgress { completed: number; total: number; path: string }

export function supportsAppCopy(): boolean {
  return window.isSecureContext && typeof (window as PickerWindow).showDirectoryPicker === "function" &&
    typeof navigator.locks?.request === "function";
}

/** Invoke directly in a click handler, before asynchronous work consumes activation. */
export function chooseBadgeDrive(): Promise<AppDirectoryHandle> {
  const picker = (window as PickerWindow).showDirectoryPicker;
  if (!picker) return Promise.reject(new Error("Use the ZIP download in this browser."));
  return picker.call(window, { id: "badgegotchi-app", mode: "readwrite" });
}

async function findEntry(directory: AppDirectoryHandle, name: string): Promise<AppEntry | undefined> {
  for await (const [candidate, entry] of directory.entries()) {
    if (candidate.toLowerCase() === name.toLowerCase()) return entry;
  }
}

export async function validateBadgeDrive(root: AppDirectoryHandle): Promise<AppDirectoryHandle> {
  if (/^(RP2350|RP2|RPI-RP2)$/i.test(root.name) || await findEntry(root, "INFO_UF2.TXT")) {
    throw new Error("This is the BOOTSEL drive. Press RESET once, then double-tap RESET to open the Badgeware file drive.");
  }
  const apps = await findEntry(root, "apps");
  if (!apps || apps.kind !== "directory") {
    throw new Error("Choose the Badgeware drive itself: it must contain an apps folder. No files were changed.");
  }
  const main = await findEntry(root, "main.py");
  const menu = await findEntry(apps, "menu");
  if (!main || main.kind !== "file" || !menu || menu.kind !== "directory") {
    throw new Error("This folder does not look like a Badgeware drive. Choose the drive containing main.py and apps/menu. No files were changed.");
  }
  if (await findEntry(apps, "badgegotchi")) {
    throw new Error("apps/badgegotchi already exists. Keep it in place; this installer only adds a new app and will not overwrite it.");
  }
  return apps;
}

/** Writes only to a new app folder. Never replaces or recursively removes an entry. */
export async function copyApp(
  root: AppDirectoryHandle,
  prepared: PreparedApp,
  onProgress?: (progress: CopyProgress) => void,
): Promise<void> {
  if (typeof navigator.locks?.request !== "function") {
    throw new Error("Use the ZIP download in this browser.");
  }
  // Serialize installers across this site's tabs before checking or mutating
  // the drive. A second tab fails immediately rather than waiting to overwrite.
  await navigator.locks.request("badgegotchi-app-install", { mode: "exclusive", ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error("Another tab is copying Badgegotchi. Wait for it to finish, then check your badge.");
    await copyAppExclusively(root, prepared, onProgress);
  });
}

async function copyAppExclusively(
  root: AppDirectoryHandle,
  prepared: PreparedApp,
  onProgress?: (progress: CopyProgress) => void,
): Promise<void> {
  const release = parseAppManifest({ schemaVersion: 1, release: prepared.release })!;
  // Recheck the bytes at the mutation boundary, even when called outside the UI.
  if (prepared.files.length !== release.files.length) throw new Error("The app package is incomplete.");
  const checked = [];
  for (const file of release.files) {
    const matches = prepared.files.filter((candidate) => candidate.file.path === file.path);
    if (matches.length !== 1 || matches[0].bytes.length !== file.bytes || await sha256(matches[0].bytes) !== file.sha256) {
      throw new Error("The app integrity check failed. Nothing has been written to your badge.");
    }
    checked.push({ file, bytes: matches[0].bytes });
  }
  const apps = await validateBadgeDrive(root);
  const app = await apps.getDirectoryHandle("badgegotchi", { create: true });
  // File System Access has no exclusive mkdir. Refuse a folder that appeared
  // between validation and creation; do not try to clean up another writer's data.
  for await (const _entry of app.entries()) {
    throw new Error("The app folder changed during installation. No existing files were overwritten.");
  }
  const created: { parent: AppDirectoryHandle; entry: AppEntry }[] = [{ parent: apps, entry: app }];
  const directories = new Map<string, AppDirectoryHandle>([["", app]]);
  // Launcher entry is committed only after every dependency passes readback.
  checked.sort((a, b) => Number(a.file.path === "__init__.py") - Number(b.file.path === "__init__.py"));
  try {
    for (const [index, { file, bytes }] of checked.entries()) {
      const parts = file.path.split("/");
      const name = parts.pop()!;
      let parent = app;
      let prefix = "";
      for (const part of parts) {
        prefix = prefix ? `${prefix}/${part}` : part;
        let directory = directories.get(prefix);
        if (!directory) {
          if (await findEntry(parent, part)) throw new Error("The app folder changed during installation.");
          directory = await parent.getDirectoryHandle(part, { create: true });
          for await (const _entry of directory.entries()) {
            throw new Error("The app folder changed during installation.");
          }
          created.push({ parent, entry: directory });
          directories.set(prefix, directory);
        }
        parent = directory;
      }
      if (await findEntry(parent, name)) throw new Error("The app folder changed during installation.");
      const handle = await parent.getFileHandle(name, { create: true });
      // create:true may return an entry another process created after findEntry.
      // Keep nonempty or unreadable entries out of both writes and cleanup.
      if ((await handle.getFile()).size !== 0) {
        throw new Error(`The file ${file.path} appeared during installation and was left unchanged.`);
      }
      created.push({ parent, entry: handle });
      const writable = await handle.createWritable();
      try {
        await writable.write(new Uint8Array(bytes));
        await writable.close();
      } catch (error) {
        await writable.abort().catch(() => undefined);
        throw error;
      }
      const readback = await handle.getFile();
      if (readback.size !== file.bytes || await sha256(new Uint8Array(await readback.arrayBuffer())) !== file.sha256) {
        throw new Error(`The copied file ${file.path} did not pass verification.`);
      }
      onProgress?.({ completed: index + 1, total: checked.length, path: file.path });
    }
  } catch (error) {
    let remaining = false;
    // No recursive deletion: newly arrived files are retained and prevent their
    // parent from being removed. Identity checks avoid deleting a replaced entry.
    for (const { parent, entry } of created.reverse()) {
      try {
        const current = await findEntry(parent, entry.name);
        if (current && await current.isSameEntry(entry)) await parent.removeEntry(entry.name);
        else if (current) remaining = true;
      } catch { remaining = true; }
    }
    const reason = error instanceof Error ? error.message : "The drive could not be written.";
    throw new Error(`${reason} Installation did not finish.${remaining
      ? " Some files may remain in apps/badgegotchi. Inspect that folder before retrying; other apps were not changed."
      : " The newly created app files were removed. You can try again."}`);
  }
}
