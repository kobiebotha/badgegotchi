import { createHash } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { firmwareFixture } from "../firmwareFixture";
import { mockUsb, usbCommands } from "./installerUsb";

async function publishFixture(page: Page, corrupt = false) {
  const bytes = firmwareFixture();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const uf2Url = `/firmware/badgegotchi-0.1.0-${sha256.slice(0, 12)}.uf2`;
  await page.route("**/firmware/manifest.json", (route) => route.fulfill({
    json: {
      schemaVersion: 1,
      release: {
        name: "Badgegotchi", description: "Browser test fixture", version: "0.1.0",
        board: "tufty2350", bytes: bytes.length, sha256, uf2Url,
      },
    },
  }));
  const response = bytes.slice();
  if (corrupt) response[32] ^= 0xff;
  await page.route(`**${uf2Url}`, (route) => route.fulfill({
    contentType: "application/octet-stream", body: Buffer.from(response),
  }));
  return bytes;
}

async function consent(page: Page) {
  await page.getByRole("checkbox", { name: "My badge is a Pimoroni Tufty 2350." }).check();
  await page.getByRole("checkbox", { name: "I’ve saved what I need and agree to replace its current firmware." }).check();
}

test("unpublished installer is accessible without login and fits desktop and phone", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/install");
  await expect(page.getByRole("heading", { name: "Firmware is being prepared" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect badge", exact: true })).toBeDisabled();
  await page.getByText("Install with a firmware file", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Download verified firmware" })).toBeDisabled();
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 375) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: test.info().outputPath("installer-mobile-top.png") });
      await page.getByRole("heading", { name: "Firmware is being prepared" }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: test.info().outputPath("installer-mobile-controls.png") });
    } else {
      await page.screenshot({ path: test.info().outputPath(`installer-${width}.png`), fullPage: true });
    }
  }
  expect(errors).toEqual([]);
});

test("bad release download blocks USB selection and manual download", async ({ page }) => {
  await mockUsb(page);
  await publishFixture(page, true);
  await page.goto("/install");
  await expect(page.getByRole("alert")).toContainText("integrity check failed");
  await expect(page.getByRole("button", { name: "Connect badge", exact: true })).toHaveCount(0);
  await page.getByText("Install with a firmware file", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Download verified firmware" })).toBeDisabled();
  expect(await usbCommands(page)).toEqual([]);
});

test("catalog errors can retry without treating failure as an unpublished release", async ({ page }) => {
  let attempts = 0;
  await page.route("**/firmware/manifest.json", (route) => {
    attempts++;
    return attempts <= 2 // StrictMode may start and cancel the initial fetch.
      ? route.fulfill({ status: 503, body: "Unavailable" })
      : route.fulfill({ json: { schemaVersion: 1, release: null } });
  });
  await page.goto("/install");
  await expect(page.getByRole("alert")).toContainText("Couldn’t check");
  // Make the next request deterministic regardless of StrictMode fetch timing.
  attempts = 2;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Firmware is being prepared" })).toBeVisible();
});

test("browser without WebUSB offers only a consented verified manual download", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "usb", { value: undefined, configurable: true });
  });
  const expectedBytes = await publishFixture(page);
  await page.goto("/install");
  await expect(page.getByRole("heading", { name: "This browser can’t connect over USB" })).toBeVisible();
  const download = page.getByRole("button", { name: "Download verified firmware" });
  await expect(download).toBeDisabled();
  await consent(page);
  await expect(download).toBeEnabled();
  const downloaded = page.waitForEvent("download");
  await download.click();
  const file = await downloaded;
  const stream = await file.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks)).toEqual(Buffer.from(expectedBytes));
  await expect(page.getByRole("heading", { name: "Firmware installed" })).toHaveCount(0);
});

test("cancelled USB selection is recoverable and never erases", async ({ page }) => {
  await mockUsb(page, "cancel");
  await publishFixture(page);
  await page.goto("/install");
  await page.getByRole("button", { name: "Connect badge", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("No badge was selected");
  await expect(page.getByRole("button", { name: "Connect badge", exact: true })).toBeEnabled();
  expect(await usbCommands(page)).toEqual([]);
});

test("USB install requires consent, writes and verifies before reboot", async ({ page }) => {
  await mockUsb(page);
  await publishFixture(page);
  await page.goto("/install");
  await page.getByRole("button", { name: "Connect badge", exact: true }).click();
  const install = page.getByRole("button", { name: "Install & replace firmware", exact: true });
  await expect(install).toBeDisabled();
  expect(await usbCommands(page)).toEqual([]);
  await consent(page);
  await install.click();
  await expect(page.getByRole("heading", { name: "Firmware installed" })).toBeVisible();
  const commands = await usbCommands(page);
  expect(commands).toEqual([1, 7, 0x84, 6, 3, 5, 7, 0x84, 10]);
  await expect(page.getByText("The firmware was written and verified. Check your badge’s screen as it restarts.")).toBeVisible();
});

for (const failure of ["readback", "disconnect"] as const) {
  test(`${failure} failure gives recovery steps and never reboots or reports success`, async ({ page }) => {
    await mockUsb(page, failure);
    await publishFixture(page);
    await page.goto("/install");
    await page.getByRole("button", { name: "Connect badge", exact: true }).click();
    await consent(page);
    await page.getByRole("button", { name: "Install & replace firmware", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("The installation did not finish");
    await expect(page.getByRole("heading", { name: "Firmware installed" })).toHaveCount(0);
    expect(await usbCommands(page)).not.toContain(10);
    await expect(page.getByRole("button", { name: "Connect badge", exact: true })).toBeEnabled();
  });
}
