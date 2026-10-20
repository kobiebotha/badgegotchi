export interface PublicConfig {
  supabaseUrl: string;
  supabaseKey: string;
  powersyncUrl: string;
}

export const config: PublicConfig = {
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL?.trim() ?? "",
  supabaseKey:
    (
      import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
      import.meta.env.VITE_SUPABASE_ANON_KEY
    )?.trim() ?? "",
  powersyncUrl: import.meta.env.VITE_POWERSYNC_URL?.trim() ?? "",
};

export function validateConfig(value: PublicConfig): string | null {
  if (!value.supabaseUrl || !value.supabaseKey || !value.powersyncUrl) {
    return "Set VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (or VITE_SUPABASE_PUBLISHABLE_KEY), and VITE_POWERSYNC_URL.";
  }
  for (const raw of [value.supabaseUrl, value.powersyncUrl]) {
    try {
      const url = new URL(raw!);
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (
        url.username ||
        url.password ||
        (url.protocol !== "https:" && !(local && url.protocol === "http:"))
      ) {
        return "Service URLs must use HTTPS, except for local development.";
      }
    } catch {
      return "The Supabase or PowerSync URL is invalid.";
    }
  }
  if (value.supabaseKey.startsWith("sb_secret_")) {
    return "Use a Supabase publishable or anon key. Secret keys must never be included in the web app.";
  }
  // Legacy anon keys are supported, but service_role JWTs are never public keys.
  if (value.supabaseKey.startsWith("eyJ")) {
    try {
      const payload = value.supabaseKey
        .split(".")[1]
        .replace(/-/g, "+")
        .replace(/_/g, "/");
      const claims = JSON.parse(atob(payload));
      if (claims.role !== "anon") {
        return "Use a Supabase publishable or anon key. Privileged JWTs must never be included in the web app.";
      }
    } catch {
      return "The Supabase anon key is invalid.";
    }
  }
  return null;
}

export const configurationError = validateConfig(config);

export function requireConfig(): PublicConfig {
  if (configurationError) throw new Error(configurationError);
  return config;
}
