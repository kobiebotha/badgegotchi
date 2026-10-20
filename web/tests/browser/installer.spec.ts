import { createHash } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { mockDrive, driveLog, driveSnapshot } from "./installerDrive";

async function publishFixture(page: Page, corrupt: "none" | "file" | "zip" = "none") {
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const zip = Buffer.from("PK\x03\x04verified browser download fixture");
  const contents = [
    { path: "__init__.py", bytes: Buffer.from("print('Badgegotchi')\n") },
    { path: "lib/native.mpy", bytes: Buffer.from([77, 6, 31, 0, 1, 2, 3]) },
    { path: "readme.txt", bytes: Buffer.from("Local companion alpha") },
  ];
  const files = contents.map(({ path, bytes }) => ({ path, bytes: bytes.length, sha256: hash(bytes), url: `/badge-app/test/${path}` }));
  await page.route("**/badge-app/manifest.json", (route) => route.fulfill({ json: {
    schemaVersion: 1,
    release: {
      name: "Badgegotchi", appId: "badgegotchi", description: "Local alpha browser fixture", version: "0.1.0-alpha.1",
      board: "tufty2350", runtimeMpy: 7942, zipBytes: zip.length, zipSha256: hash(zip), zipUrl: "/badge-app/test/app.zip", files,
    },
  } }));
  await page.route("**/badge-app/test/app.zip", (route) => route.fulfill({ contentType: "application/zip", body: corrupt === "zip" ? Buffer.alloc(zip.length) : zip }));
  for (const { path, bytes } of contents) {
    await page.route(`**/badge-app/test/${path}`, (route) => route.fulfill({
      contentType: "application/octet-stream", body: corrupt === "file" && path === "lib/native.mpy" ? Buffer.alloc(bytes.length) : bytes,
    }));
  }
  return { zip, contents };
}

async function selectDrive(page: Page) {
  await page.getByRole("button", { name: "Choose Badgeware drive", exact: true }).click();
}

