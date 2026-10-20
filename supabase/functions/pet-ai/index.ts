import { createHandler } from "./handler.ts";

Deno.serve(createHandler({
  supabaseUrl: Deno.env.get("SUPABASE_URL") ?? "",
  serviceKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  openaiKey: Deno.env.get("OPENAI_API_KEY"),
  model: Deno.env.get("OPENAI_MODEL") ?? "gpt-4.1-mini",
}));
