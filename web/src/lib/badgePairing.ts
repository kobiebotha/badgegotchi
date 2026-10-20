import { AccountChangedError, authHeaders, requireSession } from "./backend";
import type { AuthClient, Request } from "./backend";
import type { PublicConfig } from "./config";

export type PairingState = "pending" | "approved" | "delivered" | "cancelled" | "expired" | "revoked";
export interface PairingClaim {
  claim_id: string;
  verification_id: string;
  state: string;
  device_id?: string;
}
export interface PairingStatus {
  session_id: string;
  expires_at: string;
  state: PairingState;
  claims: PairingClaim[];
}
export interface PairingCode extends PairingStatus { code: string }
export interface PairedBadge {
  device_id: string;
  name: string | null;
  state: string;
  paired_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

export class BadgePairingError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(pairingErrorMessage(status, code));
    this.name = "BadgePairingError";
  }
}

function pairingErrorMessage(status: number, code: string): string {
  if (status === 401 || status === 403) return "Your sign-in could not be verified. Sign in again to manage badges.";
  if (status === 429) return "Too many pairing requests. Try again later.";
  if (status === 404) return "This pairing is no longer available. Generate a new code.";
  if (status === 409 || status === 410 || code === "pairing_expired") return "This pairing changed or expired. Check its status or generate a new code.";
  return "Couldn’t reach badge pairing. Check your connection and try again.";
}

export function pairingMessage(error: unknown): string {
  if (error instanceof BadgePairingError) return error.message;
  if (error instanceof AccountChangedError) return "Your account changed. Sign in again to manage badges.";
  return "Couldn’t reach badge pairing. Check your connection and try again.";
}

export function groupedPairingCode(code: string): string {
  if (!/^[ABC]{12}$/.test(code)) throw new Error("Invalid pairing response.");
  return code.match(/.{3}/g)!.join(" ");
}

const states = new Set<PairingState>(["pending", "approved", "delivered", "cancelled", "expired", "revoked"]);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 200; }
function timestamp(value: unknown): value is string { return text(value) && Number.isFinite(Date.parse(value)); }

function parseStatus(value: unknown, creation = false): PairingStatus {
  if (!record(value) || !text(value.session_id) || !timestamp(value.expires_at) || !states.has(value.state as PairingState)) {
    throw new Error("Invalid pairing response.");
  }
  const claims = value.claims ?? (creation ? [] : undefined);
  if (!Array.isArray(claims) || claims.length > 3 || !claims.every((claim) => record(claim)
    && text(claim.claim_id) && text(claim.verification_id) && text(claim.state))) {
    throw new Error("Invalid pairing response.");
  }
  return { session_id: value.session_id, expires_at: value.expires_at, state: value.state as PairingState, claims: claims as PairingClaim[] };
}

/** Owner operations use fresh Supabase auth; no code or token is persisted here. */
export class BadgePairingClient {
  constructor(
    private readonly auth: AuthClient,
    private readonly config: PublicConfig,
    private readonly userId: string,
    private readonly request: Request = fetch,
  ) {}

  private async invoke(action: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    const session = await requireSession(this.auth, this.userId);
    const timeout = AbortSignal.timeout(10_000);
    const request = this.request;
    const response = await request(`${this.config.supabaseUrl.replace(/\/$/, "")}/functions/v1/badge-gateway`, {
      method: "POST",
      headers: authHeaders(this.config, session),
      body: JSON.stringify({ action, ...body }),
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      // Never display/log arbitrary server bodies: they may contain credentials.
      const value: unknown = await response.json().catch(() => null);
      throw new BadgePairingError(response.status, record(value) && typeof value.error === "string" ? value.error : "unavailable");
    }
    return response.json();
  }

  async create(signal?: AbortSignal): Promise<PairingCode> {
    const value = await this.invoke("create_pairing", {}, signal);
    const status = parseStatus(value, true);
    if (!record(value) || typeof value.code !== "string" || !/^[ABC]{12}$/.test(value.code) || status.state !== "pending") {
      throw new Error("Invalid pairing response.");
    }
    return { ...status, code: value.code };
  }

  async status(sessionId: string, signal?: AbortSignal): Promise<PairingStatus> {
    const status = parseStatus(await this.invoke("status_pairing", { session_id: sessionId }, signal));
    if (status.session_id !== sessionId) throw new Error("Invalid pairing response.");
    return status;
  }

  async cancel(sessionId: string, signal?: AbortSignal): Promise<PairingState> {
    const value = await this.invoke("cancel_pairing", { session_id: sessionId }, signal);
    if (!record(value) || !states.has(value.state as PairingState)) throw new Error("Invalid pairing response.");
    return value.state as PairingState;
  }

  async approve(sessionId: string, claimId: string, signal?: AbortSignal): Promise<void> {
    const value = await this.invoke("approve_claim", { session_id: sessionId, claim_id: claimId }, signal);
    if (!record(value) || value.state !== "approved" || value.claim_id !== claimId || !text(value.device_id)) {
      throw new Error("Invalid pairing response.");
    }
  }

  async devices(signal?: AbortSignal): Promise<PairedBadge[]> {
    const value = await this.invoke("list_devices", {}, signal);
    if (!record(value) || !Array.isArray(value.devices) || !value.devices.every((device) => record(device)
      && text(device.device_id) && (device.name === null || text(device.name)) && text(device.state)
      && timestamp(device.paired_at) && (device.last_seen_at === null || timestamp(device.last_seen_at))
      && (device.revoked_at === null || timestamp(device.revoked_at)))) {
      throw new Error("Invalid device response.");
    }
    return value.devices as PairedBadge[];
  }

  async revoke(deviceId: string, signal?: AbortSignal): Promise<void> {
    await this.invoke("revoke_device", { device_id: deviceId }, signal);
  }
}
