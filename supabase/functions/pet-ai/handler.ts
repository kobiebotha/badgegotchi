// No third-party runtime dependency; network boundaries are injected for tests.
export interface Config {
  supabaseUrl: string;
  serviceKey: string;
  openaiKey?: string;
  model?: string;
}
type Json = Record<string, unknown>;
type Fetch = typeof fetch;
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, apikey, content-type, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};
const animals = new Set([
  "hedgehog",
  "bear",
  "snake",
  "pig",
  "otter",
  "fox",
  "cheeta",
  "seal",
  "monkey",
  "rooster",
  "racoon",
  "cat",
  "sloth",
  "penguin",
  "hamster",
  "chameleon",
  "peacock",
  "owl",
  "hippo",
  "panda",
  "cow",
  "sheep",
  "octopus",
  "capybara",
  "rhino",
  "turtle",
  "rabbit",
  "dog",
  "duck",
  "parrot",
]);
const events: Record<string, string> = {
  start_focus_session: "The user started a focus session.",
  pause_focus_session: "The user paused their focus session.",
  resume_focus_session: "The user resumed their focus session.",
  complete_focus_session: "The user completed a focus session.",
  stop_focus_session_early: "The user stopped a focus session early.",
  start_break: "The user started a healthy break.",
  complete_break: "The user finished their break.",
  stop_break_early: "The user ended their break early.",
  pet_pet: "The user gave you a gentle pet.",
  drink_water: "The user drank some water.",
  move_or_stretch: "The user moved around or stretched.",
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function reply(body: Json, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { ...cors, ...(status === 503 ? { "retry-after": "10" } : {}) },
  });
}
function object(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Json
    : {};
}
function validId(value: unknown): value is string {
  return typeof value === "string" && uuid.test(value);
}
class UpstreamError extends Error {
  constructor(readonly retry: boolean) {
    super("Cloud inference is temporarily unavailable.");
  }
}

