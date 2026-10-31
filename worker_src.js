// Guest House dashboard - Cloudflare Worker (gh.zuna.ai; ltmgh.zuna.ai forwards to it once PRIMARY_HOST is set)
// Bindings: D1 database as "DB" (tables: datasets, users, sessions, resets — resets is created automatically).
// Password reset e-mail: secret RESEND_API_KEY (resend.com, zuna.ai domain verified); optional var MAIL_FROM.
// Sign-in at https://gh.zuna.ai/  ·  Log out at /logout
// Optional var PRIMARY_HOST (e.g. gh.zuna.ai): any other *.zuna.ai host this Worker answers on 301-redirects there.
const LEGACY_PATH = "/OLgWovxDMAlubYcItxLPOJgu";
const COOKIE = "ltmgh_s";
const ITER = 10000; // kept low for the Workers CPU limit; accounts lock after 5 wrong tries
const MAX_FAILS = 5, LOCK_MIN = 15;
const RESET_MIN = 15, RESET_TRIES = 5, RESET_GAP_S = 60;

const SEC = {
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "strict-transport-security": "max-age=31536000",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "cross-origin-opener-policy": "same-origin"
};
// Pages only: scripts/styles are inline by design; the only external file is the chart library.
const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const html = (body, extra = {}) => new Response(body, {headers: {"content-type": "text/html; charset=utf-8", "content-security-policy": CSP, ...SEC, ...extra}});
const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), {status, headers: {"content-type": "application/json", ...SEC, ...extra}});
const redirect = (to, extra = {}) => new Response(null, {status: 302, headers: {location: to, ...SEC, ...extra}});

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
async function pbkdf2(password, saltHex) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({name: "PBKDF2", hash: "SHA-256", salt: unhex(saltHex), iterations: ITER}, key, 256));
}
const safeEq = (a, b) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };
const getCookie = (req, name) => { const m = (req.headers.get("cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)")); return m ? m[1] : null; };

async function currentUser(req, env) {
  const tok = getCookie(req, COOKIE);
  if (!tok || !/^[a-f0-9]{64}$/.test(tok)) return null;
  const row = await env.DB.prepare("SELECT s.email, s.expires, u.name, u.active FROM sessions s JOIN users u ON u.email = s.email WHERE s.token_hash = ?").bind(await sha256(tok)).first();
  if (!row || !row.active || row.expires < new Date().toISOString()) return null;
  return {email: row.email, name: row.name};
}

async function login(req, env) {
  let body; try { body = await req.json(); } catch (e) { return json({error: "Bad request."}, 400); }
  const email = String(body.email || "").trim().toLowerCase().slice(0, 200);
  const password = String(body.password || "").slice(0, 200);
  const remember = !!body.remember;
  if (!email || !password) return json({error: "Enter your email or user ID and password."}, 400);
  const now = new Date();
  const u = await env.DB.prepare("SELECT email, name, salt, hash, active, failed, locked_until FROM users WHERE email = ?").bind(email).first();
  if (u && u.locked_until && u.locked_until > now.toISOString()) return json({error: "Too many attempts. Please try again in " + LOCK_MIN + " minutes."}, 429);
  const ok = u && u.active && safeEq(await pbkdf2(password, u.salt), u.hash);
  if (!u) { await pbkdf2(password, "00000000000000000000000000000000"); return json({error: "Incorrect email or password."}, 401); }
  if (!ok) {
    const fails = (u.failed || 0) + 1;
    const lock = fails >= MAX_FAILS ? new Date(now.getTime() + LOCK_MIN * 60000).toISOString() : null;
    await env.DB.prepare("UPDATE users SET failed = ?, locked_until = ? WHERE email = ?").bind(lock ? 0 : fails, lock, email).run();
    return json({error: lock ? "Too many attempts. Please try again in " + LOCK_MIN + " minutes." : (u.active ? "Incorrect email or password." : "This account is disabled. Please contact the Zuna Hotel Desk.")}, lock ? 429 : 401);
  }
  const tok = hex(crypto.getRandomValues(new Uint8Array(32)));
  const ttl = remember ? 30 * 86400 : 12 * 3600;
  const exp = new Date(now.getTime() + ttl * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sessions (token_hash, email, expires, created) VALUES (?, ?, ?, ?)").bind(await sha256(tok), email, exp, now.toISOString()),
    env.DB.prepare("UPDATE users SET failed = 0, locked_until = NULL, last_login = ? WHERE email = ?").bind(now.toISOString(), email),
    env.DB.prepare("DELETE FROM sessions WHERE expires < ?").bind(now.toISOString())
  ]);
  const cookie = COOKIE + "=" + tok + "; Path=/; HttpOnly; Secure; SameSite=Lax" + (remember ? "; Max-Age=" + ttl : "");
  return json({ok: true, name: u.name || ""}, 200, {"set-cookie": cookie});
}

