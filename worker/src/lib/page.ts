/** Minimal self-contained HTML page for server-rendered screens (login, setup). */
export function page(title: string, body: string): string {
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${title}</title>
<style>
  :root{color-scheme:light dark;--bg:#f8fafc;--card:#fff;--fg:#0f172a;--muted:#64748b;--accent:#059669;--bad:#dc2626;--line:#e2e8f0}
  @media (prefers-color-scheme:dark){:root{--bg:#020617;--card:#0f172a;--fg:#e2e8f0;--muted:#94a3b8;--accent:#10b981;--bad:#f87171;--line:#1e293b}}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:16px}
  .card{background:var(--card);border-radius:16px;padding:32px;max-width:440px;width:100%;box-shadow:0 10px 30px rgba(0,0,0,.08);text-align:center}
  h1{font-size:20px;margin:0 0 8px}p{color:var(--muted);margin:0 0 24px}
  button,a.btn{display:inline-block;width:100%;border:0;border-radius:10px;padding:12px 16px;background:var(--accent);color:#fff;font-weight:600;font-size:16px;cursor:pointer;text-decoration:none}
  input{width:100%;box-sizing:border-box;border:1px solid var(--line);background:transparent;color:var(--fg);border-radius:10px;padding:12px;font-size:16px;margin:0 0 12px}
  ul.checks{list-style:none;padding:0;margin:0 0 24px;text-align:left;border-top:1px solid var(--line)}
  ul.checks li{display:flex;gap:10px;padding:10px 2px;border-bottom:1px solid var(--line);font-size:15px}
  ul.checks .ok{color:var(--accent);font-weight:700}ul.checks .no{color:var(--bad);font-weight:700}
  ul.checks small{display:block;color:var(--muted)}
</style></head><body><div class="card">${body}</div></body></html>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
