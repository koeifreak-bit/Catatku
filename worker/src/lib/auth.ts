import { sign, verify } from "hono/jwt";
import type { Env } from "../env";
import { type DB, must } from "./db";

export const SESSION_COOKIE = "catatku_session";
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const LOGIN_TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(bytes = 32): string {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/** Issue a one-time login token for the dashboard. Only its hash is stored. */
export async function createLoginToken(db: DB, userId: number): Promise<string> {
  const token = randomToken();
  must(
    await db.from("login_tokens").insert({
      token_hash: await sha256(token),
      user_id: userId,
      expires_at: new Date(Date.now() + LOGIN_TOKEN_TTL_MS).toISOString(),
    }),
    "create login token",
  );
  // Opportunistic cleanup of old tokens.
  await db.from("login_tokens").delete().lt("expires_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  return token;
}

/** Atomically consume a login token; returns the user id or null if invalid/expired/used. */
export async function consumeLoginToken(db: DB, token: string): Promise<number | null> {
  if (!token || token.length > 128) return null;
  const rows = must(
    await db
      .from("login_tokens")
      .update({ used_at: new Date().toISOString() })
      .eq("token_hash", await sha256(token))
      .is("used_at", null)
      .gt("expires_at", new Date().toISOString())
      .select("user_id"),
    "consume login token",
  ) as { user_id: number }[];
  return rows[0]?.user_id ?? null;
}

export async function createSessionJwt(env: Env, userId: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign({ sub: String(userId), iat: now, exp: now + SESSION_TTL_SECONDS }, env.SESSION_SECRET, "HS256");
}

export async function verifySessionJwt(env: Env, token: string | undefined): Promise<number | null> {
  if (!token || !env.SESSION_SECRET) return null;
  try {
    const payload = await verify(token, env.SESSION_SECRET, "HS256");
    const id = Number(payload.sub);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}
