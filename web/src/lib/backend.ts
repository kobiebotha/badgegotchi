import type { Session, SupabaseClient } from "@supabase/supabase-js";
import type { PublicConfig } from "./config";

export type AuthClient = Pick<SupabaseClient, "auth">;
export type Request = typeof fetch;

export class AccountChangedError extends Error {
  constructor() {
    super("This database belongs to a different signed-in account.");
    this.name = "AccountChangedError";
  }
}

export async function currentSession(
  client: AuthClient,
  expectedUserId?: string,
): Promise<Session | null> {
  // getSession refreshes expired credentials and reads the current identity on
  // every call; never hold an access token captured when the database opened.
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  const session = data.session;
  if (!session || (expectedUserId && session.user.id !== expectedUserId))
    return null;
  return session;
}

export async function requireSession(
  client: AuthClient,
  expectedUserId?: string,
): Promise<Session> {
  const session = await currentSession(client, expectedUserId);
  if (!session) throw new AccountChangedError();
  return session;
}

export class BackendRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "BackendRequestError";
  }
}

/** Each request is bound to the identity that passed the account check. */
export function authHeaders(
  config: PublicConfig,
  session: Session,
): Record<string, string> {
  return {
    apikey: config.supabaseKey,
    Authorization: `Bearer ${session.access_token}`,
    "Content-Type": "application/json",
  };
}

export async function assertResponse(
  response: Response,
  action: string,
  queued = true,
): Promise<void> {
  if (!response.ok) {
    // Do not include arbitrary upstream response bodies, which can contain
    // implementation details or values the user entered.
    throw new BackendRequestError(
      response.status,
      `${action} failed (${response.status}). ${queued ? "Changes remain queued for retry." : "Please try again."}`,
    );
  }
}

export async function invokePetCommand(
  client: AuthClient,
  config: PublicConfig,
  body: Record<string, unknown>,
  expectedUserId?: string,
  request: Request = fetch,
): Promise<void> {
  const session = await requireSession(client, expectedUserId);
  const response = await request(
    `${config.supabaseUrl.replace(/\/$/, "")}/functions/v1/pet-ai`,
    {
      method: "POST",
      headers: authHeaders(config, session),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(body.action === "react" ? 60_000 : 15_000),
    },
  );
  await assertResponse(response, "Pet cloud request", body.action === "react");
  // Responses may be terminal rejections after a reset. They are acknowledged;
  // authoritative pet state and failure details arrive through PowerSync.
}