// ---------- password reset (6-digit e-mail code) ----------
const RESET_OFF = "Password reset is not available right now. Please contact the Zuna Hotel Desk.";
const ensureResets = (env) => env.DB.prepare("CREATE TABLE IF NOT EXISTS resets (email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires TEXT NOT NULL, tries INTEGER DEFAULT 0, created TEXT NOT NULL)").run();
const sixDigits = () => { const a = new Uint32Array(1); let v; do { crypto.getRandomValues(a); v = a[0]; } while (v >= 4294000000); return String(v % 1000000).padStart(6, "0"); };
const pwProblem = (pw, email) => {
  if (pw.length < 10) return "Use at least 10 characters.";
  if (pw.length > 128) return "Use at most 128 characters.";
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return "Use both letters and numbers.";
  if (pw.toLowerCase() === email || pw.toLowerCase().includes(email.split("@")[0]) && email.split("@")[0].length > 3) return "Don't use your email or user ID in the password.";
  return null;
};
function resetMail(name, code) {
  const hi = name ? "Hello " + name.replace(/[<>&"]/g, "") + "," : "Hello,";
  const text = hi + "\n\nUse this code to set a new password for the Zuna guest house portal:\n\n" + code + "\n\nThe code expires in " + RESET_MIN + " minutes. If you did not ask for this, you can ignore this email; your password will not change.\n\nZuna Hotel Desk";
  const html = '<!doctype html><html><body style="margin:0;background:#f4f2fb;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#12005A">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f2fb;padding:32px 12px"><tr><td align="center">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;overflow:hidden">'
    + '<tr><td style="background:#12005A;padding:22px 28px;color:#ffffff;font-size:20px;font-weight:700">zuna <span style="color:#02C988;font-size:13px;font-weight:600">Guest House Management</span></td></tr>'
    + '<tr><td style="padding:28px">'
    + '<p style="margin:0 0 12px;font-size:15px">' + hi + '</p>'
    + '<p style="margin:0 0 20px;font-size:14px;line-height:1.5;color:#5d5887">Use this code to set a new password for the Zuna guest house portal.</p>'
    + '<div style="text-align:center;margin:0 0 20px"><span style="display:inline-block;padding:14px 24px;border-radius:12px;background:#e6faf3;border:1px solid #8de7c7;font-size:30px;font-weight:700;letter-spacing:8px;color:#12005A">' + code + '</span></div>'
    + '<p style="margin:0 0 8px;font-size:13px;color:#5d5887">The code expires in ' + RESET_MIN + ' minutes.</p>'
    + '<p style="margin:0;font-size:13px;color:#5d5887">If you did not ask for this, you can ignore this email; your password will not change.</p>'
    + '</td></tr><tr><td style="padding:16px 28px;border-top:1px solid #e6e2f6;font-size:12px;color:#7d68c6">Zuna Hotel Desk · Zuna Travel Solutions</td></tr></table></td></tr></table></body></html>';
  return {text, html};
}
async function sendMail(env, to, subject, body) {
  const r = await fetch("https://api.resend.com/emails", {method: "POST", headers: {authorization: "Bearer " + env.RESEND_API_KEY, "content-type": "application/json"},
    body: JSON.stringify({from: env.MAIL_FROM || "Zuna Hotel Desk <noreply@zuna.ai>", to: [to], subject, html: body.html, text: body.text})});
  return r.ok;
}
async function forgot(req, env) {
  let body; try { body = await req.json(); } catch (e) { return json({error: "Bad request."}, 400); }
  const email = String(body.email || "").trim().toLowerCase().slice(0, 200);
  if (!email) return json({error: "Enter your email address."}, 400);
  if (!env.RESEND_API_KEY) return json({error: RESET_OFF}, 503);
  await ensureResets(env);
  const done = json({ok: true});                       // same answer whether or not the account exists
  const u = await env.DB.prepare("SELECT email, name, active FROM users WHERE email = ?").bind(email).first();
  if (!u || !u.active || !email.includes("@")) return done;
  const now = new Date();
  const prev = await env.DB.prepare("SELECT created FROM resets WHERE email = ?").bind(email).first();
  if (prev && now - new Date(prev.created) < RESET_GAP_S * 1000) return done;
  const code = sixDigits();
  await env.DB.prepare("INSERT INTO resets (email, code_hash, expires, tries, created) VALUES (?, ?, ?, 0, ?) ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires = excluded.expires, tries = 0, created = excluded.created")
    .bind(email, await sha256(email + ":" + code), new Date(now.getTime() + RESET_MIN * 60000).toISOString(), now.toISOString()).run();
  if (!(await sendMail(env, email, "Your Zuna password reset code: " + code, resetMail(u.name, code)))) return json({error: "We couldn't send the email just now. Please try again in a minute."}, 502);
  return done;
}
async function resetPassword(req, env) {
  let body; try { body = await req.json(); } catch (e) { return json({error: "Bad request."}, 400); }
  const email = String(body.email || "").trim().toLowerCase().slice(0, 200);
  const code = String(body.code || "").replace(/\D/g, "").slice(0, 6);
  const pw = String(body.password || "");
  if (!email || code.length !== 6) return json({error: "Enter the 6-digit code from the email."}, 400);
  const bad = pwProblem(pw, email); if (bad) return json({error: bad, field: "password"}, 400);
  if (!env.RESEND_API_KEY) return json({error: RESET_OFF}, 503);
  await ensureResets(env);
  const now = new Date();
  const r = await env.DB.prepare("SELECT code_hash, expires, tries FROM resets WHERE email = ?").bind(email).first();
  if (!r || r.expires < now.toISOString()) return json({error: "This code has expired. Request a new code."}, 400);
  if (!safeEq(await sha256(email + ":" + code), r.code_hash)) {
    const tries = (r.tries || 0) + 1;
    if (tries >= RESET_TRIES) { await env.DB.prepare("DELETE FROM resets WHERE email = ?").bind(email).run(); return json({error: "Too many incorrect codes. Request a new code."}, 400); }
    await env.DB.prepare("UPDATE resets SET tries = ? WHERE email = ?").bind(tries, email).run();
    return json({error: "Incorrect code. " + (RESET_TRIES - tries) + " attempt" + (RESET_TRIES - tries === 1 ? "" : "s") + " left."}, 400);
  }
  const u = await env.DB.prepare("SELECT active FROM users WHERE email = ?").bind(email).first();
  if (!u || !u.active) return json({error: "This account is disabled. Please contact the Zuna Hotel Desk."}, 403);
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET salt = ?, hash = ?, failed = 0, locked_until = NULL WHERE email = ?").bind(salt, await pbkdf2(pw, salt), email),
    env.DB.prepare("DELETE FROM sessions WHERE email = ?").bind(email),      // sign out everywhere else
    env.DB.prepare("DELETE FROM resets WHERE email = ?").bind(email)
  ]);
  return json({ok: true});
}

