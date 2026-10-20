/** All owner identity comes from Auth. All device identity comes from the
 * service-only RPC. Secrets stay out of responses, logs, URLs and public tables. */
type Json = Record<string, unknown>;
export type Config = {
  supabaseUrl: string;
  serviceKey: string;
  hmacKey: string;
  signingJwk: string;
  signingKid: string;
  powersyncUrl: string;
  powersyncAudience: string;
};
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const secret = /^[0-9a-f]{64}$/;
const ownerActions = new Set([
  "create_pairing",
  "status_pairing",
  "cancel_pairing",
  "approve_claim",
  "list_devices",
  "revoke_device",
]);
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, apikey, content-type, x-client-info",
  "access-control-allow-methods": "POST, GET, OPTIONS",
};
class Fault extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}
function obj(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Fault("invalid_request", 400);
  }
  return value as Json;
}
function fields(body: Json, allowed: string[], envelope = true) {
  if (
    Object.keys(body).some((key) =>
      ![...(envelope ? ["action"] : []), ...allowed].includes(key)
    )
  ) {
    throw new Fault("invalid_request", 400);
  }
}
function field(body: Json, key: string, regex: RegExp): string {
  const value = body[key];
  if (typeof value !== "string" || !regex.test(value)) {
    throw new Fault("invalid_request", 400);
  }
  return value;
}
function b64url(input: Uint8Array): string {
  return btoa(String.fromCharCode(...input)).replaceAll("+", "-").replaceAll(
    "/",
    "_",
  ).replaceAll("=", "");
}
const encoder = new TextEncoder();
function json64(value: unknown) {
  return b64url(encoder.encode(JSON.stringify(value)));
}
export function abcCode(): string {
  let code = "";
  while (code.length < 12) {
    // 255 is rejected so each of the three symbols has exactly 85 outcomes.
    for (const byte of crypto.getRandomValues(new Uint8Array(24))) {
      if (byte < 255) code += "ABC"[byte % 3];
      if (code.length === 12) break;
    }
  }
  return code;
}
async function boundedJson(req: Request): Promise<Json> {
  if (Number(req.headers.get("content-length") ?? 0) > 8192) {
    throw new Fault("request_too_large", 413);
  }
  if (
    !req.headers.get("content-type")?.toLowerCase().startsWith(
      "application/json",
    )
  ) throw new Fault("invalid_content_type", 415);
  if (!req.body) throw new Fault("invalid_request", 400);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8192) {
        await reader.cancel();
        throw new Fault("request_too_large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return obj(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch {
    throw new Fault("invalid_request", 400);
  }
}

