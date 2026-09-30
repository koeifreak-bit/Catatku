#!/usr/bin/env node
// Mint a one-time dashboard login link without going through the bot
// (useful for local development, or if the bot is misconfigured).
//
// Usage:  npm run login-link -- <telegram_user_id>
// Reads SUPABASE_URL, SUPABASE_SECRET_KEY and PUBLIC_URL from the environment or .dev.vars.
// The user must already exist (message the bot once).

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const dev = {};
if (existsSync(".dev.vars")) {
  for (const line of readFileSync(".dev.vars", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (m) dev[m[1]] = m[2];
  }
}
const get = (k) => process.env[k] || dev[k] || "";
const supabaseUrl = get("SUPABASE_URL").replace(/\/+$/, "");
const key = get("SUPABASE_SECRET_KEY");
const publicUrl = (get("PUBLIC_URL") || "http://localhost:8787").replace(/\/+$/, "");
const telegramId = process.argv[2];

if (!supabaseUrl || !key || !telegramId) {
  console.error("Usage: npm run login-link -- <telegram_user_id>   (needs SUPABASE_URL and SUPABASE_SECRET_KEY)");
  process.exit(1);
}

const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

const users = await fetch(`${supabaseUrl}/rest/v1/users?telegram_id=eq.${encodeURIComponent(telegramId)}&select=id`, { headers }).then(
  (r) => r.json(),
);
if (!Array.isArray(users) || !users[0]) {
  console.error("User not found. Send any message to the bot first.", users);
  process.exit(1);
}

const token = randomBytes(32).toString("base64url");
const res = await fetch(`${supabaseUrl}/rest/v1/login_tokens`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    token_hash: createHash("sha256").update(token).digest("hex"),
    user_id: users[0].id,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  }),
});
if (!res.ok) {
  console.error("Failed to create token:", await res.text());
  process.exit(1);
}
console.log(`${publicUrl}/auth/login?token=${token}`);
console.log("(valid for 10 minutes, single use)");