async function dashboard(env, user) {
  const {results} = await env.DB.prepare("SELECT id, json, updated_at FROM datasets").all();
  const data = {}; let updated = "";
  for (const r of results) { data[r.id] = JSON.parse(r.json); if (r.id === "bookings") updated = r.updated_at; }
  const payload = JSON.stringify(data).replace(/</g, "\\u003c");
  const userJs = JSON.stringify({name: user.name || "", email: user.email}).replace(/</g, "\\u003c");
  let page = TEMPLATE.replace("__DATA__", () => payload).replace("__USER__", () => userJs);
  if (updated) page = page.replace(/REPORT_DATE = '\d{4}-\d{2}-\d{2}'/, "REPORT_DATE = '" + updated.slice(0, 10) + "'");
  return html(page);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (env.PRIMARY_HOST && url.hostname !== env.PRIMARY_HOST && url.hostname.endsWith("zuna.ai") && (request.method === "GET" || request.method === "HEAD"))
      return new Response(null, {status: 301, headers: {location: "https://" + env.PRIMARY_HOST + url.pathname + url.search, ...SEC}});
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const API = {"/api/login": login, "/api/forgot": forgot, "/api/reset": resetPassword};
    if (API[path] && request.method === "POST") {
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) return json({error: "Bad origin."}, 403);
      if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) return json({error: "Bad request."}, 415);
      return API[path](request, env);
    }
    if (path === "/logout") {
      const tok = getCookie(request, COOKIE);
      if (tok && /^[a-f0-9]{64}$/.test(tok)) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(tok)).run();
      return redirect("/", {"set-cookie": COOKIE + "=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"});
    }
    if (path === LEGACY_PATH || path === "/login") return redirect("/");
    if (path !== "/") return redirect("/");
    const user = await currentUser(request, env);
    if (!user) return html(LOGIN);
    return dashboard(env, user);
  }
};

const LOGIN = "";
const TEMPLATE = "";