test("unpublished app is accessible without login and fits desktop and phone", async ({ page }) => {
  await page.route("**/badge-app/manifest.json", (route) => route.fulfill({ json: { schemaVersion: 1, release: null } }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/install");
  await expect(page.getByRole("heading", { name: "The app is being prepared" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download verified app ZIP" })).toBeDisabled();
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`app-installer-${width}.png`), fullPage: width > 375 });
  }
  expect(errors).toEqual([]);
});

for (const corrupt of ["file", "zip"] as const) {
  test(`${corrupt} integrity failure blocks all installation actions before drive access`, async ({ page }) => {
    await mockDrive(page);
    await publishFixture(page, corrupt);
    await page.goto("/install");
    await expect(page.getByRole("alert")).toContainText("integrity check failed");
    await expect(page.getByRole("button", { name: "Choose Badgeware drive", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Download verified app ZIP" })).toBeDisabled();
    expect(await driveLog(page)).toEqual([]);
  });
}

test("catalog error can retry and is not mistaken for an unpublished app", async ({ page }) => {
  let available = false;
  await page.route("**/badge-app/manifest.json", (route) => available
    ? route.fulfill({ json: { schemaVersion: 1, release: null } })
    : route.fulfill({ status: 503, body: "Unavailable" }));
  await page.goto("/install");
  await expect(page.getByRole("alert")).toContainText("Couldn’t check");
  available = true;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("heading", { name: "The app is being prepared" })).toBeVisible();
});

test("browser without directory access downloads verified ZIP without claiming installation", async ({ page }) => {
  await page.addInitScript(() => { Object.assign(window, { showDirectoryPicker: undefined }); });
  const { zip } = await publishFixture(page);
  await page.goto("/install");
  await expect(page.getByRole("heading", { name: "Install with the ZIP download" })).toBeVisible();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download verified app ZIP" }).click();
  const file = await downloaded;
  const stream = await file.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks)).toEqual(zip);
  expect(file.suggestedFilename()).toBe("badgegotchi-0.1.0-alpha.1.zip");
  await expect(page.getByRole("heading", { name: "App copied and verified" })).toHaveCount(0);
});

for (const [scenario, message] of [
  ["cancel", "No drive was selected"],
  ["bootsel", "BOOTSEL drive"],
  ["wrong-folder", "must contain an apps folder"],
  ["impostor", "does not look like a Badgeware drive"],
  ["existing", "already exists"],
] as const) {
  test(`${scenario} selection changes no files and remains recoverable`, async ({ page }) => {
    await mockDrive(page, scenario);
    await publishFixture(page);
    await page.goto("/install");
    const before = await driveSnapshot(page);
    await selectDrive(page);
    await expect(page.getByRole("alert")).toContainText(message);
    expect(await driveSnapshot(page)).toEqual(before);
    expect(await driveLog(page)).toEqual([]);
    await expect(page.getByRole("button", { name: "Choose Badgeware drive", exact: true })).toBeEnabled();
  });
}

test("copy preserves existing files, verifies all bytes and commits launcher entry last", async ({ page }) => {
  await mockDrive(page);
  const { contents } = await publishFixture(page);
  await page.goto("/install");
  const before = await driveSnapshot(page);
  await expect(page.getByRole("button", { name: "Choose Badgeware drive", exact: true })).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath("installer-desktop-ready.png"), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload();
  await expect(page.getByRole("button", { name: "Choose Badgeware drive", exact: true })).toBeEnabled();
  await expect(page.locator(".site-header")).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath("installer-mobile-top.png") });
  await page.getByRole("heading", { name: "Install Badgegotchi", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("installer-mobile-controls.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await selectDrive(page);
  expect(await driveLog(page)).toEqual([]);
  await page.getByRole("button", { name: "Copy app to badge", exact: true }).click();
  await expect(page.getByRole("heading", { name: "App copied and verified" })).toBeVisible();
  const after = await driveSnapshot(page);
  const apps = after.apps as Record<string, unknown>;
  expect(after.state).toEqual(before.state);
  expect(after["launcher.py"]).toEqual(before["launcher.py"]);
  expect(after["main.py"]).toEqual(before["main.py"]);
  expect(apps.menu).toEqual((before.apps as Record<string, unknown>).menu);
  expect(apps.Pomogotchi).toEqual((before.apps as Record<string, unknown>).Pomogotchi);
  expect(apps.badgegotchi).toEqual({
    "__init__.py": Array.from(contents[0].bytes), lib: { "native.mpy": Array.from(contents[1].bytes) }, "readme.txt": Array.from(contents[2].bytes),
  });
  const writes = (await driveLog(page)).filter((entry) => entry.startsWith("write:"));
  expect(writes.at(-1)).toBe("write:/apps/badgegotchi/__init__.py");
  await expect(page.getByText("Safely eject the Badgeware drive, press RESET once, then open Badgegotchi in the launcher.")).toBeVisible();
});

for (const scenario of ["disconnect", "readback"] as const) {
  test(`${scenario} failure removes only created app files and never reports success`, async ({ page }) => {
    await mockDrive(page, scenario);
    await publishFixture(page);
    await page.goto("/install");
    const before = await driveSnapshot(page);
    await selectDrive(page);
    await page.getByRole("button", { name: "Copy app to badge", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Installation did not finish");
    await expect(page.getByRole("heading", { name: "App copied and verified" })).toHaveCount(0);
    expect(await driveSnapshot(page)).toEqual(before);
    expect((await driveLog(page)).some((entry) => entry === "write:/apps/badgegotchi/__init__.py")).toBe(false);
  });
}

test("failure cleanup retains an unexpected file added by another process", async ({ page }) => {
  await mockDrive(page, "extra-file");
  await publishFixture(page);
  await page.goto("/install");
  await selectDrive(page);
  await page.getByRole("button", { name: "Copy app to badge", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Some files may remain");
  const after = await driveSnapshot(page);
  const apps = after.apps as Record<string, unknown>;
  expect(apps.badgegotchi).toEqual({ "unrelated.txt": Array.from(Buffer.from("another process owns this")) });
  expect((await driveLog(page)).some((entry) => entry.endsWith("remove:/apps/badgegotchi/unrelated.txt"))).toBe(false);
});

test("directory access without Web Locks offers the ZIP and never chooses a drive", async ({ page }) => {
  await mockDrive(page);
  await page.addInitScript(() => { Object.defineProperty(navigator, "locks", { value: undefined, configurable: true }); });
  await publishFixture(page);
  await page.goto("/install");
  await expect(page.getByRole("heading", { name: "Install with the ZIP download" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose Badgeware drive", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Download verified app ZIP" })).toBeEnabled();
  expect(await driveLog(page)).toEqual([]);
});

test("a concurrent installer tab is rejected before any filesystem mutation", async ({ page }) => {
  const second = await page.context().newPage();
  await mockDrive(page, "pause-write");
  await mockDrive(second);
  await publishFixture(page);
  await publishFixture(second);
  await page.goto("/install");
  await second.goto("/install");
  await selectDrive(page);
  await selectDrive(second);
  await page.getByRole("button", { name: "Copy app to badge", exact: true }).click();
  await expect.poll(() => driveLog(page)).toContain("write:/apps/badgegotchi/lib/native.mpy");
  await second.getByRole("button", { name: "Copy app to badge", exact: true }).click();
  await expect(second.getByRole("alert")).toContainText("Another tab is copying Badgegotchi");
  expect(await driveLog(second)).toEqual([]);
  await page.evaluate(() => (window as unknown as { __resumeWrite: () => void }).__resumeWrite());
  await expect(page.getByRole("heading", { name: "App copied and verified" })).toBeVisible();
  // The browser's real lock releases when the first copy finishes.
  await selectDrive(second);
  await second.getByRole("button", { name: "Copy app to badge", exact: true }).click();
  await expect(second.getByRole("heading", { name: "App copied and verified" })).toBeVisible();
});

test("a file appearing between lookup and creation is neither overwritten nor removed", async ({ page }) => {
  await mockDrive(page, "appearing-file");
  await publishFixture(page);
  await page.goto("/install");
  const before = await driveSnapshot(page);
  await selectDrive(page);
  await page.getByRole("button", { name: "Copy app to badge", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("appeared during installation and was left unchanged");
  const after = await driveSnapshot(page);
  expect(after.state).toEqual(before.state);
  expect(after["main.py"]).toEqual(before["main.py"]);
  const apps = after.apps as Record<string, unknown>;
  expect(apps.Pomogotchi).toEqual((before.apps as Record<string, unknown>).Pomogotchi);
  expect(apps.badgegotchi).toEqual({ lib: { "native.mpy": Array.from(Buffer.from("another process owns this")) } });
  const log = await driveLog(page);
  expect(log).not.toContain("write:/apps/badgegotchi/lib/native.mpy");
  expect(log).not.toContain("remove:/apps/badgegotchi/lib/native.mpy");
  await expect(page.getByRole("heading", { name: "App copied and verified" })).toHaveCount(0);
});