export function createHandler(
  config: Config,
  request: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  const issuer = `${
    config.supabaseUrl.replace(/\/$/, "")
  }/functions/v1/badge-gateway`;
  let hmac: Promise<CryptoKey> | undefined;
  let signer: Promise<CryptoKey> | undefined;
  let publicJwk: Json | undefined;
  function configure() {
    if (
      !/^https:\/\//.test(config.supabaseUrl) || !config.serviceKey ||
      !secret.test(config.hmacKey) ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(config.signingKid) ||
      !/^https:\/\//.test(config.powersyncUrl) || !config.powersyncAudience
    ) {
      throw new Fault("configuration_unavailable", 503);
    }
    if (!hmac) {
      hmac = crypto.subtle.importKey(
        "raw",
        Uint8Array.from(
          config.hmacKey.match(/../g)!.map((v) => parseInt(v, 16)),
        ),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
    }
    if (!signer) {
      let jwk: Json;
      try {
        jwk = obj(JSON.parse(config.signingJwk));
      } catch {
        throw new Fault("configuration_unavailable", 503);
      }
      if (
        jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.d !== "string" ||
        typeof jwk.x !== "string" || typeof jwk.y !== "string"
      ) throw new Fault("configuration_unavailable", 503);
      // Explicit allowlist: private `d` and arbitrary supplied properties never escape.
      publicJwk = {
        kty: "EC",
        crv: "P-256",
        x: jwk.x,
        y: jwk.y,
        kid: config.signingKid,
        alg: "ES256",
        use: "sig",
      };
      signer = crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      );
    }
  }
  async function digest(domain: string, value: string): Promise<string> {
    const bytes = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await hmac!,
        encoder.encode(`badge-v1:${domain}:${value}`),
      ),
    );
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }
  async function rpc(name: string, args: Json): Promise<unknown> {
    const response = await request(
      `${config.supabaseUrl}/rest/v1/rpc/${name}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.serviceKey}`,
          apikey: config.serviceKey,
          "content-type": "application/json",
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) throw new Fault("backend_unavailable", 503);
    return response.json();
  }
  async function rate(
    scope: string,
    subject: string,
    limit: number,
    seconds = 60,
  ) {
    if (
      await rpc("badge_rate_limit", {
        p_scope: scope,
        p_subject: await digest("rate", subject),
        p_limit: limit,
        p_seconds: seconds,
      }) !== true
    ) throw new Fault("rate_limited", 429);
  }
  async function run(action: string, owner: string | null, data: Json) {
    const result = obj(
      await rpc("badge_gateway", {
        p_action: action,
        p_owner: owner,
        p_data: data,
      }),
    );
    if (typeof result.error === "string") {
      const status = result.error === "unauthorized"
        ? 401
        : result.error === "not_found"
        ? 404
        : [
            "conflict",
            "request_conflict",
            "event_conflict",
            "pairing_unavailable",
            "device_limit",
          ].includes(result.error)
        ? 409
        : 400;
      throw new Fault(result.error, status);
    }
    return result;
  }
  function reply(body: unknown, status = 200) {
    return Response.json(body, {
      status,
      headers: {
        ...cors,
        "cache-control": "no-store",
        ...(status === 429 ? { "retry-after": "60" } : {}),
      },
    });
  }
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    try {
      configure();
      await Promise.all([hmac, signer]);
      const path = new URL(req.url).pathname.replace(/\/$/, "");
      if (req.method === "GET" && path.endsWith("/badge-gateway/jwks")) {
        await signer;
        return Response.json({ keys: [publicJwk] }, {
          headers: { ...cors, "cache-control": "public, max-age=60" },
        });
      }
      if (req.method !== "POST" || !path.endsWith("/badge-gateway")) {
        throw new Fault("not_found", 404);
      }
      await rate("global", "gateway", 240);
      const body = await boundedJson(req);
      const action = typeof body.action === "string" ? body.action : "";
      let owner: string | null = null;
      let sessionId: string | undefined;
      if (ownerActions.has(action)) {
        const authorization = req.headers.get("authorization");
        if (!authorization?.startsWith("Bearer ")) {
          throw new Fault("unauthorized", 401);
        }
        const response = await request(`${config.supabaseUrl}/auth/v1/user`, {
          headers: { authorization, apikey: config.serviceKey },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          throw new Fault(
            response.status >= 500 || response.status === 429
              ? "auth_unavailable"
              : "unauthorized",
            response.status >= 500 || response.status === 429 ? 503 : 401,
          );
        }
        owner = field(obj(await response.json()), "id", uuid);
        // Decode only AFTER Auth validates this exact bearer. The SQL RPC also
        // checks the session still exists, covering signed-out/deleted sessions.
        try {
          const payload = authorization.slice(7).split(".")[1];
          const claims = obj(
            JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/"))),
          );
          sessionId = field(claims, "session_id", uuid);
        } catch {
          throw new Fault("unauthorized", 401);
        }
        await rate("owner", owner, 120);
      }
      const auth = sessionId ? { auth_session_id: sessionId } : {};
      if (action === "create_pairing") {
        fields(body, []);
        await rate("create_pairing", owner!, 6, 3600);
        // A rare active-code collision retries a fresh random code; other errors propagate.
        for (let attempt = 0; attempt < 4; attempt++) {
          const code = abcCode();
          try {
            return reply({
              ...await run(action, owner, {
                ...auth,
                code_hash: await digest("code", code),
              }),
              code,
            });
          } catch (error) {
            if (!(error instanceof Fault) || error.code !== "conflict") {
              throw error;
            }
          }
        }
        throw new Fault("pairing_unavailable", 503);
      }
      if (["status_pairing", "cancel_pairing"].includes(action)) {
        fields(body, ["session_id"]);
        return reply(
          await run(action, owner, {
            ...auth,
            session_id: field(body, "session_id", uuid),
          }),
        );
      }
      if (action === "approve_claim") {
        fields(body, ["session_id", "claim_id", "name"]);
        const name = body.name ?? "Badge";
        if (
          typeof name !== "string" || !name.trim() ||
          Array.from(name).length > 40 ||
          Array.from(name).some((char) =>
            char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
          )
        ) throw new Fault("invalid_request", 400);
        return reply(
          await run(action, owner, {
            ...auth,
            session_id: field(body, "session_id", uuid),
            claim_id: field(body, "claim_id", uuid),
            name: name.trim(),
          }),
        );
      }
      if (action === "list_devices") {
        fields(body, []);
        return reply(await run(action, owner, auth));
      }
      if (action === "revoke_device") {
        fields(body, ["device_id"]);
        return reply(
          await run(action, owner, {
            ...auth,
            device_id: field(body, "device_id", uuid),
          }),
        );
      }
      if (action === "claim") {
        fields(body, ["code", "pending_secret", "credential"]);
        await rate("claims", "bootstrap", 20);
        const code = field(body, "code", /^[ABC]{12}$/);
        const pending = field(body, "pending_secret", secret);
        const credential = field(body, "credential", secret);
        if (pending === credential) throw new Fault("invalid_request", 400);
        await rate("code", code, 6);
        await rate("pending", pending, 30);
        const verification =
          (await digest("verification", `${pending}:${credential}`)).slice(0, 8)
            .toUpperCase();
        return reply(
          await run(action, null, {
            code_hash: await digest("code", code),
            pending_hash: await digest("pending", pending),
            credential_hash: await digest("credential", credential),
            verification_id: `${verification.slice(0, 4)}-${
              verification.slice(4)
            }`,
          }),
        );
      }
      if (action === "poll") {
        fields(body, ["pending_secret"]);
        const pending = field(body, "pending_secret", secret);
        await rate("pending", pending, 30);
        return reply(
          await run(action, null, {
            pending_hash: await digest("pending", pending),
          }),
        );
      }
      if (["ack", "token", "upload"].includes(action)) {
        fields(
          body,
          action === "upload"
            ? ["credential", "request_id", "events"]
            : ["credential"],
        );
        const credential = field(body, "credential", secret);
        await rate("credential", credential, 60);
        const data: Json = {
          credential_hash: await digest("credential", credential),
        };
        if (action === "upload") {
          data.request_id = field(body, "request_id", uuid);
          if (
            !Array.isArray(body.events) || body.events.length < 1 ||
            body.events.length > 8
          ) throw new Fault("invalid_events", 400);
          const ids = new Set<string>();
          data.events = body.events.map((value) => {
            const e = obj(value);
            fields(e, ["id", "type", "day_key", "occurred_at"], false);
            const id = field(e, "id", uuid).toLowerCase();
            if (ids.has(id)) throw new Fault("invalid_events", 400);
            ids.add(id);
            const type = field(e, "type", /^(hydration|movement)$/);
            const occurred_at = field(
              e,
              "occurred_at",
              /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/,
            );
            const when = Date.parse(occurred_at);
            // Age/future bounds belong in SQL after the existing-receipt lookup:
            // a receipt retry must still work after an accepted event ages out.
            if (!Number.isFinite(when)) throw new Fault("invalid_events", 400);
            const day_key = field(e, "day_key", /^\d{4}-\d{2}-\d{2}$/);
            if (new Date(when).toISOString().slice(0, 10) !== day_key) {
              throw new Fault("invalid_events", 400);
            }
            return { id, type, occurred_at, day_key };
          });
          data.payload_hash = await digest(
            "upload",
            JSON.stringify(data.events),
          );
        }
        const result = await run(action, null, data);
        if (action !== "token") return reply(result);
        const iat = Math.floor(now() / 1000), exp = iat + 300;
        const input = `${
          json64({ alg: "ES256", typ: "JWT", kid: config.signingKid })
        }.${
          json64({
            sub: field(result, "owner_id", uuid),
            iss: issuer,
            aud: config.powersyncAudience,
            iat,
            exp,
            device_id: field(result, "device_id", uuid),
            badge_scope: "v1",
          })
        }`;
        const signature = new Uint8Array(
          await crypto.subtle.sign(
            { name: "ECDSA", hash: "SHA-256" },
            await signer!,
            encoder.encode(input),
          ),
        );
        return reply({
          token: `${input}.${b64url(signature)}`,
          endpoint: config.powersyncUrl,
          expires_at: exp,
          device_id: result.device_id,
          owner_id: result.owner_id,
        });
      }
      throw new Fault("invalid_action", 400);
    } catch (error) {
      // Never log thrown request/RPC payloads or provider response bodies.
      return error instanceof Fault
        ? reply({ error: error.code }, error.status)
        : reply({ error: "backend_unavailable" }, 503);
    }
  };
}
