import { abcCode, type Config, createHandler } from "./handler.ts";
const owner = "aaaaaaaa-0000-4000-8000-000000000001";
const session = "aaaaaaaa-0000-4000-8000-000000000002";
const device = "bbbbbbbb-0000-4000-8000-000000000001";
const claim = "cccccccc-0000-4000-8000-000000000001";
const event = "dddddddd-0000-4000-8000-000000000001";
const credential = "a".repeat(64), pending = "b".repeat(64);
const bearer = `Bearer header.${
  btoa(JSON.stringify({ session_id: session }))
}.signature`;
const url = "https://example.supabase.co/functions/v1/badge-gateway";
const now = Date.parse("2026-10-20T18:00:00.000Z");
function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
function equal(actual: unknown, expected: unknown) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
  );
}
const keyPair = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);
const config: Config = {
  supabaseUrl: "https://example.supabase.co",
  serviceKey: "service-only",
  hmacKey: "1".repeat(64),
  signingJwk: JSON.stringify(
    await crypto.subtle.exportKey("jwk", keyPair.privateKey),
  ),
  signingKid: "test-v1",
  powersyncUrl: "https://sync.example.test",
  powersyncAudience: "sync.example.test",
};
type Json = Record<string, unknown>;
function call(body: unknown, authorization = bearer) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body: JSON.stringify(body),
  });
}
function harness(
  options: {
    result?: Json;
    authStatus?: number;
    rateAllowed?: boolean;
    rpcStatus?: number;
    config?: Partial<Config>;
  } = {},
) {
  const calls: { url: string; body: Json; headers: Headers }[] = [];
  const request: typeof fetch = (input, init) => {
    const dest = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url: dest, body, headers: new Headers(init?.headers) });
    if (dest.endsWith("/auth/v1/user")) {
      return Promise.resolve(
        Response.json({ id: owner }, { status: options.authStatus ?? 200 }),
      );
    }
    if (dest.endsWith("/badge_rate_limit")) {
      return Promise.resolve(Response.json(options.rateAllowed ?? true));
    }
    if (dest.endsWith("/badge_gateway") || dest.endsWith("/account_gateway")) {
      return Promise.resolve(
        Response.json(
          options.result ??
            { state: "active", device_id: device, owner_id: owner },
          { status: options.rpcStatus ?? 200 },
        ),
      );
    }
    throw new Error("Unexpected request");
  };
  return {
    handler: createHandler(
      { ...config, ...options.config },
      request,
      () => now,
    ),
    calls,
  };
}
function decode(s: string) {
  return Uint8Array.from(
    atob(s.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
}
Deno.test("ABC generation has exact alphabet and length", () => {
  for (let i = 0; i < 100; i++) assert(/^[ABC]{12}$/.test(abcCode()));
});
Deno.test("JWKS exposes public EC fields only and real token verifies", async () => {
  const { handler, calls } = harness();
  const jwks = await (await handler(new Request(`${url}/jwks`))).json();
  equal(Object.keys(jwks.keys[0]).sort(), [
    "alg",
    "crv",
    "kid",
    "kty",
    "use",
    "x",
    "y",
  ]);
  assert(!JSON.stringify(jwks).includes('"d"'));
  assert(calls.length === 0);
  const res = await handler(call({ action: "token", credential }, ""));
  equal(res.status, 200);
  const output = await res.json();
  const pieces = output.token.split(".");
  const pub = await crypto.subtle.importKey(
    "jwk",
    jwks.keys[0],
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  assert(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pub,
      decode(pieces[2]),
      new TextEncoder().encode(`${pieces[0]}.${pieces[1]}`),
    ),
  );
  const claims = JSON.parse(new TextDecoder().decode(decode(pieces[1])));
  equal(claims, {
    sub: owner,
    iss: url,
    aud: config.powersyncAudience,
    iat: now / 1000,
    exp: now / 1000 + 300,
    device_id: device,
    badge_scope: "v1",
  });
  equal(output.expires_at, now / 1000 + 300);
  equal(output.endpoint, config.powersyncUrl);
  assert(!JSON.stringify(calls).includes(credential));
});
Deno.test("owner creation validates Auth, passes session, returns code once without persisting it", async () => {
  const { handler, calls } = harness({
    result: {
      session_id: session,
      state: "pending",
      expires_at: "2026-10-20T18:05:00Z",
    },
  });
  const res = await handler(call({ action: "create_pairing" }));
  equal(res.status, 200);
  const output = await res.json();
  assert(/^[ABC]{12}$/.test(output.code));
  const db = calls.find((c) => c.url.endsWith("/badge_gateway"))!;
  equal(db.body.p_owner, owner);
  equal((db.body.p_data as Json).auth_session_id, session);
  assert(/^[0-9a-f]{64}$/.test(String((db.body.p_data as Json).code_hash)));
  assert(!JSON.stringify(calls).includes(output.code));
  equal(
    calls.find((c) => c.url.endsWith("/auth/v1/user"))!.headers.get(
      "authorization",
    ),
    bearer,
  );
});
Deno.test("owner requests reject invalid Auth, unsigned session and caller owner fields", async () => {
  const denied = harness({ authStatus: 401 });
  equal((await denied.handler(call({ action: "list_devices" }))).status, 401);
  assert(!denied.calls.some((c) => c.url.endsWith("/badge_gateway")));
  const badSession = harness();
  equal(
    (await badSession.handler(call({ action: "list_devices" }, "Bearer token")))
      .status,
    401,
  );
  const injection = harness();
  equal(
    (await injection.handler(
      call({ action: "list_devices", owner_id: device }),
    )).status,
    400,
  );
  assert(!injection.calls.some((c) => c.url.endsWith("/badge_gateway")));
});
Deno.test("claims persist only distinct hashes and exact immutable verification binding", async () => {
  const { handler, calls } = harness({
    result: { claim_id: claim, verification_id: "ABCD-1234", state: "pending" },
  });
  const res = await handler(
    call({
      action: "claim",
      code: "ABCABCABCABC",
      pending_secret: pending,
      credential,
    }, ""),
  );
  equal(res.status, 200);
  const data = calls.find((c) => c.url.endsWith("/badge_gateway"))!.body
    .p_data as Json;
  assert(/^[A-F0-9]{4}-[A-F0-9]{4}$/.test(String(data.verification_id)));
  assert(
    new Set([data.code_hash, data.pending_hash, data.credential_hash]).size ===
      3,
  );
  assert(!JSON.stringify(calls).includes("ABCABCABCABC"));
  assert(!JSON.stringify(calls).includes(credential));
  assert(!JSON.stringify(calls).includes(pending));
  equal(
    (await handler(
      call({
        action: "claim",
        code: "ABCABCABCABC",
        pending_secret: credential,
        credential,
      }, ""),
    )).status,
    400,
  );
});
Deno.test("poll sends pending hash only; approval binds exact claim and session", async () => {
  const { handler, calls } = harness({
    result: { state: "approved", device_id: device, owner_id: owner },
  });
  equal(
    (await handler(call({ action: "poll", pending_secret: pending }, "")))
      .status,
    200,
  );
  const data = calls.find((c) => c.url.endsWith("/badge_gateway"))!.body
    .p_data as Json;
  equal(Object.keys(data), ["pending_hash"]);
  equal(
    (await handler(
      call({
        action: "approve_claim",
        session_id: session,
        claim_id: claim,
        name: "Desk badge",
      }),
    )).status,
    200,
  );
  const approve =
    calls.filter((c) => c.url.endsWith("/badge_gateway")).at(-1)!.body;
  equal(approve.p_owner, owner);
  equal((approve.p_data as Json).claim_id, claim);
  equal((approve.p_data as Json).session_id, session);
});
Deno.test("global limit fails before request parsing or Auth and returns retry-after", async () => {
  const { handler, calls } = harness({ rateAllowed: false });
  const res = await handler(call({ action: "create_pairing" }));
  equal(res.status, 429);
  equal(res.headers.get("retry-after"), "60");
  equal(calls.length, 1);
});
Deno.test("bounded streaming reader rejects oversized body without relying on content-length", async () => {
  const { handler, calls } = harness();
  const res = await handler(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "poll",
        pending_secret: "z".repeat(9000),
      }),
    }),
  );
  equal(res.status, 413);
  assert(!calls.some((c) => c.url.endsWith("/badge_gateway")));
});
Deno.test("uploads use stable canonical digest; reject invalid or duplicate entries before RPC", async () => {
  const { handler, calls } = harness({
    result: { state: "accepted", request_id: session, accepted: 1 },
  });
  const events = [{
    id: event,
    type: "hydration",
    occurred_at: "2026-10-20T17:59:00.000Z",
    day_key: "2026-10-20",
  }];
  equal(
    (await handler(
      call({ action: "upload", credential, request_id: session, events }, ""),
    )).status,
    200,
  );
  const first =
    (calls.find((c) => c.url.endsWith("/badge_gateway"))!.body.p_data as Json)
      .payload_hash;
  const reordered = [{
    day_key: "2026-10-20",
    occurred_at: "2026-10-20T17:59:00.000Z",
    type: "hydration",
    id: event,
  }];
  await handler(
    call({
      action: "upload",
      credential,
      request_id: session,
      events: reordered,
    }, ""),
  );
  equal(
    (calls.filter((c) => c.url.endsWith("/badge_gateway")).at(-1)!.body
      .p_data as Json).payload_hash,
    first,
  );
  for (
    const invalid of [
      [...events, ...events],
      [{ ...events[0], owner_id: owner }],
      [{ ...events[0], day_key: "1999-01-01" }],
      [{ ...events[0], type: "timer" }],
      Array(9).fill(events[0]),
    ]
  ) {
    const before = calls.filter((c) => c.url.endsWith("/badge_gateway")).length;
    equal(
      (await handler(
        call({
          action: "upload",
          credential,
          request_id: session,
          events: invalid,
        }, ""),
      )).status,
      400,
    );
    equal(calls.filter((c) => c.url.endsWith("/badge_gateway")).length, before);
  }
});
Deno.test("revoked credential never receives token and domain conflicts are explicit", async () => {
  const revoked = harness({ result: { error: "unauthorized" } });
  const denied = await revoked.handler(
    call({ action: "token", credential }, ""),
  );
  equal(denied.status, 401);
  equal(await denied.json(), { error: "unauthorized" });
  const conflict = harness({ result: { error: "request_conflict" } });
  equal(
    (await conflict.handler(call({ action: "ack", credential }, ""))).status,
    409,
  );
});
Deno.test("configuration and database failures do not leak secrets", async () => {
  const bad = harness({ config: { signingJwk: "not JSON" } });
  const fail = await bad.handler(call({ action: "token", credential }, ""));
  equal(fail.status, 503);
  equal(await fail.json(), { error: "configuration_unavailable" });
  const outage = harness({ rpcStatus: 500 });
  const res = await outage.handler(call({ action: "ack", credential }, ""));
  equal(res.status, 503);
  equal(await res.json(), { error: "backend_unavailable" });
});

