import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@supabase/supabase-js";
import { AccountChangedError } from "../src/lib/backend";
import type { AuthClient } from "../src/lib/backend";
import { BadgePairingClient, groupedPairingCode, pairingMessage } from "../src/lib/badgePairing";

const config = { supabaseUrl: "https://example.supabase.test/", supabaseKey: "public", powersyncUrl: "https://sync.test" };
const status = { session_id: "session-1", state: "pending", expires_at: "2026-10-20T18:00:00Z", claims: [] };

describe("badge owner gateway", () => {
  let session: Session | null;
  let auth: AuthClient;
  let request: ReturnType<typeof vi.fn<typeof fetch>>;
  let api: BadgePairingClient;
  beforeEach(() => {
    session = { user: { id: "owner" }, access_token: "token-1" } as Session;
    auth = { auth: { getSession: vi.fn(async () => ({ data: { session }, error: null })) } } as unknown as AuthClient;
    request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...status, code: "ABCABCABCABC" }));
    api = new BadgePairingClient(auth, config, "owner", request);
  });

  it("reads refreshed owner auth for every call and keeps all pairing data out of URLs", async () => {
    expect((await api.create()).code).toBe("ABCABCABCABC");
    session = { ...session!, access_token: "token-2" };
    request.mockResolvedValueOnce(Response.json(status));
    await api.status("session-1");
    const [url, options] = request.mock.calls[1];
    expect(url).toBe("https://example.supabase.test/functions/v1/badge-gateway");
    expect(options).toMatchObject({ method: "POST", cache: "no-store", headers: { Authorization: "Bearer token-2" } });
    expect(JSON.parse(options!.body as string)).toEqual({ action: "status_pairing", session_id: "session-1" });
    session = { ...session!, user: { id: "other-owner" } } as Session;
    await expect(api.approve("session-1", "claim-1")).rejects.toBeInstanceOf(AccountChangedError);
    session = null;
    await expect(api.devices()).rejects.toBeInstanceOf(AccountChangedError);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("approves only the explicitly supplied claim and verifies its acknowledgment", async () => {
    request.mockResolvedValueOnce(Response.json({ state: "approved", claim_id: "chosen", device_id: "badge" }));
    await api.approve("session-1", "chosen");
    expect(JSON.parse(request.mock.calls[0][1]!.body as string)).toEqual({ action: "approve_claim", session_id: "session-1", claim_id: "chosen" });
    request.mockResolvedValueOnce(Response.json({ state: "approved", claim_id: "different", device_id: "badge" }));
    await expect(api.approve("session-1", "chosen")).rejects.toThrow("Invalid pairing response");
  });

  it("rejects malformed codes, unexpected states and another pairing's status", async () => {
    for (const code of ["ABC", "ABCDABCABCAB", "ABC ABC ABC ABC"]) {
      request.mockResolvedValueOnce(Response.json({ ...status, code }));
      await expect(api.create()).rejects.toThrow("Invalid pairing response");
    }
    request.mockResolvedValueOnce(Response.json({ ...status, session_id: "other-session" }));
    await expect(api.status("session-1")).rejects.toThrow("Invalid pairing response");
    request.mockResolvedValueOnce(Response.json({ ...status, state: "online" }));
    await expect(api.status("session-1")).rejects.toThrow("Invalid pairing response");
  });

  it("does not expose arbitrary upstream text or error codes", async () => {
    request.mockResolvedValueOnce(Response.json({ error: "secret ABCABCABCABC", message: "token-private" }, { status: 503 }));
    const error = await api.create().catch((error: unknown) => error);
    expect(pairingMessage(error)).toBe("Couldn’t reach badge pairing. Check your connection and try again.");
    expect(pairingMessage(new Error("token-private"))).not.toContain("token-private");
    request.mockResolvedValueOnce(Response.json({ error: "limited" }, { status: 429 }));
    await expect(api.create()).rejects.toThrow("Try again later");
  });

  it("forwards cancellation and invokes native fetch without an illegal receiver", async () => {
    const controller = new AbortController();
    let passedSignal: AbortSignal | null | undefined;
    const browserFetch = vi.fn(function (this: unknown, _url: RequestInfo | URL, init?: RequestInit) {
      expect(this === undefined || this === globalThis).toBe(true);
      passedSignal = init?.signal;
      return Promise.resolve(Response.json({ state: "cancelled" }));
    });
    vi.stubGlobal("fetch", browserFetch);
    try {
      await new BadgePairingClient(auth, config, "owner").cancel("session-1", controller.signal);
      controller.abort();
      expect(passedSignal?.aborted).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });

  it("groups twelve button presses without changing the sequence", () => {
    expect(groupedPairingCode("ABCABCABCABC")).toBe("ABC ABC ABC ABC");
    expect(() => groupedPairingCode("ABC<script>")).toThrow();
  });
});
