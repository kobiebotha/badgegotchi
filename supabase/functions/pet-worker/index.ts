import { createHandler } from "../pet-ai/handler.ts";

// Dedicated worker authentication never changes the browser pet-ai route.
Deno.serve(createHandler(
  {
    supabaseUrl: Deno.env.get("SUPABASE_URL") ?? "",
    serviceKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    openaiKey: Deno.env.get("OPENAI_API_KEY"),
    model: Deno.env.get("OPENAI_MODEL") ?? "gpt-4.1-mini",
  },
  fetch,
  Deno.env.get("PET_WORKER_SECRET") ?? "",
));