Deno.test("old accepted receipt retries reach SQL before first-acceptance age checks", async () => {
  const { handler, calls } = harness({
    result: { state: "accepted", request_id: session, accepted: 1 },
  });
  const res = await handler(
    call({
      action: "upload",
      credential,
      request_id: session,
      events: [{
        id: event,
        type: "hydration",
        occurred_at: "2026-01-01T00:00:00.000Z",
        day_key: "2026-01-01",
      }],
    }, ""),
  );
  equal(res.status, 200);
  assert(calls.some((c) => c.url.endsWith("/badge_gateway")));
});

Deno.test("account command derives browser owner and canonical immutable payload", async () => {
  const { handler, calls } = harness({
    result: { state: "accepted", command_id: event, revision: "1" },
  });
  const command = {
    id: event.toUpperCase(),
    type: "timer_start",
    occurred_at: "2026-10-20T18:00:00Z",
    expected_revision: "0",
    new_session_id: claim,
    session_type: "focus",
  };
  equal((await handler(call({ action: "command", command }))).status, 200);
  const rpc = calls.find((c) => c.url.endsWith("/account_gateway"))!;
  equal(rpc.body.p_owner, owner);
  equal(rpc.body.p_data, {
    auth_session_id: session,
    command: {
      id: event,
      type: "timer_start",
      occurred_at: "2026-10-20T18:00:00.000Z",
      expected_revision: "0",
      new_session_id: claim,
      session_type: "focus",
    },
  });
});
Deno.test("badge command hashes credential and terminal conflict stays successful HTTP", async () => {
  const { handler, calls } = harness({
    result: {
      state: "rejected",
      command_id: event,
      reason: "stale_revision",
      revision: "4",
    },
  });
  const response = await handler(
    call({
      action: "command",
      credential,
      command: {
        id: event,
        type: "hydration",
        occurred_at: "2026-10-20T18:00:00Z",
      },
    }, ""),
  );
  equal(response.status, 200);
  equal((await response.json()).state, "rejected");
  assert(!calls.some((c) => c.url.endsWith("/auth/v1/user")));
  const rpc = calls.find((c) => c.url.endsWith("/account_gateway"))!;
  equal(rpc.body.p_owner, null);
  assert(!JSON.stringify(rpc.body).includes(credential));
});
Deno.test("commands reject extra ownership, invalid revisions, and mismatched reset day", async () => {
  for (
    const extra of [{ owner_id: owner }, { expected_revision: 0 }, {
      expected_revision: "-1",
    }, { expected_revision: "9223372036854775808" }]
  ) {
    const { handler, calls } = harness();
    equal(
      (await handler(
        call({
          action: "command",
          command: {
            id: event,
            type: "timer_pause",
            occurred_at: "2026-10-20T18:00:00Z",
            session_id: claim,
            expected_revision: "0",
            ...extra,
          },
        }),
      )).status,
      400,
    );
    assert(!calls.some((c) => c.url.endsWith("/account_gateway")));
  }
  const { handler } = harness();
  equal(
    (await handler(
      call({
        action: "command",
        command: {
          id: event,
          type: "reset_day",
          occurred_at: "2026-10-20T18:00:00Z",
          expected_revision: "0",
          day_key: "2026-10-19",
        },
      }),
    )).status,
    400,
  );
});
Deno.test("refresh validates owner session instead of trusting owner field", async () => {
  const { handler, calls } = harness({
    result: { timer: { revision: "0" }, summary: { day_key: "2026-10-20" } },
  });
  equal((await handler(call({ action: "refresh" }))).status, 200);
  equal(calls.find((c) => c.url.endsWith("/account_gateway"))!.body, {
    p_action: "refresh",
    p_owner: owner,
    p_data: { auth_session_id: session },
  });
  equal(
    (await handler(call({ action: "refresh", owner_id: owner }))).status,
    400,
  );
});
