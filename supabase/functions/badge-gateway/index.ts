import { createHandler } from "./handler.ts";
Deno.serve(createHandler({
  supabaseUrl: Deno.env.get("SUPABASE_URL") ?? "",
  serviceKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  hmacKey: Deno.env.get("BADGE_HMAC_KEY") ?? "",
  signingJwk: Deno.env.get("BADGE_SIGNING_JWK") ?? "",
  signingKid: Deno.env.get("BADGE_SIGNING_KID") ?? "",
  powersyncUrl: Deno.env.get("BADGE_POWERSYNC_URL") ?? "",
  powersyncAudience: Deno.env.get("BADGE_POWERSYNC_AUDIENCE") ?? "",
}));