export function createHandler(config: Config, request: Fetch = fetch) {
  async function rpc(name: string, args: Json): Promise<Json> {
    const response = await request(
      `${config.supabaseUrl}/rest/v1/rpc/${name}`,
      {
        method: "POST",
        headers: {
          apikey: config.serviceKey,
          Authorization: `Bearer ${config.serviceKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) throw new Error("Database operation failed.");
    return object(await response.json());
  }
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return reply({ error: "Use POST." }, 405);
    const authorization = req.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) {
      return reply({ error: "Sign in first." }, 401);
    }
    try {
      if (!config.supabaseUrl || !config.serviceKey) {
        return reply({ error: "Backend configuration is incomplete." }, 503);
      }
      // Resolve the identity at Auth, never decode an unverified JWT or trust owner_id.
      const auth = await request(`${config.supabaseUrl}/auth/v1/user`, {
        headers: { Authorization: authorization, apikey: config.serviceKey },
        signal: AbortSignal.timeout(10_000),
      });
      if (!auth.ok) {
        return reply(
          { error: "Authentication unavailable." },
          auth.status >= 500 || auth.status === 429 ? 503 : 401,
        );
      }
      const user = object(await auth.json());
      if (!validId(user.id)) return reply({ error: "Invalid user." }, 401);
      if (Number(req.headers.get("content-length") ?? 0) > 4096) {
        return reply({ error: "Request too large." }, 413);
      }
      const raw = await req.text();
      if (raw.length > 4096) return reply({ error: "Request too large." }, 413);
      let body: Json;
      try {
        body = object(JSON.parse(raw));
      } catch {
        return reply({ error: "Invalid JSON." }, 400);
      }
      if (body.action === "ensure_pet" || body.action === "reset_pet") {
        if (
          typeof body.animal_id !== "string" || !animals.has(body.animal_id)
        ) {
          return reply({ error: "Unknown animal." }, 400);
        }
        // Species names are derived on the server. Caller text never becomes a prompt.
        const animalName = body.animal_id[0].toUpperCase() +
          body.animal_id.slice(1);
        if (body.animal_name !== animalName) {
          return reply(
            { error: "Animal name does not match its identifier." },
            400,
          );
        }
        if (body.action === "reset_pet" && !validId(body.request_id)) {
          return reply({
            error: "A stable request_id UUID is required for reset.",
          }, 400);
        }
        const pet = await rpc("pet_ai_ensure", {
          p_owner_id: user.id,
          p_animal_id: body.animal_id,
          p_animal_name: animalName,
          p_reset: body.action === "reset_pet",
          p_request_id: body.request_id ?? null,
        });
        return reply({ pet });
      }
      if (body.action !== "react") {
        return reply({ error: "Unknown action." }, 400);
      }
      const event = object(body.event);
      if (
        !validId(event.id) || !validId(event.pet_session_id) ||
        typeof event.event_type !== "string" ||
        !Object.hasOwn(events, event.event_type) ||
        !["macos", "ios", "badge", "web"].includes(
          String(event.source_device),
        ) ||
        typeof event.created_at !== "string" || event.created_at.length > 40 ||
        !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(event.created_at) ||
        !Number.isFinite(Date.parse(event.created_at))
      ) {
        return reply({ error: "Invalid pet event." }, 400);
      }
      const claim = await rpc("pet_ai_claim", {
        p_owner_id: user.id,
        p_id: event.id,
        p_pet_session_id: event.pet_session_id,
        p_event_type: event.event_type,
        p_source_device: event.source_device,
        p_created_at: event.created_at,
      });
      if (claim.state === "rejected") {
        return reply({
          status: "rejected",
          event_id: event.id,
          reason: claim.reason,
        });
      }
      if (claim.state === "completed" || claim.state === "failed") {
        return reply({ status: claim.state, event_id: event.id });
      }
      if (claim.state !== "claimed") {
        return reply({ error: "Retry later." }, 503);
      }
      const claimedEvent = object(claim.event);
      const finishArgs = {
        p_owner_id: user.id,
        p_id: event.id,
        p_lease_token: claimedEvent.lease_token,
      };
      let speech: string | null = null;
      let error: string | null = null;
      try {
        if (!config.openaiKey) throw new UpstreamError(true);
        const pet = object(claim.pet);
        const response = await request("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.openaiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: config.model || "gpt-4.1-mini",
            store: false,
            max_output_tokens: 100,
            instructions:
              `You are a kind, playful ${pet.animal_id} companion in a focus app. ` +
              "Reply to the event in exactly one short sentence, at most 16 words. " +
              "Be supportive about pauses, early stops, breaks, hydration and movement. " +
              "Plain English text only. No markdown, explanations, or narrated actions.",
            input: events[event.event_type],
          }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
          // Configuration, rate limit and infrastructure failures retain the outbox.
          if (
            [401, 403, 404, 408, 409, 429].includes(response.status) ||
            response.status >= 500
          ) {
            throw new UpstreamError(true);
          }
          throw new UpstreamError(false);
        }
        const result = object(await response.json());
        const output = Array.isArray(result.output) ? result.output : [];
        const parts = output.flatMap((item) => {
          const content = object(item).content;
          return Array.isArray(content) ? content : [];
        }).filter((part) => object(part).type === "output_text")
          .map((part) => object(part).text)
          .filter((part): part is string => typeof part === "string");
        speech = parts.join(" ").replace(/\s+/g, " ").trim();
        if (result.status !== "completed" || !speech || speech.length > 240) {
          throw new UpstreamError(false);
        }
      } catch (err) {
        if (!(err instanceof UpstreamError) || err.retry) {
          await rpc("pet_ai_finish", { ...finishArgs, p_retry: true });
          return reply({
            error: "Cloud inference unavailable; event retained for retry.",
          }, 503);
        }
        error = "Your pet could not think of a reply. Try another action.";
        speech = null;
      }
      const finished = await rpc("pet_ai_finish", {
        ...finishArgs,
        p_speech: speech,
        p_error: error,
      });
      if (finished.state !== "completed" && finished.state !== "failed") {
        return reply(
          { error: "Result could not be committed; retry later." },
          503,
        );
      }
      return reply({ status: finished.state, event_id: event.id });
    } catch {
      // Do not expose auth tokens, provider bodies, prompts or DB error details.
      return reply({ error: "Service unavailable; retry later." }, 503);
    }
  };
}
