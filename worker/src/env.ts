export interface Env {
  ASSETS: Fetcher;

  // vars (wrangler.jsonc)
  GEMINI_MODEL: string;
  /** MINIMAL | LOW | MEDIUM | HIGH for Gemini 3+ models; empty = model default. Ignored by older models. */
  GEMINI_THINKING_LEVEL: string;
  DEFAULT_TIMEZONE: string;
  DEFAULT_CURRENCY: string;
  PUBLIC_URL: string;

  // secrets (Cloudflare dashboard → Settings → Variables and Secrets, or `wrangler secret put`)
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  GEMINI_API_KEY: string;
  SESSION_SECRET: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  /** Comma-separated Telegram user IDs allowed to use the bot. Unset = anyone (not recommended). */
  ALLOWED_TELEGRAM_IDS?: string;
}

export type AppContext = { Bindings: Env; Variables: { userId: number } };

export function allowedTelegramIds(env: Env): Set<number> {
  return new Set(
    (env.ALLOWED_TELEGRAM_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number),
  );
}

export function publicUrl(env: Env, requestUrl?: string): string {
  if (env.PUBLIC_URL) return env.PUBLIC_URL.replace(/\/+$/, "");
  return requestUrl ? new URL(requestUrl).origin : "";
}
