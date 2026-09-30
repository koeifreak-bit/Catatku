import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type { AppContext } from "../env";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, consumeLoginToken, createSessionJwt } from "../lib/auth";
import { getDb } from "../lib/db";
import { page } from "../lib/page";

export const auth = new Hono<AppContext>();

/**
 * Step 1: the link from the bot lands here. We deliberately do NOT consume the token on GET,
 * because Telegram/messenger link-preview crawlers would burn it. The user confirms with a POST.
 */
auth.get("/login", (c) => {
  const token = c.req.query("token") ?? "";
  if (!token) {
    return c.html(page("Catatku", `<h1>Link tidak valid</h1><p>Kirim /dashboard ke bot Catatku di Telegram untuk mendapatkan link masuk baru.</p>`), 400);
  }
  const safe = token.replace(/[^A-Za-z0-9_-]/g, "");
  return c.html(
    page(
      "Masuk ke Catatku",
      `<h1>📊 Masuk ke Dashboard</h1><p>Lanjutkan untuk membuka dashboard keuanganmu.</p>
       <form method="post" action="/auth/login"><input type="hidden" name="token" value="${safe}"><button type="submit">Masuk</button></form>`,
    ),
  );
});

/** Step 2: consume the one-time token and start a 30-day session. */
auth.post("/login", async (c) => {
  // Login CSRF guard: only accept the form from our own confirmation page, so another site can't
  // silently log the visitor into someone else's account.
  const origin = c.req.header("Origin");
  if (origin && origin !== new URL(c.req.url).origin) {
    return c.html(page("Catatku", `<h1>Link tidak valid</h1><p>Buka link dari bot Telegram-mu secara langsung.</p>`), 403);
  }
  const form = await c.req.parseBody();
  const token = typeof form.token === "string" ? form.token : "";
  const userId = await consumeLoginToken(getDb(c.env), token);
  if (!userId) {
    return c.html(
      page("Link kedaluwarsa", `<h1>⌛ Link sudah dipakai atau kedaluwarsa</h1><p>Kirim /dashboard ke bot Catatku di Telegram untuk mendapatkan link baru.</p>`),
      401,
    );
  }
  const secure = new URL(c.req.url).protocol === "https:";
  setCookie(c, SESSION_COOKIE, await createSessionJwt(c.env, userId), {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return c.redirect("/", 303);
});

auth.post("/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.body(null, 204);
});
