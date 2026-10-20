import type { Page } from "@playwright/test";

/** In-memory File System Access drive. Exercises the actual copy implementation. */
export async function mockDrive(
  page: Page,
  scenario: "normal" | "cancel" | "bootsel" | "wrong-folder" | "impostor" | "existing" | "readback" | "disconnect" | "extra-file" | "pause-write" | "appearing-file" = "normal",
) {
  await page.addInitScript(({ scenario }) => {
    interface Directory {
      kind: "directory";
      name: string;
      children: Map<string, Entry>;
      isSameEntry(other: unknown): Promise<boolean>;
      entries(): AsyncIterableIterator<[string, Entry]>;
      getDirectoryHandle(child: string, options?: { create?: boolean }): Promise<Directory>;
      getFileHandle(child: string, options?: { create?: boolean }): Promise<ReturnType<typeof file>>;
      removeEntry(child: string): Promise<void>;
    }
    type Entry = Directory | ReturnType<typeof file>;
    const log: string[] = [];
    let choosers = 0;
    const missing = () => new DOMException("Missing", "NotFoundError");
    function file(name: string, initial = "", path = name) {
      let data = new TextEncoder().encode(initial);
      const handle = {
        kind: "file" as const, name,
        async isSameEntry(other: unknown) { return other === handle; },
        async getFile() {
          const bytes = data.slice();
          if (scenario === "readback" && path.endsWith("native.mpy") && bytes.length) bytes[0] ^= 0xff;
          return new File([bytes], name);
        },
        async createWritable() {
          let pending = new Uint8Array();
          return {
            async write(bytes: Uint8Array) {
              log.push(`write:${path}`);
              if (scenario === "pause-write" && path.endsWith("native.mpy")) {
                await new Promise<void>((resume) => { Object.assign(window, { __resumeWrite: resume }); });
              }
              if ((scenario === "disconnect" || scenario === "extra-file") && path.endsWith("native.mpy")) {
                if (scenario === "extra-file") {
                  const app = (root.children.get("apps") as ReturnType<typeof directory>).children.get("badgegotchi") as ReturnType<typeof directory>;
                  app.children.set("unrelated.txt", file("unrelated.txt", "another process owns this"));
                }
                throw new DOMException("Device disconnected", "NetworkError");
              }
              pending = new Uint8Array(bytes);
            },
            async close() { data = pending; log.push(`close:${path}`); },
            async abort() { log.push(`abort:${path}`); },
          };
        },
        contents() { return Array.from(data); },
      };
      return handle;
    }
    function directory(name: string, path = ""): Directory {
      const children = new Map<string, Entry>();
      const handle = {
        kind: "directory" as const, name, children,
        async isSameEntry(other: unknown) { return other === handle; },
        async *entries(): AsyncIterableIterator<[string, Entry]> { yield* children; },
        async getDirectoryHandle(child: string, options?: { create?: boolean }) {
          let entry = children.get(child);
          if (!entry && options?.create) {
            entry = directory(child, `${path}/${child}`);
            children.set(child, entry);
            log.push(`mkdir:${path}/${child}`);
          }
          if (!entry) throw missing();
          if (entry.kind !== "directory") throw new DOMException("Not a directory", "TypeMismatchError");
          return entry;
        },
        async getFileHandle(child: string, options?: { create?: boolean }) {
          let entry = children.get(child);
          if (!entry && options?.create && scenario === "appearing-file" && child === "native.mpy") {
            entry = file(child, "another process owns this", `${path}/${child}`);
            children.set(child, entry);
            log.push(`external-create:${path}/${child}`);
          }
          if (!entry && options?.create) {
            entry = file(child, "", `${path}/${child}`);
            children.set(child, entry);
            log.push(`create:${path}/${child}`);
          }
          if (!entry) throw missing();
          if (entry.kind !== "file") throw new DOMException("Not a file", "TypeMismatchError");
          return entry;
        },
        async removeEntry(child: string) {
          const entry = children.get(child);
          if (!entry) throw missing();
          if (entry.kind === "directory" && entry.children.size) throw new DOMException("Not empty", "InvalidModificationError");
          children.delete(child);
          log.push(`remove:${path}/${child}`);
        },
      };
      return handle;
    }
    const root = directory(scenario === "bootsel" ? "RP2350" : "BADGEWARE");
    if (scenario !== "wrong-folder") {
      const apps = directory("apps", "/apps");
      const existingApp = directory("Pomogotchi", "/apps/Pomogotchi");
      existingApp.children.set("__init__.py", file("__init__.py", "existing app"));
      apps.children.set("Pomogotchi", existingApp);
      if (scenario !== "impostor") apps.children.set("menu", directory("menu", "/apps/menu"));
      if (scenario === "existing") {
        const existing = directory("BadgeGotchi", "/apps/BadgeGotchi");
        existing.children.set("__init__.py", file("__init__.py", "existing version"));
        apps.children.set("BadgeGotchi", existing);
      }
      root.children.set("apps", apps);
    }
    const state = directory("state", "/state");
    state.children.set("saved.db", file("saved.db", "existing user data"));
    root.children.set("state", state);
    root.children.set("launcher.py", file("launcher.py", "original launcher"));
    if (scenario !== "impostor") root.children.set("main.py", file("main.py", "original Badgeware entry"));
    function snapshot(entry: Entry): unknown {
      return entry.kind === "file" ? entry.contents() : Object.fromEntries([...entry.children].map(([name, child]) => [name, snapshot(child)]));
    }
    Object.assign(window, {
      __driveLog: log,
      __driveSnapshot: () => snapshot(root),
      __driveChoosers: () => choosers,
      showDirectoryPicker: async () => {
        choosers++;
        if (scenario === "cancel") throw new DOMException("Cancelled", "AbortError");
        return root;
      },
    });
  }, { scenario });
}

export async function driveSnapshot(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => (window as unknown as { __driveSnapshot: () => Record<string, unknown> }).__driveSnapshot());
}
export async function driveLog(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __driveLog: string[] }).__driveLog);
}
