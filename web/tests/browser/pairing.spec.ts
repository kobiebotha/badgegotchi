import { authenticate, expect, openDashboard, test } from "./fixtures";
import type { BrowserContext } from "@playwright/test";

const firstClaim = { claim_id: "claim-1", verification_id: "1234-ABCD", state: "pending" };
const secondClaim = { claim_id: "claim-2", verification_id: "5678-EFAB", state: "pending" };

async function gateway(context: BrowserContext) {
  const state = {
    requests: [] as Record<string, unknown>[],
    claims: [firstClaim, secondClaim],
    devices: [] as Record<string, unknown>[],
    session: 0,
    pairingState: "pending",
    failStatus: false,
    approvedBeforeCancel: false,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    statusGate: null as Promise<void> | null,
  };
  await context.route("https://badgegotchi.supabase.test/functions/v1/badge-gateway", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    state.requests.push(body);
    let response: unknown = {};
    let status = 200;
    if (body.action === "create_pairing") {
      ++state.session;
      state.pairingState = "pending";
      response = { session_id: `session-${state.session}`, state: "pending", expires_at: state.expiresAt, code: state.session === 1 ? "ABCABCABCABC" : "CBACBACBACBA" };
    } else if (body.action === "status_pairing") {
      // Snapshot before waiting to exercise stale-response protection.
      response = { session_id: body.session_id, state: state.pairingState, expires_at: state.expiresAt, claims: [...state.claims] };
      if (state.statusGate) await state.statusGate;
      if (state.failStatus) { status = 503; response = { error: "unavailable" }; }
    } else if (body.action === "approve_claim") {
      state.pairingState = "approved";
      state.devices = [{ device_id: "badge-1", name: "Badge", state: "active", paired_at: new Date().toISOString(), last_seen_at: "2026-10-19T12:00:00Z", revoked_at: null }];
      response = { state: "approved", device_id: "badge-1", claim_id: body.claim_id };
    } else if (body.action === "list_devices") response = { devices: state.devices };
    else if (body.action === "cancel_pairing") { state.pairingState = state.approvedBeforeCancel ? "approved" : "cancelled"; response = { state: state.pairingState }; }
    else if (body.action === "revoke_device") {
      state.devices = state.devices.map((device) => ({ ...device, state: "revoked", revoked_at: new Date().toISOString() }));
      response = { state: "revoked" };
    }
    await route.fulfill({ status, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" }, body: JSON.stringify(response) });
  });
  return state;
}

test("pairing requires an exact verification match, retains no code, and supports revoke", async ({ page, context, backend }) => {
  void backend;
  const service = await gateway(context);
  await authenticate(context);
  await openDashboard(page);
  await page.getByRole("button", { name: "Pair a badge", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Pair a badge" });
  await dialog.getByRole("button", { name: "Generate pairing code" }).click();
  await expect(dialog.getByLabel("Pairing code: A, B, C, A, B, C, A, B, C, A, B, C", { exact: true })).toHaveText("ABC ABC ABC ABC");
  const approve = dialog.getByRole("button", { name: "Approve this badge" });
  await expect(approve).toBeDisabled();
  await dialog.getByRole("radio", { name: "Verification ID 5678-EFAB" }).check();
  await expect(approve).toBeDisabled();
  await dialog.getByRole("checkbox", { name: "I see 5678-EFAB on my badge." }).check();
  await page.screenshot({ path: test.info().outputPath("pairing-verification.png"), fullPage: true });
  await approve.click();
  await expect(dialog.getByRole("heading", { name: "Badge paired", exact: true })).toBeVisible();
  expect(service.requests.filter((request) => request.action === "approve_claim")).toEqual([{ action: "approve_claim", session_id: "session-1", claim_id: "claim-2" }]);
  await expect(dialog.getByText(/This is a past check-in, not a live connection status/)).toBeVisible();
  expect(page.url()).not.toContain("ABC");
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain("ABCABCABCABC");
  await dialog.getByRole("button", { name: "Close badge pairing" }).click();
  await expect(page.getByRole("button", { name: "Pair a badge", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Pair a badge", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Revoke Badge", exact: true })).toBeVisible();
  expect(service.requests.filter((request) => request.action === "create_pairing")).toHaveLength(1);
  await dialog.getByRole("button", { name: "Revoke Badge", exact: true }).click();
  expect(service.requests.filter((request) => request.action === "revoke_device")).toHaveLength(0);
  await dialog.getByRole("button", { name: "Confirm revoke" }).click();
  await expect(dialog.getByText("Revoked", { exact: true })).toBeVisible();
  expect(service.requests.filter((request) => request.action === "revoke_device")).toEqual([{ action: "revoke_device", device_id: "badge-1" }]);
});

test("regeneration ignores an old in-flight claim response and cancellation removes the code", async ({ page, context, backend }) => {
  void backend;
  const service = await gateway(context);
  let release!: () => void;
  service.statusGate = new Promise<void>((resolve) => { release = resolve; });
  await authenticate(context);
  await openDashboard(page);
  await page.getByRole("button", { name: "Pair a badge", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Pair a badge" });
  await dialog.getByRole("button", { name: "Generate pairing code" }).click();
  await expect.poll(() => service.requests.some((request) => request.action === "status_pairing")).toBe(true);
  service.claims = [];
  service.statusGate = null;
  await dialog.getByRole("button", { name: "Generate new code" }).click();
  await expect(dialog.locator(".pairing-code")).toHaveText("CBA CBA CBA CBA");
  release();
  await expect(dialog.getByText("Waiting for your badge to enter the code…")).toBeVisible();
  await expect(dialog.getByRole("radio")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel pairing", exact: true }).click();
  await expect(dialog.getByText("Pairing cancelled. The code can no longer be used.")).toBeVisible();
  await expect(dialog.locator(".pairing-code")).toHaveCount(0);
  expect(service.requests.filter((request) => request.action === "cancel_pairing")).toEqual([{ action: "cancel_pairing", session_id: "session-2" }]);
});

test("expiry prevents approval and removes the displayed code", async ({ page, context, backend }) => {
  void backend;
  const service = await gateway(context);
  service.expiresAt = new Date(Date.now() + 6_000).toISOString();
  await authenticate(context);
  await openDashboard(page);
  await page.getByRole("button", { name: "Pair a badge", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Pair a badge" });
  await dialog.getByRole("button", { name: "Generate pairing code" }).click();
  await expect(dialog.getByText("This code has expired. Generate a new code to pair.")).toBeVisible();
  await expect(dialog.locator(".pairing-code")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Approve this badge" })).toHaveCount(0);
  expect(service.requests.some((request) => request.action === "approve_claim")).toBe(false);
});

test("network failure pauses polling and explicit retry recovers", async ({ page, context, backend }) => {
  void backend;
  const service = await gateway(context);
  service.failStatus = true;
  await authenticate(context);
  await openDashboard(page);
  await page.getByRole("button", { name: "Pair a badge", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Pair a badge" });
  await dialog.getByRole("button", { name: "Generate pairing code" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Automatic status checks are paused.");
  expect(service.requests.filter((request) => request.action === "status_pairing")).toHaveLength(3);
  service.failStatus = false;
  await dialog.getByRole("button", { name: "Check pairing status" }).click();
  await expect(dialog.getByRole("radio", { name: "Verification ID 1234-ABCD" })).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(service.requests.filter((request) => request.action === "cancel_pairing")).toHaveLength(1);
});

test("an approval racing cancellation is never reported as cancelled", async ({ page, context, backend }) => {
  void backend;
  const service = await gateway(context);
  await authenticate(context);
  await openDashboard(page);
  await page.getByRole("button", { name: "Pair a badge", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Pair a badge" });
  await dialog.getByRole("button", { name: "Generate pairing code" }).click();
  await expect(dialog.locator(".pairing-code")).toBeVisible();
  service.approvedBeforeCancel = true;
  await dialog.getByRole("button", { name: "Cancel pairing", exact: true }).click();
  await expect(dialog.getByText("This badge was already approved. It remains paired.")).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Badge paired", exact: true })).toBeVisible();
  await expect(dialog.getByText("Pairing cancelled. The code can no longer be used.")).toHaveCount(0);
});

test("signing out in another tab clears pairing and ignores a late status response", async ({ page, context, backend }) => {
  void backend;
  const service = await gateway(context);
  await authenticate(context);
  await openDashboard(page);
  const otherTab = await context.newPage();
  await openDashboard(otherTab);
  let release!: () => void;
  service.statusGate = new Promise<void>((resolve) => { release = resolve; });
  await page.getByRole("button", { name: "Pair a badge", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Pair a badge" });
  await dialog.getByRole("button", { name: "Generate pairing code" }).click();
  await expect.poll(() => service.requests.some((request) => request.action === "status_pairing")).toBe(true);
  await otherTab.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Meet your companion" })).toBeVisible();
  release();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".pairing-code")).toHaveCount(0);
  expect(service.requests.some((request) => request.action === "approve_claim")).toBe(false);
  await otherTab.close();
});
