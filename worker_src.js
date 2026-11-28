// Guest House dashboard - Cloudflare Worker (gh.zuna.ai; ltmgh.zuna.ai forwards to it once PRIMARY_HOST is set)
// Bindings: D1 database as "DB" (tables: datasets, users, sessions, resets — resets is created automatically).
// Password reset e-mail: secret RESEND_API_KEY (resend.com, zuna.ai domain verified); optional var MAIL_FROM.
// Sign-in at https://gh.zuna.ai/  ·  Log out at /logout
// Secret VOUCHER_TOKEN enables POST /api/vouchers (voucher PDFs from the mail job → D1 table vouchers).
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
const ADMIN_CSP = CSP.replace("connect-src 'self'", "connect-src 'self' https://photon.komoot.io");
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
  await ensureSchema(env);
  const row = await env.DB.prepare("SELECT s.email, s.expires, u.name, u.active, u.role, u.client_id, u.tx_access, u.book_access FROM sessions s JOIN users u ON u.email = s.email WHERE s.token_hash = ?").bind(await sha256(tok)).first();
  if (!row || !row.active || row.expires < new Date().toISOString()) return null;
  const admin = row.role === "admin", manager = row.role === "client_admin" && !!row.client_id;
  // hotel bookings: Zuna admins and client admins always; other users when an admin switches it on
  return {email: row.email, name: row.name, role: row.role || "client", client_id: row.client_id, admin, manager, tx: admin || manager || !!row.tx_access, book: admin || !!row.book_access};   // booking rooms: Zuna admins always; others when switched on
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

// ---------- PDF text extraction (no dependencies; FlateDecode streams, object streams, ToUnicode CMaps) ----------
const latin1 = (u8) => { let out = ""; for (let i = 0; i < u8.length; i += 0x8000) out += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return out; };
async function inflate(u8) {
  for (const fmt of ["deflate", "deflate-raw"]) {
    try {
      const ds = new DecompressionStream(fmt), w = ds.writable.getWriter();
      w.write(u8).catch(() => {}); w.close().catch(() => {});
      return new Uint8Array(await new Response(ds.readable).arrayBuffer());
    } catch (e) { /* try next format */ }
  }
  return null;
}
function a85(u8) {
  let t = latin1(u8).replace(/\s+/g, ""); const e = t.indexOf("~>"); if (e >= 0) t = t.slice(0, e); t = t.replace(/^<~/, "");
  const out = [];
  for (let i = 0; i < t.length;) {
    if (t[i] === "z") { out.push(0, 0, 0, 0); i++; continue; }
    const chunk = t.slice(i, i + 5); i += 5; const pad = 5 - chunk.length; let v = 0;
    for (const ch of chunk + "u".repeat(pad)) v = v * 85 + (ch.charCodeAt(0) - 33);
    out.push(...[(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].slice(0, 4 - pad));
  }
  return new Uint8Array(out);
}
function ahx(u8) { let h = latin1(u8).replace(/[^0-9a-fA-F>]/g, ""); h = h.split(">")[0]; if (h.length % 2) h += "0";
  const out = new Uint8Array(h.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16); return out; }
async function unfilter(dict, raw) {
  const fm = dict.match(/\/Filter\s*(\[[^\]]*\]|\/\w+)/); if (!fm) return raw;
  let d = raw;
  for (const [, f] of fm[1].matchAll(/\/(\w+)/g)) {
    if (f === "FlateDecode" || f === "Fl") d = await inflate(d);
    else if (f === "ASCII85Decode" || f === "A85") d = a85(d);
    else if (f === "ASCIIHexDecode" || f === "AHx") d = ahx(d);
    else return null;                                    // images (DCT, CCITT...) are not text
    if (!d) return null;
  }
  return d;
}
function parseCMap(t) {
  const map = new Map(); let bytes = 1;
  const cs = t.match(/begincodespacerange\s*<([0-9a-fA-F]+)>/); if (cs) bytes = Math.max(1, cs[1].length >> 1);
  const u16 = (h) => { let r = ""; for (let i = 0; i + 3 < h.length; i += 4) r += String.fromCharCode(parseInt(h.slice(i, i + 4), 16)); if (h.length === 2) r = String.fromCharCode(parseInt(h, 16)); return r; };
  for (const blk of t.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(parseInt(m[1], 16), u16(m[2]));
  for (const blk of t.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
    for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
      if (m[3][0] === "[") { [...m[3].matchAll(/<([0-9a-fA-F]*)>/g)].forEach((d, i) => map.set(lo + i, u16(d[1]))); }
      else { const h = m[3].slice(1, -1), base = parseInt(h.slice(-4) || "0", 16), pre = u16(h.slice(0, -4));
        for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(c, pre + String.fromCharCode(base + c - lo)); }
    }
  return {map, bytes};
}
async function pdfText(u8) {
  const s = latin1(u8), objs = new Map(), re = /(\d+)\s+\d+\s+obj\b/g;
  let m, pos = 0;
  while ((m = re.exec(s))) {
    if (m.index < pos) continue;
    const bs = re.lastIndex, eo = s.indexOf("endobj", bs); if (eo < 0) break;
    const st = s.indexOf("stream", bs); let dict = s.slice(bs, eo), raw = null, end = eo;
    if (st >= 0 && st < eo && s.slice(st - 3, st) !== "end") {
      dict = s.slice(bs, st); let ds = st + 6; if (s[ds] === "\r") ds++; if (s[ds] === "\n") ds++;
      const lm = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/), es = s.indexOf("endstream", ds);
      let de = lm && ds + +lm[1] <= s.length ? ds + +lm[1] : (es < 0 ? ds : es);
      while (!lm && de > ds && (s[de - 1] === "\n" || s[de - 1] === "\r")) de--;
      raw = u8.subarray(ds, de); end = Math.max(s.indexOf("endobj", de), de);
    }
    objs.set(+m[1], {dict, raw}); pos = end; re.lastIndex = end;
  }
  const data = async (o) => { if (!o || !o.raw) return null; if (o.data === undefined) o.data = await unfilter(o.dict, o.raw); return o.data; };
  for (const [, o] of [...objs]) if (/\/Type\s*\/ObjStm/.test(o.dict)) {          // compressed object streams
    const d = await data(o); if (!d) continue; const t = latin1(d), n = +(o.dict.match(/\/N\s+(\d+)/) || [])[1], first = +(o.dict.match(/\/First\s+(\d+)/) || [])[1];
    const nums = t.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) { const a = first + nums[2 * i + 1], b = i + 1 < n ? first + nums[2 * i + 3] : t.length; if (!objs.has(nums[2 * i])) objs.set(nums[2 * i], {dict: t.slice(a, b), raw: null}); }
  }
  const ref = (txt, key) => { const r = txt.match(new RegExp("/" + key + "\\s+(\\d+)\\s+\\d+\\s+R")); return r ? objs.get(+r[1]) : null; };
  const fontsOf = (resTxt) => { const out = {}; let fd = resTxt.match(/\/Font\s*<<([\s\S]*?)>>/);
    let body = fd ? fd[1] : ((ref(resTxt, "Font") || {}).dict || "");
    for (const f of body.matchAll(/\/([^\s/<>\[\]()]+)\s+(\d+)\s+\d+\s+R/g)) out[f[1]] = +f[2]; return out; };
  const cmaps = new Map();
  const cmapFor = async (num) => { if (cmaps.has(num)) return cmaps.get(num); const fo = objs.get(num); let cm = null;
    if (fo) { const tu = ref(fo.dict, "ToUnicode"); const d = tu && await data(tu); if (d) cm = parseCMap(latin1(d)); else if (/Identity-H/.test(fo.dict)) cm = {map: new Map(), bytes: 2}; }
    cmaps.set(num, cm); return cm; };
  const decodeStr = (bytes, cm) => { if (!cm) return String.fromCharCode(...bytes); let out = "";
    for (let i = 0; i + cm.bytes <= bytes.length; i += cm.bytes) { let c = 0; for (let k = 0; k < cm.bytes; k++) c = c * 256 + bytes[i + k]; out += cm.map.has(c) ? cm.map.get(c) : (cm.bytes === 1 ? String.fromCharCode(c) : ""); }
    return out; };
  // pages: content stream(s) + font map from the page (or inherited) resources
  const pages = [];
  for (const [, o] of objs) if (/\/Type\s*\/Page(?![s\w])/.test(o.dict)) {
    let resTxt = ""; const inl = o.dict.match(/\/Resources\s*<</); if (inl) resTxt = o.dict.slice(inl.index); else { const r = ref(o.dict, "Resources"); if (r) resTxt = r.dict; }
    if (!resTxt) { let par = ref(o.dict, "Parent"); for (let k = 0; par && k < 10 && !resTxt; k++) { const r = ref(par.dict, "Resources"); resTxt = r ? r.dict : ((par.dict.match(/\/Resources\s*<<[\s\S]*/) || [""])[0]); par = ref(par.dict, "Parent"); } }
    const cont = o.dict.match(/\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/); const ids = cont ? [...cont[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((x) => +x[1]) : [];
    pages.push({fonts: fontsOf(resTxt), ids});
  }
  const lines = [];
  for (const pg of pages) {
    let content = ""; for (const id of pg.ids) { const d = await data(objs.get(id)); if (d) content += latin1(d) + "\n"; }
    let out = "", font = null, cm = null, lastY = null; const stack = [];
    const emit = (b) => { out += decodeStr(b, cm); };
    const nl = () => { if (out && !out.endsWith("\n")) out += "\n"; };
    for (let i = 0; i < content.length;) {
      const ch = content[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (ch === "%") { while (i < content.length && content[i] !== "\n" && content[i] !== "\r") i++; continue; }
      if (ch === "(") { const b = []; let depth = 1; i++;
        while (i < content.length && depth) { let c = content[i++];
          if (c === "\\") { const n = content[i++]; const esc = {n: 10, r: 13, t: 9, b: 8, f: 12}[n];
            if (esc !== undefined) b.push(esc); else if (/[0-7]/.test(n)) { let o = n; while (o.length < 3 && /[0-7]/.test(content[i])) o += content[i++]; b.push(parseInt(o, 8) & 255); }
            else if (n === "\r" || n === "\n") { if (n === "\r" && content[i] === "\n") i++; } else b.push(n.charCodeAt(0)); continue; }
          if (c === "(") depth++; else if (c === ")" && !--depth) break; b.push(c.charCodeAt(0)); }
        stack.push({s: b}); continue; }
      if (ch === "<" && content[i + 1] !== "<") { const e = content.indexOf(">", i); let h = content.slice(i + 1, e).replace(/\s+/g, ""); if (h.length % 2) h += "0";
        const b = []; for (let k = 0; k < h.length; k += 2) b.push(parseInt(h.slice(k, k + 2), 16)); stack.push({s: b}); i = e + 1; continue; }
      if (ch === "[") { stack.push("["); i++; continue; }
      if (ch === "]") { const arr = []; while (stack.length && stack[stack.length - 1] !== "[") arr.unshift(stack.pop()); stack.pop(); stack.push({a: arr}); i++; continue; }
      if (ch === "<" || ch === ">") { i += 2; continue; }
      let j = i + 1; while (j < content.length && !/[\s()<>\[\]{}\/%]/.test(content[j])) j++;
      const tok = content.slice(i, j); i = j;
      if (ch === "/") { stack.push({n: tok.slice(1)}); continue; }
      if (/^[+\-.\d]/.test(tok)) { stack.push(+tok); continue; }
      const nums = stack.filter((x) => typeof x === "number");
      switch (tok) {
        case "Tf": { const nm = stack.filter((x) => x && x.n).pop(); font = nm ? nm.n : null; cm = font && pg.fonts[font] ? await cmapFor(pg.fonts[font]) : null; break; }
        case "Tj": { const t = stack.filter((x) => x && x.s).pop(); if (t) emit(t.s); break; }
        case "'": case '"': { nl(); const t = stack.filter((x) => x && x.s).pop(); if (t) emit(t.s); break; }
        case "TJ": { const a = stack.filter((x) => x && x.a).pop(); if (a) for (const el of a.a) { if (el && el.s) emit(el.s); else if (typeof el === "number" && el < -180 && !out.endsWith(" ")) out += " "; } break; }
        case "Td": case "TD": { const ty = nums[nums.length - 1] || 0; if (Math.abs(ty) > 0.5) nl(); break; }   // same-line moves are glyph positioning, not gaps
        case "T*": nl(); break;
        case "Tm": { const y = nums[nums.length - 1]; if (lastY !== null && Math.abs(y - lastY) > 0.5) nl(); else if (lastY !== null && !out.endsWith(" ") && !out.endsWith("\n")) out += " "; lastY = y; break; }
        case "BT": break;
        case "ET": out += " "; break;
        case "BI": { const e = content.indexOf("EI", i); i = e < 0 ? content.length : e + 2; break; }
      }
      stack.length = 0;
    }
    lines.push(out);
  }
  return lines.join("\n").replace(/[ \t ]+/g, " ").split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
}

// ---------- apply a voucher to the bookings dataset straight away (same safeguards as the data feed) ----------
const MON3 = {jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12"};
const normName = (n) => String(n || "").toLowerCase().replace(/\.pdf$/, "").replace(/[^a-z\s]/g, " ").replace(/^\s*(mr|ms|mrs|miss|dr)\b/, " ").replace(/\s+/g, "");   // PDFs sometimes split words ("Chaturved i")
const titleOf = (n) => { const m = String(n || "").match(/^\s*(mr|ms|mrs|miss)\b/i); return m ? (m[1].toLowerCase() === "mr" ? "M" : "F") : ""; };
function vDate(text, label) {
  const m = String(text).match(new RegExp("(?:" + label + ")\\s*[:\\-–]?\\s*([0-9 ]{1,3})\\s*[-/ ]\\s*([A-Za-z]{3})[a-z]*\\s*[-/ ]\\s*([0-9 ]{4,6})", "i"));
  if (!m) return "";
  const d = m[1].replace(/\s/g, "").padStart(2, "0"), mo = MON3[m[2].toLowerCase()], y = m[3].replace(/\s/g, "");
  return mo && /^\d{4}$/.test(y) ? y + "-" + mo + "-" + d : "";
}
const roomList = (p) => { const m = String(p.room_nos || "").trim().match(/^(\S*?)(\d+)\s+to\s+\S*?(\d+)$/); const out = [];
  if (m && +m[3] - +m[2] < 50) for (let i = +m[2]; i <= +m[3]; i++) out.push(m[1] + i); return out; };
async function applyVoucher(env, text, file) {
  const vName = (String(text).match(/Guest\s*Name\s*[:\-–]?\s*\n?\s*([^\n]+)/i) || [])[1] || file;
  const vRoom = (String(text).match(/Room\s*No\.?\s*[:\-–]?\s*(\d{1,4})\b/i) || [])[1];
  const arr = vDate(text, "Arrival\\s*Date|Check[\\s-]*in(?:\\s*Date)?"), dep = vDate(text, "Departure\\s*Date|Check[\\s-]*out(?:\\s*Date)?");
  if (!vRoom || !arr) return "no room number or arrival date found";
  const ds = await env.DB.prepare("SELECT json FROM datasets WHERE id = 'bookings'").first(), ps = await env.DB.prepare("SELECT json FROM datasets WHERE id = 'properties'").first();
  if (!ds || !ps) return "no bookings data";
  const bookings = JSON.parse(ds.json), props = JSON.parse(ps.json), key = normName(vName);
  let cands = bookings.filter((b) => b.status === "Confirmed" && normName(b.guest) === key && b.check_in === arr);
  if (!cands.length) cands = bookings.filter((b) => b.status === "Confirmed" && normName(b.guest) === key && b.check_in < (dep || arr) && arr < b.check_out);
  if (cands.length !== 1) return cands.length ? "several bookings match " + vName : "no booking found for " + vName + " arriving " + arr;
  const b = cands[0];
  if (/^\d/.test(b.room || "")) return "room already set (" + b.room + ")";
  let rooms = roomList(props.find((p) => p.property === b.property) || {});
  if (await multiClient(env)) { const {results: rts} = await env.DB.prepare("SELECT r.room_nos FROM room_types r JOIN guesthouses g ON g.id = r.gh_id WHERE g.name = ? ORDER BY r.sort").bind(b.property).all();
    if (rts.length) rooms = rts.flatMap((r) => expandRooms(r.room_nos)); }
  const digits = (r) => r.replace(/\D/g, "");
  let hits = rooms.filter((r) => r === vRoom || digits(r).endsWith(vRoom.padStart(2, "0")));
  if (hits.length !== 1) hits = rooms.filter((r) => digits(r).endsWith(String(+vRoom)));
  const room = hits.length === 1 ? hits[0] : "";
  if (!room) return "room " + vRoom + " does not match " + b.property + " room numbers";
  const vt = titleOf(vName.replace(/\s+\./, ".")), bt = titleOf(b.guest);
  if (vt && bt && vt !== bt) return "conflict: voucher title differs from booking (" + vName.trim() + " vs " + b.guest + ")";
  const mates = bookings.filter((o) => o !== b && o.status === "Confirmed" && o.property === b.property && o.room === room && o.check_in < b.check_out && b.check_in < o.check_out);
  const single = (x) => !/^d|twin|shar/i.test(String(x.occupancy || "").trim());
  if (mates.length >= 2) return "conflict: room " + room + " would hold 3+ guests";
  if (mates.length === 1 && (single(b) || single(mates[0]))) return "conflict: " + room + " already has " + mates[0].guest + " (single occupancy)";
  if (mates.length === 1 && titleOf(mates[0].guest) && bt && titleOf(mates[0].guest) !== bt) return "conflict: mixed-gender sharing in " + room;
  b.room = room;
  const today = new Intl.DateTimeFormat("en-CA", {timeZone: "Asia/Kolkata"}).format(new Date());
  await env.DB.prepare("UPDATE datasets SET json = ?, updated_at = ? WHERE id = 'bookings'").bind(JSON.stringify(bookings), today).run();
  return "room " + room + " set for " + b.guest + " (" + b.check_in + ")";
}

// ---------- voucher intake (Apps Script posts operator voucher PDFs here) ----------
const V_GUEST = /(?:Guest(?:\s*Name)?|Name of (?:the )?Guest)\s*[:\-–]\s*([^\n]+)/i;
const V_ROOM = /Room\s*(?:No\.?|Number|#)?\s*[:\-–]?\s*([A-Z]?\d{1,4}(?:\s*-\s*\d{1,4})?)/i;
const V_OCC = /(?:Occupancy|Room\s*Type|Sharing)\s*[:\-–]\s*([^\n]+)/i;
const vGuess = (re, t) => { const r = String(t).match(re); return r ? r[1].trim().slice(0, 120) : ""; };
const ensureVouchers = (env) => env.DB.prepare("CREATE TABLE IF NOT EXISTS vouchers (key TEXT PRIMARY KEY, received_ist TEXT, sender TEXT, subject TEXT, file TEXT, guest TEXT, room_guess TEXT, occupancy_guess TEXT, text TEXT, pdf BLOB, created TEXT)").run();
async function vouchers(req, env) {
  const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!env.VOUCHER_TOKEN || !safeEq(tok, env.VOUCHER_TOKEN)) return json({error: "Unauthorized."}, 401);
  let b; try { b = await req.json(); } catch (e) { return json({error: "Bad request."}, 400); }
  await ensureVouchers(env);
  if (b.reapply) {                                     // re-check stored vouchers whose room was not applied yet
    try { await env.DB.prepare("ALTER TABLE vouchers ADD COLUMN applied TEXT").run(); } catch (e) { /* exists */ }
    const {results} = await env.DB.prepare("SELECT key, file, text FROM vouchers WHERE applied IS NULL OR applied NOT LIKE 'room % set for%' ORDER BY received_ist").all();
    const out = [];
    for (const v of results) { let a; try { a = await applyVoucher(env, v.text, v.file); } catch (e) { a = "not applied: " + e.message; }
      await env.DB.prepare("UPDATE vouchers SET applied = ? WHERE key = ?").bind(a.slice(0, 300), v.key).run(); out.push(v.file + ": " + a); }
    return json({reapplied: out});
  }
  if (Array.isArray(b.known)) {                       // which of these keys are already stored
    const keys = b.known.slice(0, 500).map(String), have = [];
    for (let i = 0; i < keys.length; i += 50) { const part = keys.slice(i, i + 50);
      const {results} = await env.DB.prepare("SELECT key FROM vouchers WHERE key IN (" + part.map(() => "?").join(",") + ")").bind(...part).all();
      results.forEach((r) => have.push(r.key)); }
    return json({known: have});
  }
  const key = String(b.key || "").slice(0, 200);
  if (!key || !b.pdf) return json({error: "key and pdf are required."}, 400);
  let bytes; try { const bin = atob(String(b.pdf)); bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); } catch (e) { return json({error: "pdf must be base64."}, 400); }
  if (bytes.length > 8e6) return json({error: "PDF too large."}, 413);
  let text = ""; try { text = await pdfText(bytes); } catch (e) { text = ""; }
  const file = String(b.file || "").slice(0, 200), guest = vGuess(V_GUEST, text) || file.replace(/\.pdf$/i, "");
  await env.DB.prepare("INSERT OR REPLACE INTO vouchers (key, received_ist, sender, subject, file, guest, room_guess, occupancy_guess, text, pdf, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(key, String(b.received || "").slice(0, 40), String(b.from || "").slice(0, 200), String(b.subject || "").slice(0, 300), file, guest,
      vGuess(V_ROOM, text), vGuess(V_OCC, text), text.slice(0, 100000), bytes.length < 1800000 ? bytes : null, new Date().toISOString()).run();
  let applied = ""; try { applied = await applyVoucher(env, text, file); } catch (e) { applied = "not applied: " + e.message; }
  try { await env.DB.prepare("ALTER TABLE vouchers ADD COLUMN applied TEXT").run(); } catch (e) { /* column exists */ }
  await env.DB.prepare("UPDATE vouchers SET applied = ? WHERE key = ?").bind(applied.slice(0, 300), key).run();
  return json({ok: true, chars: text.length, guest, room: vGuess(V_ROOM, text), occupancy: vGuess(V_OCC, text), applied});
}

// ---------- multi-client data model (admin panel) ----------
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS clients (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, logo_file INTEGER, grades TEXT, active INTEGER DEFAULT 1, created TEXT)",
  "CREATE TABLE IF NOT EXISTS guesthouses (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, name TEXT NOT NULL, city TEXT, address TEXT, map_url TEXT, operator TEXT, status TEXT DEFAULT 'Coming soon', cancellation TEXT, inclusions TEXT, amenities TEXT, show_json TEXT, sort INTEGER DEFAULT 0, updated TEXT)",
  "CREATE TABLE IF NOT EXISTS room_types (id INTEGER PRIMARY KEY AUTOINCREMENT, gh_id INTEGER NOT NULL, name TEXT, rooms INTEGER, room_nos TEXT, occupancy TEXT, grades TEXT, sort INTEGER DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, gh_id INTEGER NOT NULL, name TEXT, designation TEXT, email TEXT, phone TEXT, sort INTEGER DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS photos (id INTEGER PRIMARY KEY AUTOINCREMENT, gh_id INTEGER NOT NULL, file_id INTEGER NOT NULL, caption TEXT, sort INTEGER DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS documents (id INTEGER PRIMARY KEY AUTOINCREMENT, gh_id INTEGER NOT NULL, file_id INTEGER, doc_type TEXT, title TEXT, number TEXT, issued TEXT, expires TEXT, remind_days INTEGER DEFAULT 30, visible INTEGER DEFAULT 1, file_name TEXT, updated TEXT, last_notice TEXT)",
  "CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER, mime TEXT NOT NULL, data TEXT NOT NULL, created TEXT)",
  // hotel transaction reports uploaded by the Zuna team; one row per Booking Code per client
  "CREATE TABLE IF NOT EXISTS transactions (client_id INTEGER NOT NULL, code TEXT NOT NULL, booked TEXT, checkin TEXT, checkout TEXT, status TEXT, row TEXT NOT NULL, upload_id INTEGER, updated TEXT, PRIMARY KEY (client_id, code))",
  "CREATE INDEX IF NOT EXISTS tx_booked ON transactions (client_id, booked)",
  "CREATE INDEX IF NOT EXISTS tx_checkout ON transactions (client_id, checkout)",
  "CREATE TABLE IF NOT EXISTS tx_uploads (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, by_email TEXT, at TEXT, filename TEXT, rows INTEGER, added INTEGER, changed INTEGER, unchanged INTEGER, undone TEXT)",
  "CREATE TABLE IF NOT EXISTS tx_versions (upload_id INTEGER NOT NULL, code TEXT NOT NULL, prev TEXT)",
  "CREATE INDEX IF NOT EXISTS tx_versions_up ON tx_versions (upload_id)",
  "CREATE TABLE IF NOT EXISTS gh_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE NOT NULL, created TEXT)",
  // bookings made from the portal (Book a room) -- also written into the stay data so they show everywhere
  "CREATE TABLE IF NOT EXISTS trips (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, code TEXT, property TEXT, room TEXT, title TEXT, name TEXT, gender TEXT, grade TEXT, emp_code TEXT, email TEXT, phone TEXT, base TEXT, concur_tr TEXT, wbs TEXT, occupancy TEXT, check_in TEXT, check_out TEXT, note TEXT, status TEXT, cc TEXT, bcc TEXT, booked_by TEXT, booked_at TEXT, changed_by TEXT, changed_at TEXT, cancelled_by TEXT, cancelled_at TEXT, cancel_reason TEXT, mail_status TEXT, history TEXT)",
  "CREATE INDEX IF NOT EXISTS trips_client ON trips (client_id, check_in)",
  // guests saved from bookings, offered as suggestions when the next booking is typed
  // guest house rates and blackout dates (Zuna admin only)
  "CREATE TABLE IF NOT EXISTS gh_rates (id INTEGER PRIMARY KEY AUTOINCREMENT, gh_id INTEGER NOT NULL, room_type_id INTEGER DEFAULT 0, from_date TEXT NOT NULL, to_date TEXT NOT NULL, nil INTEGER DEFAULT 0, fare REAL DEFAULT 0, svc REAL DEFAULT 0, svc_unit TEXT DEFAULT 'night', note TEXT, by_email TEXT, at TEXT)",
  "CREATE INDEX IF NOT EXISTS gh_rates_gh ON gh_rates (gh_id, from_date)",
  "CREATE TABLE IF NOT EXISTS gh_blocks (id INTEGER PRIMARY KEY AUTOINCREMENT, gh_id INTEGER NOT NULL, rooms TEXT, from_date TEXT NOT NULL, to_date TEXT NOT NULL, reason TEXT, by_email TEXT, at TEXT)",
  "CREATE INDEX IF NOT EXISTS gh_blocks_gh ON gh_blocks (gh_id, from_date)",
  "CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, email TEXT, role TEXT, client_id INTEGER, action TEXT NOT NULL, target TEXT, detail TEXT, ip TEXT, ok INTEGER DEFAULT 1)",
  "CREATE INDEX IF NOT EXISTS audit_at ON audit (at)",
  "CREATE TABLE IF NOT EXISTS gh_cancel (id INTEGER PRIMARY KEY AUTOINCREMENT, gh_id INTEGER NOT NULL, room_type_id INTEGER DEFAULT 0, free_hours REAL DEFAULT 24, charge_type TEXT DEFAULT 'nights', charge_value REAL DEFAULT 1, note TEXT, by_email TEXT, at TEXT)",
  "CREATE TABLE IF NOT EXISTS guests (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, gkey TEXT NOT NULL, title TEXT, name TEXT, gender TEXT, email TEXT, phone TEXT, grade TEXT, emp_code TEXT, base TEXT, uses INTEGER DEFAULT 0, last_used TEXT, UNIQUE (client_id, gkey))",
  // hotel bookings removed by the Zuna team (kept so they can be restored)
  // live sync settings per client: partner API address, relay, secrets (never sent back to the browser) and the last run
  "CREATE TABLE IF NOT EXISTS tx_sync (client_id INTEGER PRIMARY KEY, api_url TEXT, relay_url TEXT, relay_key TEXT, token TEXT, months INTEGER DEFAULT 2, skip_free_cxl INTEGER DEFAULT 1, enabled INTEGER DEFAULT 0, fee REAL, fee_gst REAL, hotel_gst REAL, gst_slab INTEGER, jwt_secret TEXT, jwt_iss TEXT, jwt_aud TEXT, jwt_client TEXT, jwt_corporate TEXT, last_run TEXT, last_ok TEXT, last_error TEXT, last_result TEXT)",
  "CREATE TABLE IF NOT EXISTS tx_removed (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, code TEXT NOT NULL, row TEXT NOT NULL, upload_id INTEGER, by_email TEXT, at TEXT, restored TEXT)",
];
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  for (const q of SCHEMA) await env.DB.prepare(q).run();
  for (const c of ["users ADD COLUMN role TEXT", "users ADD COLUMN client_id INTEGER", "guesthouses ADD COLUMN state TEXT", "guesthouses ADD COLUMN country TEXT", "room_types ADD COLUMN bed_type TEXT", "clients ADD COLUMN legal_name TEXT", "users ADD COLUMN tx_access INTEGER", "tx_uploads ADD COLUMN hash TEXT", "tx_uploads ADD COLUMN file_id INTEGER", "transactions ADD COLUMN held INTEGER", "users ADD COLUMN book_access INTEGER", "clients ADD COLUMN mail_cc TEXT", "clients ADD COLUMN mail_bcc TEXT", "trips ADD COLUMN wbs TEXT", "clients ADD COLUMN elig TEXT", "clients ADD COLUMN svc_fee REAL", "guesthouses ADD COLUMN checkin_time TEXT", "guesthouses ADD COLUMN checkout_time TEXT", "guesthouses ADD COLUMN team_emails TEXT", "gh_rates ADD COLUMN plan TEXT", "gh_rates ADD COLUMN fare_double REAL", "gh_rates ADD COLUMN extra_bed REAL", "trips ADD COLUMN plan TEXT", "trips ADD COLUMN cancel_charge REAL", "trips ADD COLUMN cancel_basis TEXT", "tx_sync ADD COLUMN fee REAL", "tx_sync ADD COLUMN fee_gst REAL", "tx_sync ADD COLUMN hotel_gst REAL", "tx_sync ADD COLUMN gst_slab INTEGER", "tx_sync ADD COLUMN jwt_secret TEXT", "tx_sync ADD COLUMN jwt_iss TEXT", "tx_sync ADD COLUMN jwt_aud TEXT", "tx_sync ADD COLUMN jwt_client TEXT", "tx_sync ADD COLUMN jwt_corporate TEXT"]) { try { await env.DB.prepare("ALTER TABLE " + c).run(); } catch (e) { /* exists */ } }
  schemaReady = true;
}
const DEFAULT_GRADES = "M1,M2,M3,M4,M5,M6,M7,M8,P1,P2,P3,E1,E2,E3,E4,E5,E6,E7";
const SHOW_DEFAULT = {amenities: true, inclusions: true, cancellation: true, photos: true, contacts: true};
const jparse = (t, d) => { try { const v = JSON.parse(t); return v == null ? d : v; } catch (e) { return d; } };
const list = (t) => jparse(t, []).filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().slice(0, 120));
// "E1,E2,E3,P1,P2,P3" -> "E1–E3, P1–P3"; every grade -> "All grades"
// "M6-M8, E1-E8" -> ["M6","M7","M8","E1",...,"E8"]
function parseGrades(str) {
  const out = [];
  String(str || "").toUpperCase().split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean).forEach((tok) => {
    const m = tok.match(/^([A-Z]+)\s*(\d+)\s*(?:-|–|TO)\s*([A-Z]+)?\s*(\d+)$/);
    if (m && (!m[3] || m[3] === m[1])) { const a = +m[2], z = +m[4]; for (let n = Math.min(a, z); n <= Math.max(a, z) && n - a < 40; n++) out.push(m[1] + n); }
    else if (/^[A-Z]+\d*$/.test(tok.replace(/\s+/g, ""))) out.push(tok.replace(/\s+/g, "")); });
  return [...new Set(out)].slice(0, 120);
}
// guest house eligibility by gender for a client: {Male: [...], Female: [...]}; null when not set
const eligOf = (client) => { const e = jparse(client && client.elig, null); return e && (Array.isArray(e.Male) || Array.isArray(e.Female)) ? e : null; };
function gradeText(grades, all) {
  if (!grades.length) return "—";
  if (all.length && all.every((g) => grades.includes(g))) return "All grades";
  const out = [];
  const series = [...new Set(all.concat(grades).map((g) => g.replace(/\d+$/, "")))];
  for (const sr of series) {
    const nums = grades.filter((g) => g.replace(/\d+$/, "") === sr).map((g) => +(g.match(/\d+$/) || [0])[0]).sort((a, b) => a - b);
    for (let i = 0; i < nums.length;) { let j = i; while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
      out.push(j > i ? sr + nums[i] + "–" + sr + nums[j] : sr + nums[i]); i = j + 1; }
  }
  return out.join(", ");
}
// "1001-101 to 1001-104" | "504-1 to 504-4" | "2204 R1 to R4" | "401, 402" -> individual room names
function expandRooms(t) {
  const s = String(t || "").trim(); if (!s) return [];
  const m = s.match(/^(.*?)(\d+)\s*(?:to|–|—)\s*(.*?)(\d+)$/i);
  if (m && +m[4] >= +m[2] && +m[4] - +m[2] < 60) { const out = []; for (let i = +m[2]; i <= +m[4]; i++) out.push(m[1] + i); return out; }
  return s.split(/\s*,\s*/).filter(Boolean);
}
async function multiClient(env) { await ensureSchema(env); return !!(await env.DB.prepare("SELECT id FROM clients LIMIT 1").first()); }
async function adminState(env, user) {
  await ensureSchema(env);
  const {results: clients} = await env.DB.prepare("SELECT id, name, logo_file, grades, active, legal_name, mail_cc, mail_bcc, elig, svc_fee FROM clients ORDER BY id").all();
  const [bk, mn] = await Promise.all([readSet(env, "bookings"), readSet(env, "manual")]), manualKeys = new Set(mn.rows.filter((x) => x.status !== "Cancelled").map(guestKey));
  const out = await Promise.all(clients.map(async (c) => {
    const [users, guesthouses] = await Promise.all([clientUsers(env, c.id), clientGuestHouses(env, c, true)]);
    const names = new Set(guesthouses.map((g) => g.property));
    const el = eligOf(c);
    return {id: c.id, name: c.name, svc_fee: +c.svc_fee || 0, legal_name: c.legal_name || "", mail_cc: c.mail_cc || "", mail_bcc: c.mail_bcc || "", elig_male: el && el.Male && el.Male.length ? gradeText(el.Male, []) : "", elig_female: el && el.Female && el.Female.length ? gradeText(el.Female, []) : "", active: !!c.active, logo: c.logo_file ? "/files/" + c.logo_file : "", grades: (c.grades || DEFAULT_GRADES).split(",").filter(Boolean), users, guesthouses,
      bookings: bk.rows.filter((x) => names.has(x.property) && x.status !== "Cancelled").map((x) => Object.assign({}, x, {manual: manualKeys.has(guestKey(x))})), ...(await ratesState(env, guesthouses.map((g) => g.id)))}; }));
  return {clients: out, me: user.email};
}
// ---- guest house documents (agreements, licences…) ----
const DOC_TYPES = ["Lease agreement", "Service agreement", "Trade licence", "Fire NOC", "Police verification", "FSSAI licence", "GST registration", "Insurance", "Property tax receipt", "Other"];
const daysLeft = (d) => d ? Math.round((Date.parse(d) - Date.parse(istToday())) / 864e5) : null;
const docOut = (d) => { const left = daysLeft(d.expires);
  return {id: d.id, type: d.doc_type || "Other", title: d.title || d.doc_type || "Document", number: d.number || "", issued: d.issued || "", expires: d.expires || "", remind_days: d.remind_days || 30,
    visible: !!d.visible, url: d.file_id ? "/files/" + d.file_id : "", mime: d.mime || "", file_name: d.file_name || "", days_left: left,
    state: left == null ? "none" : left < 0 ? "expired" : left <= (d.remind_days || 30) ? "expiring" : "valid"}; };
async function docReminders(env) {
  await ensureSchema(env);
  if (!env.RESEND_API_KEY) return {sent: 0, reason: "no mail key"};
  const today = istToday();
  const {results} = await env.DB.prepare("SELECT d.*, g.name AS gh, g.city, g.client_id, c.name AS client FROM documents d JOIN guesthouses g ON g.id = d.gh_id JOIN clients c ON c.id = g.client_id WHERE d.expires IS NOT NULL AND d.expires <> '' AND c.active = 1").all();
  const due = results.filter((d) => { const n = daysLeft(d.expires), r = d.remind_days || 30; return d.last_notice !== today && (n === r || n === 7 || n === 1 || n === 0 || (n < 0 && n >= -28 && n % 7 === 0)); });
  if (!due.length) return {sent: 0};
  const {results: admins} = await env.DB.prepare("SELECT email, name FROM users WHERE role = 'admin' AND active = 1").all();
  let sent = 0;
  for (const cid of [...new Set(due.map((d) => d.client_id))]) {
    const list = due.filter((d) => d.client_id === cid);
    const {results: mgrs} = await env.DB.prepare("SELECT email, name FROM users WHERE role = 'client_admin' AND active = 1 AND client_id = ?").bind(cid).all();
    const to = [...new Set(admins.concat(list.some((d) => d.visible) ? mgrs : []).map((u) => u.email).filter((e) => e.includes("@")))];
    const body = docMail(list[0].client, list);
    for (const e of to) if (await sendMail(env, e, "Guest house documents due for renewal · " + list[0].client, body)) sent++;
    await env.DB.batch(list.map((d) => env.DB.prepare("UPDATE documents SET last_notice = ? WHERE id = ?").bind(today, d.id)));
  }
  return {sent};
}
function docMail(client, list) {
  const esc = (t) => String(t || "").replace(/[<>&"]/g, (c) => ({"<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;"})[c]);
  const fd = (d) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", {day: "2-digit", month: "short", year: "numeric", timeZone: "UTC"});
  const when = (n) => n < 0 ? "Expired " + -n + (n === -1 ? " day" : " days") + " ago" : n === 0 ? "Expires today" : "Expires in " + n + (n === 1 ? " day" : " days");
  const rows = list.map((d) => { const n = daysLeft(d.expires);
    return '<tr><td style="padding:10px 12px;border-top:1px solid #eeeaf9"><b>' + esc(d.title || d.doc_type) + '</b><br><span style="color:#7a74a3;font-size:12px">' + esc(d.gh) + (d.city ? ", " + esc(d.city) : "") + (d.number ? " · No. " + esc(d.number) : "") + '</span></td>'
      + '<td style="padding:10px 12px;border-top:1px solid #eeeaf9;white-space:nowrap">' + fd(d.expires) + '<br><span style="font-size:12px;font-weight:600;color:' + (n < 0 ? "#be123c" : "#b45309") + '">' + when(n) + '</span></td></tr>'; }).join("");
  const text = "Guest house documents for " + client + " that need renewal:\n\n" + list.map((d) => "- " + (d.title || d.doc_type) + " (" + d.gh + "): " + when(daysLeft(d.expires)) + ", " + fd(d.expires)).join("\n") + "\n\nOpen https://gh.zuna.ai to view them.\n\nZuna Hotel Desk";
  const html = '<!doctype html><html><body style="margin:0;background:#f4f2fb;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#12005A">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f2fb;padding:32px 12px"><tr><td align="center">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden">'
    + '<tr><td style="background:#12005A;padding:22px 28px;color:#ffffff;font-size:20px;font-weight:700">zuna <span style="color:#02C988;font-size:13px;font-weight:600">Guest House Management</span></td></tr>'
    + '<tr><td style="padding:24px 28px 8px"><p style="margin:0 0 6px;font-size:16px;font-weight:700">Documents due for renewal</p><p style="margin:0 0 16px;font-size:14px;color:#5d5887">' + esc(client) + ' guest houses</p>'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;border:1px solid #eeeaf9;border-radius:12px;border-collapse:separate">' + rows + '</table>'
    + '<p style="margin:20px 0 4px"><a href="https://gh.zuna.ai" style="display:inline-block;background:#12005A;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:10px">Open the portal</a></p></td></tr>'
    + '<tr><td style="padding:16px 28px;border-top:1px solid #e6e2f6;font-size:12px;color:#7d68c6">Zuna Hotel Desk · Zuna Travel Solutions</td></tr></table></td></tr></table></body></html>';
  return {text, html};
}

// ---- users of one client (Zuna admins, and the client's own client admins) ----
async function clientUsers(env, cid) { const {results} = await env.DB.prepare("SELECT email, name, active, last_login, locked_until, role, tx_access, book_access FROM users WHERE client_id = ? AND (role IS NULL OR role <> 'admin') ORDER BY name").bind(cid).all(); return results.map((u) => Object.assign(u, {role: u.role === "client_admin" ? "client_admin" : "client", tx: u.role === "client_admin" || !!u.tx_access, book: !!u.book_access})); }
async function userAction(env, cid, b, actor, action) {
  const email = clean(b.email, 200).toLowerCase(), name = clean(b.name, 120), role = b.role === "client_admin" ? "client_admin" : "client";
  if (!email) return json({error: "Enter an email address or user ID."}, 400);
  const ex = await env.DB.prepare("SELECT email, name, role, client_id FROM users WHERE email = ?").bind(email).first();
  if (ex && (ex.role === "admin" || ex.client_id !== cid)) return json({error: ex.role === "admin" ? "That account is a Zuna admin." : "That email already has an account."}, 400);
  if (action === "access") {   // switch hotel bookings on or off for a user (client admins always have it)
    if (!ex) return json({error: "No such user."}, 404);
    if ("tx" in b) await env.DB.prepare("UPDATE users SET tx_access = ? WHERE email = ?").bind(b.tx ? 1 : 0, email).run();
    if ("book" in b) await env.DB.prepare("UPDATE users SET book_access = ? WHERE email = ?").bind(b.book ? 1 : 0, email).run();
    return json({ok: true}); }
  if (action === "reset") { if (!ex) return json({error: "No such user."}, 404); const pw = makePassword(ex.name); await setPassword(env, email, pw); await env.DB.prepare("DELETE FROM sessions WHERE email = ?").bind(email).run(); return json({ok: true, password: pw}); }
  if (!ex) {
    const pw = makePassword(name || email);
    await env.DB.prepare("INSERT INTO users (email, name, salt, hash, active, failed, role, client_id) VALUES (?, ?, '', '', 1, 0, ?, ?)").bind(email, name || email, role, cid).run();
    await setPassword(env, email, pw);
    return json({ok: true, created: true, password: pw});
  }
  if (actor && email === actor.email && (b.active === false || role !== ex.role)) return json({error: "You can't disable your own account or change your own role."}, 400);
  await env.DB.prepare("UPDATE users SET name = ?, active = ?, role = ? WHERE email = ?").bind(name || ex.name || email, b.active === false ? 0 : 1, b.role ? role : ex.role, email).run();
  if (b.active === false) await env.DB.prepare("DELETE FROM sessions WHERE email = ?").bind(email).run();
  return json({ok: true});
}
async function manageState(env, user) {
  const c = await env.DB.prepare("SELECT id, name, logo_file, grades, active FROM clients WHERE id = ?").bind(user.client_id).first();
  if (!c) return {clients: []};
  return {clients: [{id: c.id, name: c.name, active: !!c.active, logo: c.logo_file ? "/files/" + c.logo_file : "", grades: [], users: await clientUsers(env, c.id), guesthouses: [], bookings: []}], me: user.email};
}
async function manageApi(req, env, user, path) {
  let b; try { b = await req.json(); } catch (e) { return json({error: "Bad request."}, 400); }
  try {
    if (path === "/api/manage/state") return json(await manageState(env, user));
    if (path === "/api/manage/user") return userAction(env, user.client_id, b, user, "save");
    if (path === "/api/manage/user/reset") return userAction(env, user.client_id, b, user, "reset");
    if (path === "/api/manage/user/access") return userAction(env, user.client_id, b, user, "access");
  } catch (e) { return json({error: e.message || "Something went wrong."}, 400); }
  return json({error: "Not found."}, 404);
}

async function clientGuestHouses(env, client, forAdmin) {
  const all = (client.grades || DEFAULT_GRADES).split(",").map((g) => g.trim()).filter(Boolean);
  const {results: ghs} = await env.DB.prepare("SELECT * FROM guesthouses WHERE client_id = ? ORDER BY sort, id").bind(client.id).all();
  const out = [];
  // one query per table for the whole client, not per guest house
  const sub = "(SELECT id FROM guesthouses WHERE client_id = ?)";
  const [R, K, F, D] = await Promise.all([
    env.DB.prepare("SELECT * FROM room_types WHERE gh_id IN " + sub + " ORDER BY sort, id").bind(client.id).all(),
    env.DB.prepare("SELECT * FROM contacts WHERE gh_id IN " + sub + " ORDER BY sort, id").bind(client.id).all(),
    env.DB.prepare("SELECT id, gh_id, file_id, caption FROM photos WHERE gh_id IN " + sub + " ORDER BY sort, id").bind(client.id).all(),
    env.DB.prepare("SELECT d.*, f.mime FROM documents d LEFT JOIN files f ON f.id = d.file_id WHERE d.gh_id IN " + sub + " ORDER BY d.expires IS NULL, d.expires, d.id").bind(client.id).all()]);
  const by = (rows, id) => (rows.results || []).filter((r) => r.gh_id === id);
  for (const g of ghs) {
    const rts = by(R, g.id), cts = by(K, g.id), phs = by(F, g.id), dcs = by(D, g.id).filter((d) => forAdmin || d.visible);
    const show = Object.assign({}, SHOW_DEFAULT, jparse(g.show_json, {})), multi = rts.length > 1;
    const types = rts.map((r) => ({id: r.id, name: r.name || "", rooms: r.rooms || 0, room_nos: r.room_nos || "", occupancy: r.occupancy || "Single", bed_type: r.bed_type || "", grades: list(r.grades), eligible: gradeText(list(r.grades), all)}));
    const contacts = cts.map((c) => ({id: c.id, name: c.name || "", designation: c.designation || "", email: c.email || "", phone: c.phone || ""}));
    const gh = {
      id: g.id, property: g.name, city: g.city || "", state: g.state || "", country: g.country || "", address: g.address || "", map_url: g.map_url || "", operator: g.operator || "", status: g.status || "Coming soon", checkin_time: g.checkin_time || "12:00", checkout_time: g.checkout_time || "11:00",   // standard times unless the guest house has its own
      rooms: String(types.reduce((t, r) => t + (+r.rooms || 0), 0)),
      room_nos: types.map((r) => (multi && r.name ? r.name + " " : "") + r.room_nos).filter((x) => x.trim()).join(", "),
      rooms_list: types.flatMap((r) => expandRooms(r.room_nos)),
      eligible: types.map((r) => (multi && r.name ? r.name + ": " : "") + r.eligible).join("; "),
      room_types: types,
    };
    if (forAdmin || show.contacts) { gh.contacts = contacts;
      gh.poc_name = contacts.map((c) => c.name + (c.designation ? " (" + c.designation + ")" : "")).join("; ");
      gh.poc_phone = contacts.map((c) => c.phone).filter(Boolean).join("; "); gh.poc_email = contacts.map((c) => c.email).filter(Boolean).join("; "); }
    if (forAdmin || show.inclusions) gh.inclusions = list(g.inclusions);
    if (forAdmin || show.amenities) gh.amenities = list(g.amenities);
    if (forAdmin || show.cancellation) gh.cancellation = g.cancellation || "";
    if (forAdmin || show.photos) gh.photos = phs.map((p) => ({id: p.id, url: "/files/" + p.file_id, caption: p.caption || ""}));
    gh.documents = dcs.map(docOut);
    if (forAdmin) { gh.show = show; gh.team_emails = g.team_emails || ""; }
    out.push(gh);
  }
  return out;
}
const DATA_URL = /^data:(image\/(?:png|jpeg|webp)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/;
async function saveFile(env, clientId, dataUrl, allowPdf) {
  const m = String(dataUrl || "").match(DATA_URL);
  if (!m || (m[1] === "application/pdf" && !allowPdf)) throw new Error(allowPdf ? "Upload a PDF, PNG, JPG or WEBP file." : "Upload a PNG, JPG or WEBP image.");
  if (m[2].length > 1900000) throw new Error(m[1] === "application/pdf" ? "PDF is too large (max 1.4 MB). Please compress it and try again." : "Image is too large (max about 1.4 MB after resizing).");
  if (m[1] === "application/pdf" && !atob(m[2].slice(0, 8)).startsWith("%PDF")) throw new Error("That file is not a valid PDF.");
  const r = await env.DB.prepare("INSERT INTO files (client_id, mime, data, created) VALUES (?, ?, ?, ?)").bind(clientId, m[1], m[2], new Date().toISOString()).run();
  return r.meta ? r.meta.last_row_id : r.lastInsertRowid;
}
async function serveFile(env, user, id) {
  const f = await env.DB.prepare("SELECT client_id, mime, data FROM files WHERE id = ?").bind(id).first();
  if (!f || (!user.admin && f.client_id !== user.client_id)) return new Response("Not found", {status: 404, headers: SEC});
  const doc = await env.DB.prepare("SELECT title, doc_type, file_name, visible FROM documents WHERE file_id = ?").bind(id).first();
  if (doc && !doc.visible && !user.admin) return new Response("Not found", {status: 404, headers: SEC});
  const bin = atob(f.data), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const h = {...SEC, "content-type": f.mime, "cache-control": "private, max-age=3600"};
  if (f.mime === "application/pdf") {   // the browser's PDF viewer does not run in a sandboxed page
    h["content-security-policy"] = "default-src 'none'; frame-ancestors 'self'";
    h["content-disposition"] = 'inline; filename="' + String((doc && (doc.file_name || doc.title)) || "document").replace(/[^\w .()-]/g, "_").replace(/(\.pdf)?$/i, ".pdf") + '"';
  } else h["content-security-policy"] = "default-src 'none'; sandbox";
  return new Response(u8, {headers: h});
}
const PW_DIGITS = "23456789";
const makePassword = (name) => (String(name || "User").trim().split(/\s+/)[0].replace(/[^A-Za-z]/g, "") || "User").replace(/^./, (c) => c.toUpperCase()) + "@" + Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => PW_DIGITS[b % 8]).join("");
async function setPassword(env, email, pw) {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET salt = ?, hash = ?, failed = 0, locked_until = NULL WHERE email = ?").bind(salt, await pbkdf2(pw, salt), email),
    env.DB.prepare("DELETE FROM sessions WHERE email = ?").bind(email)]);
}
const clean = (v, n = 300) => String(v == null ? "" : v).trim().slice(0, n);
// ---- bookings recorded from the admin panel ----
// They go into the live `bookings` row (shown at once) and the `manual` row, which the hourly update applies last,
// so a Zuna edit is never overwritten. A manual row with status "Cancelled" removes that stay.
const BK_COLS = ["property", "guest", "grade", "base", "check_in", "check_out", "nights", "room", "status", "concur_tr", "note", "gender", "occupancy"];
const guestKey = (b) => String(b.guest || "").toLowerCase().replace(/^\s*(mr|mrs|ms|miss|dr)\b\.?/, "").replace(/[^a-z]/g, "") + "|" + (b.check_in || "");
const istToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
async function readSet(env, id) { const r = await env.DB.prepare("SELECT json, updated_at FROM datasets WHERE id = ?").bind(id).first(); return {rows: r ? jparse(r.json, []) : [], at: r ? r.updated_at : ""}; }
const writeSet = (env, id, rows, at) => env.DB.prepare("INSERT OR REPLACE INTO datasets (id, json, updated_at) VALUES (?, ?, ?)").bind(id, JSON.stringify(rows), at);
async function saveBooking(env, client, b) {
  const ghs = await clientGuestHouses(env, client, true), gh = ghs.find((g) => g.property === clean(b.row && b.row.property, 120));
  if (!gh) return json({error: "Pick one of " + client.name + "'s guest houses."}, 400);
  const r = b.row, iso = /^\d{4}-\d{2}-\d{2}$/;
  const title = ["Mr.", "Ms.", "Mrs.", "Dr."].includes(r.title) ? r.title : "";
  const name = clean(r.name, 100).replace(/^\s*(mr|mrs|ms|miss|dr)\b\.?\s*/i, "");
  if (!name) return json({error: "Enter the guest's name."}, 400);
  if (!iso.test(r.check_in || "") || !iso.test(r.check_out || "") || r.check_out <= r.check_in) return json({error: "Check-out must be after check-in."}, 400);
  const status = r.status === "Not available" ? "Not available" : "Confirmed";
  const room = status === "Confirmed" && gh.rooms_list.includes(r.room) ? r.room : status === "Confirmed" ? "Not assigned" : "\u2014";
  const gender = ["Male", "Female"].includes(r.gender) ? r.gender : title === "Mr." ? "Male" : title === "Ms." || title === "Mrs." ? "Female" : "Not stated";
  const row = {property: gh.property, guest: (title ? title + " " : "") + name, grade: clean(r.grade, 20) || "Not stated", base: clean(r.base, 60) || "Not stated", check_in: r.check_in, check_out: r.check_out,
    nights: String(Math.round((Date.parse(r.check_out) - Date.parse(r.check_in)) / 864e5)), room, status, concur_tr: clean(r.concur_tr, 40), note: clean(r.note, 300), gender, occupancy: r.occupancy === "Double" ? "Double" : "Single"};
  if (r.emp_code) row.emp_code = clean(r.emp_code, 30); if (r.wbs) row.wbs = clean(r.wbs, 60);
  const bk = await readSet(env, "bookings"), mn = await readSet(env, "manual"), key = guestKey(row), orig = b.original && b.original.guest ? guestKey(b.original) : "";
  let rows = bk.rows.filter((x) => guestKey(x) !== key && (!orig || guestKey(x) !== orig)); rows.push(row);
  let man = mn.rows.filter((x) => guestKey(x) !== key && (!orig || guestKey(x) !== orig)); man.push(row);
  if (orig && orig !== key) { const old = bk.rows.find((x) => guestKey(x) === orig) || b.original; man.push(Object.assign({}, ...BK_COLS.map((k) => ({[k]: String(old[k] || "")})), {status: "Cancelled", note: "Replaced from the admin panel"})); }
  rows.sort((x, y) => (x.property || "").localeCompare(y.property || "") || (x.check_in || "").localeCompare(y.check_in || ""));
  await env.DB.batch([writeSet(env, "bookings", rows, istToday()), writeSet(env, "manual", man, istToday())]);
  return json({ok: true, row});
}
async function cancelBooking(env, client, b) {
  const names = new Set((await clientGuestHouses(env, client, true)).map((g) => g.property)), key = guestKey(b);
  const bk = await readSet(env, "bookings"), mn = await readSet(env, "manual"), old = bk.rows.find((x) => guestKey(x) === key && names.has(x.property));
  if (!old) return json({error: "Booking not found."}, 404);
  const prevMan = mn.rows.find((x) => guestKey(x) === key) || null;
  const man = mn.rows.filter((x) => guestKey(x) !== key); man.push(Object.assign({}, old, {status: "Cancelled", note: "Cancelled from the admin panel"}));
  await env.DB.batch([writeSet(env, "bookings", bk.rows.filter((x) => x !== old), istToday()), writeSet(env, "manual", man, istToday())]);
  return json({ok: true, undo: {row: old, manual: prevMan}});
}
// Undo a cancellation: put the exact booking back, and the manual entry as it was before
async function restoreBooking(env, client, b) {
  const names = new Set((await clientGuestHouses(env, client, true)).map((g) => g.property)), pick = (r) => Object.assign({}, ...BK_COLS.map((k) => ({[k]: String((r && r[k]) || "").slice(0, 300)})));
  const row = pick(b.row); if (!names.has(row.property) || !row.guest || !row.check_in) return json({error: "This booking can't be restored."}, 400);
  const key = guestKey(row), bk = await readSet(env, "bookings"), mn = await readSet(env, "manual");
  const rows = bk.rows.filter((x) => guestKey(x) !== key); rows.push(row);
  rows.sort((x, y) => (x.property || "").localeCompare(y.property || "") || (x.check_in || "").localeCompare(y.check_in || ""));
  const man = mn.rows.filter((x) => guestKey(x) !== key); if (b.manual && b.manual.guest) man.push(pick(b.manual));
  await env.DB.batch([writeSet(env, "bookings", rows, istToday()), writeSet(env, "manual", man, istToday())]);
  return json({ok: true});
}

/* ---------- Guest house rates and blackout dates (Zuna admin only) ----------
   Rates: per guest house (room_type_id 0) or per room type, for a date range of nights (from_date..to_date, inclusive).
   Basic fare per night, or Nil. Tax on the fare: 5% when the night's fare is below 7,500, otherwise 18%.
   Service charge: one amount per client, charged once per booking, with 18% GST; it applies even when the fare is Nil.
   A room type's rate beats the whole-house rate for the same night; among equals the later start (then the newer entry) wins.
   Blocks: a whole guest house (rooms empty) or some rooms, for a date range of nights; blocked rooms can't be booked. */
const FARE_TAX = (fare) => fare < 7500 ? 0.05 : 0.18, SVC_GST = 0.18;
const r2 = (v) => Math.round(v * 100) / 100;
const isoD = /^\d{4}-\d{2}-\d{2}$/;
async function ghBlocks(env, ghId, from, to) {   // blocks touching the nights from..to (to exclusive)
  const {results} = await env.DB.prepare("SELECT * FROM gh_blocks WHERE gh_id = ? AND from_date < ? AND to_date >= ? ORDER BY from_date").bind(ghId, to, from).all();
  return results.map((x) => ({id: x.id, rooms: String(x.rooms || "").split(",").map((s) => s.trim()).filter(Boolean), from: x.from_date, to: x.to_date, reason: x.reason || ""}));
}
const blocksFor = (blocks, room) => blocks.filter((b) => !b.rooms.length || b.rooms.includes(room));
// cost of the nights ci..co (co exclusive) in a room type of a guest house
// rate plans (meal plans). Rates saved before plans existed count as EP.
const PLANS = [["EP", "Room only"], ["CP", "Breakfast included"], ["MAP", "Breakfast + one meal"], ["AP", "All meals"]];
const PLAN_CODES = PLANS.map((p) => p[0]), planOf = (x) => PLAN_CODES.includes(x) ? x : "EP", planLabel = (c) => { const p = PLANS.find((x) => x[0] === c); return p ? p[0] + " · " + p[1] : ""; };
async function ghRates(env, ghId, ci, co) { const {results} = await env.DB.prepare("SELECT * FROM gh_rates WHERE gh_id = ? AND from_date < ? AND to_date >= ?").bind(ghId, co, ci).all(); return results; }
function ghCostFrom(rows, roomTypeId, ci, co, svcFee, plan, occupancy) {
  const rt = +roomTypeId || 0, pl = planOf(plan), dbl = occupancy === "Double";
  const mine = rows.filter((x) => (!x.room_type_id || x.room_type_id === rt) && planOf(x.plan) === pl);
  const pick = (d) => mine.filter((x) => x.from_date <= d && x.to_date >= d).sort((a, b) => ((b.room_type_id ? 1 : 0) - (a.room_type_id ? 1 : 0)) || (b.from_date < a.from_date ? -1 : b.from_date > a.from_date ? 1 : 0) || b.id - a.id)[0];
  const segs = [], out = {plan: pl, occupancy: dbl ? "Double" : "Single", nights: 0, missing: 0, fare: 0, fare_tax: 0, svc: 0, svc_gst: 0, total: 0, per_night: 0, segments: segs};
  for (let d = ci; d < co; d = new Date(Date.parse(d) + 864e5).toISOString().slice(0, 10)) {
    out.nights++; const r = pick(d); if (!r) { out.missing++; continue; }
    const fare = r.nil ? 0 : (dbl && +r.fare_double > 0 ? +r.fare_double : +r.fare || 0), tax = fare * FARE_TAX(fare);
    out.fare += fare; out.fare_tax += tax;
    const last = segs[segs.length - 1];
    if (last && last.rate_id === r.id) { last.nights++; last.to = d; } else segs.push({rate_id: r.id, from: d, to: d, nights: 1, nil: !!r.nil, fare, tax_rate: fare ? FARE_TAX(fare) : 0, scope: r.room_type_id ? "room type" : "guest house"});
  }
  if (out.nights) out.svc = +svcFee || 0;   // the client's service charge, once per booking
  out.svc_gst = out.svc * SVC_GST;
  ["fare", "fare_tax", "svc", "svc_gst"].forEach((k) => { out[k] = r2(out[k]); }); out.total = r2(out.fare + out.fare_tax + out.svc + out.svc_gst);
  out.per_night = out.nights - out.missing ? r2((out.fare + out.fare_tax) / (out.nights - out.missing)) : 0;
  return out;
}
// plans with a rate on at least one of these nights for this room type, in EP → AP order
const plansFrom = (rows, roomTypeId) => PLAN_CODES.filter((p) => rows.some((x) => (!x.room_type_id || x.room_type_id === (+roomTypeId || 0)) && planOf(x.plan) === p));
async function ghCost(env, ghId, roomTypeId, ci, co, svcFee, plan, occupancy) { return ghCostFrom(await ghRates(env, ghId, ci, co), roomTypeId, ci, co, svcFee, plan, occupancy); }
/* ---------- Cancellation charges ----------
   Per guest house, with room-type rules that win over it: free until N hours before check-in (the guest house's check-in time, IST),
   then a charge: "nights" (the first N nights' fare + tax), "percent" (of the stay's fare + tax), "full" (the whole stay) or "fixed" (₹). */
const CXL_TYPES = ["nights", "percent", "full", "fixed"];
const cxlOut = (x) => ({id: x.id, gh_id: x.gh_id, room_type_id: x.room_type_id || 0, free_hours: +x.free_hours || 0, charge_type: CXL_TYPES.includes(x.charge_type) ? x.charge_type : "nights", charge_value: +x.charge_value || 0, note: x.note || "", by: x.by_email || "", at: x.at || ""});
const cxlHours = (h) => h % 24 === 0 && h >= 48 ? h / 24 + " days" : h + (h === 1 ? " hour" : " hours");
const cxlCharge = (r) => r.charge_type === "full" ? "the full stay is charged" : r.charge_type === "percent" ? r.charge_value + "% of the stay is charged" : r.charge_type === "fixed" ? "₹" + (+r.charge_value).toLocaleString("en-IN") + " is charged"
  : (+r.charge_value || 1) === 1 ? "one night is charged" : r.charge_value + " nights are charged";
const cxlText = (r) => r ? (r.free_hours > 0 ? "Free cancellation until " + cxlHours(r.free_hours) + " before check-in; after that " + cxlCharge(r) + "." : "No free cancellation: " + cxlCharge(r) + ".") : "";
const cxlDeadline = (ci, time, hours) => new Date(Date.parse(ci + "T" + (/^\d{2}:\d{2}$/.test(time || "") ? time : "12:00") + ":00+05:30") - (+hours || 0) * 3600e3);
const istStamp = (d) => { const t = new Date(d.getTime() + 330 * 60e3), H = t.getUTCHours(); return t.getUTCDate() + " " + ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][t.getUTCMonth()] + " " + t.getUTCFullYear() + ", " + ((H % 12) || 12) + ":" + String(t.getUTCMinutes()).padStart(2, "0") + (H < 12 ? " AM" : " PM"); };
async function cxlRules(env, ghId) { const {results} = await env.DB.prepare("SELECT * FROM gh_cancel WHERE gh_id = ?").bind(+ghId || 0).all(); return results.map(cxlOut); }
const cxlFor = (rules, roomTypeId) => rules.find((r) => roomTypeId && r.room_type_id === roomTypeId) || rules.find((r) => !r.room_type_id) || null;
const roomTypeOf = (gh, room) => (((gh && gh.room_types) || []).find((t) => expandRooms(t.room_nos).includes(String(room))) || {}).id || 0;
// the policy for one booking, with its own deadline in words
async function cxlPolicy(env, gh, trip) { return gh && gh.id ? cxlPolicyFrom(await cxlRules(env, gh.id), gh, trip) : null; }
function cxlPolicyFrom(rules, gh, trip) {
  const r = cxlFor(rules, roomTypeOf(gh, trip.room)); if (!r) return null;
  const dl = cxlDeadline(trip.check_in, gh.checkin_time, r.free_hours);
  return Object.assign({}, r, {text: cxlText(r), free_until: dl.toISOString(), free_until_text: r.free_hours > 0 ? istStamp(dl) : "",
    line: r.free_hours > 0 ? "Free cancellation until " + istStamp(dl) + "; after that " + cxlCharge(r) + "." : cxlText(r)});
}
// what cancelling now would cost
async function cxlQuote(env, gh, trip, when) {
  const pol = await cxlPolicy(env, gh, trip); if (!pol) return {policy: null, late: false, charge: 0, basis: "No cancellation policy is set for this guest house, so there is no charge."};
  const late = (when || Date.now()) >= Date.parse(pol.free_until);
  if (!late) return {policy: pol, late, charge: 0, basis: "Free cancellation (before " + pol.free_until_text + ")."};
  const c = await ghCost(env, gh.id, roomTypeOf(gh, trip.room), trip.check_in, trip.check_out, 0, trip.plan, trip.occupancy);
  let amt = 0;
  if (pol.charge_type === "fixed") amt = +pol.charge_value || 0;
  else if (pol.charge_type === "full") amt = c.fare + c.fare_tax;
  else if (pol.charge_type === "percent") amt = (c.fare + c.fare_tax) * (+pol.charge_value || 0) / 100;
  else { let left = Math.max(1, Math.round(+pol.charge_value || 1)); for (const sg of c.segments) { const n = Math.min(left, sg.nights); amt += n * sg.fare * (1 + sg.tax_rate); left -= n; if (!left) break; } }
  amt = r2(amt); const nil = c.fare === 0 && c.missing === 0;
  return {policy: pol, late, charge: amt, basis: (pol.free_hours > 0 ? "Cancelled after the free-cancellation time (" + pol.free_until_text + "): " : "") + cxlCharge(pol) + (nil ? " (Nil fare, so ₹0)" : c.missing ? " (some nights have no rate yet)" : "") + "."};
}
async function ratesState(env, ghIds) {
  if (!ghIds.length) return {rates: [], blocks: [], cancels: []};
  const q = "(" + ghIds.map(() => "?").join(",") + ")";
  const [{results: rates}, {results: blocks}] = await Promise.all([env.DB.prepare("SELECT * FROM gh_rates WHERE gh_id IN " + q + " ORDER BY gh_id, from_date DESC, id DESC").bind(...ghIds).all(), env.DB.prepare("SELECT * FROM gh_blocks WHERE gh_id IN " + q + " ORDER BY gh_id, from_date DESC, id DESC").bind(...ghIds).all()]);
  const {results: cx} = await env.DB.prepare("SELECT * FROM gh_cancel WHERE gh_id IN " + q + " ORDER BY gh_id, room_type_id").bind(...ghIds).all();
  return {cancels: cx.map(cxlOut), rates: rates.map((x) => ({id: x.id, gh_id: x.gh_id, room_type_id: x.room_type_id || 0, from: x.from_date, to: x.to_date, plan: planOf(x.plan), nil: !!x.nil, fare: +x.fare || 0, fare_double: +x.fare_double || 0, extra_bed: +x.extra_bed || 0, svc: +x.svc || 0, svc_unit: x.svc_unit || "night", note: x.note || "", by: x.by_email || "", at: x.at || ""})),
    blocks: blocks.map((x) => ({id: x.id, gh_id: x.gh_id, rooms: String(x.rooms || "").split(",").map((s) => s.trim()).filter(Boolean), from: x.from_date, to: x.to_date, reason: x.reason || "", by: x.by_email || "", at: x.at || ""}))};
}
async function ratesApi(env, user, path, b) {
  const gh = await env.DB.prepare("SELECT id, client_id, name FROM guesthouses WHERE id = ?").bind(+b.gh_id || 0).first();
  if (!gh) return json({error: "Choose a guest house."}, 400);
  const now = new Date().toISOString();
  if (path === "/api/admin/rate" || path === "/api/admin/block") {
    const tbl = path.endsWith("rate") ? "gh_rates" : "gh_blocks";
    if (b.delete) { await env.DB.prepare("DELETE FROM " + tbl + " WHERE id = ? AND gh_id = ?").bind(+b.id || 0, gh.id).run(); return json({ok: true}); }
    if (!isoD.test(b.from || "") || !isoD.test(b.to || "") || b.to < b.from) return json({error: "Pick the dates: the end date must be on or after the start date."}, 400);
    if (tbl === "gh_rates") {
      const rt = +b.room_type_id || 0;
      if (rt && !(await env.DB.prepare("SELECT id FROM room_types WHERE id = ? AND gh_id = ?").bind(rt, gh.id).first())) return json({error: "That room type is not in " + gh.name + "."}, 400);
      const money = (v) => Math.round((+v || 0) * 100) / 100, nil = !!b.nil, fare = nil ? 0 : money(b.fare), dbl = nil ? 0 : money(b.fare_double), xb = nil ? 0 : money(b.extra_bed), svc = 0, unit = "booking";   // service charge is set per client
      const plans = [...new Set((Array.isArray(b.plans) ? b.plans : [b.plan]).filter((p) => PLAN_CODES.includes(p)))];
      if (!plans.length) plans.push("EP");   // no plan given: room only
      if (b.id && plans.length > 1) return json({error: "A saved rate has one plan. Add a new rate for the other plans."}, 400);
      if (!nil && !(fare > 0)) return json({error: "Enter the single occupancy price per night, or choose Nil."}, 400);
      if (dbl && dbl < fare) return json({error: "The double occupancy price can't be lower than the single price."}, 400);
      if (fare > 1000000 || dbl > 1000000 || xb > 1000000) return json({error: "Check the amount."}, 400);
      for (const pl of plans) {
        const vals = [rt, b.from, b.to, nil ? 1 : 0, fare, dbl, xb, pl, svc, unit, clean(b.note, 160), user.email, now];
        if (b.id) await env.DB.prepare("UPDATE gh_rates SET room_type_id = ?, from_date = ?, to_date = ?, nil = ?, fare = ?, fare_double = ?, extra_bed = ?, plan = ?, svc = ?, svc_unit = ?, note = ?, by_email = ?, at = ? WHERE id = ? AND gh_id = ?").bind(...vals, +b.id, gh.id).run();
        else await env.DB.prepare("INSERT INTO gh_rates (gh_id, room_type_id, from_date, to_date, nil, fare, fare_double, extra_bed, plan, svc, svc_unit, note, by_email, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(gh.id, ...vals).run(); }
    } else {
      const rooms = (Array.isArray(b.rooms) ? b.rooms : []).map((x) => clean(x, 40)).filter(Boolean).slice(0, 200).join(",");
      const vals = [rooms, b.from, b.to, clean(b.reason, 160), user.email, now];
      if (b.id) await env.DB.prepare("UPDATE gh_blocks SET rooms = ?, from_date = ?, to_date = ?, reason = ?, by_email = ?, at = ? WHERE id = ? AND gh_id = ?").bind(...vals, +b.id, gh.id).run();
      else await env.DB.prepare("INSERT INTO gh_blocks (gh_id, rooms, from_date, to_date, reason, by_email, at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(gh.id, ...vals).run();
    }
    return json({ok: true});
  }
  if (path === "/api/admin/cancel") {
    if (b.delete) { await env.DB.prepare("DELETE FROM gh_cancel WHERE id = ? AND gh_id = ?").bind(+b.id || 0, gh.id).run(); return json({ok: true}); }
    const rt = +b.room_type_id || 0;
    if (rt && !(await env.DB.prepare("SELECT id FROM room_types WHERE id = ? AND gh_id = ?").bind(rt, gh.id).first())) return json({error: "That room type is not in " + gh.name + "."}, 400);
    const hours = Math.round(+b.free_hours), type = CXL_TYPES.includes(b.charge_type) ? b.charge_type : "", val = Math.round((+b.charge_value || 0) * 100) / 100;
    if (!(hours >= 0 && hours <= 720)) return json({error: "Free cancellation must be between 0 and 720 hours (30 days) before check-in."}, 400);
    if (!type) return json({error: "Choose what is charged after the free-cancellation time."}, 400);
    if (type === "nights" && !(val >= 1 && val <= 30)) return json({error: "Enter how many nights are charged (1 to 30)."}, 400);
    if (type === "percent" && !(val > 0 && val <= 100)) return json({error: "Enter a percentage between 1 and 100."}, 400);
    if (type === "fixed" && !(val > 0 && val <= 1000000)) return json({error: "Enter the amount charged."}, 400);
    const ex = await env.DB.prepare("SELECT id FROM gh_cancel WHERE gh_id = ? AND room_type_id = ?").bind(gh.id, rt).first(), id = +b.id || (ex && ex.id) || 0;
    const vals = [rt, hours, type, type === "full" ? 0 : val, clean(b.note, 160), user.email, now];
    if (id) await env.DB.prepare("UPDATE gh_cancel SET room_type_id = ?, free_hours = ?, charge_type = ?, charge_value = ?, note = ?, by_email = ?, at = ? WHERE id = ? AND gh_id = ?").bind(...vals, id, gh.id).run();
    else await env.DB.prepare("INSERT INTO gh_cancel (gh_id, room_type_id, free_hours, charge_type, charge_value, note, by_email, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(gh.id, ...vals).run();
    return json({ok: true});
  }
  if (path === "/api/admin/quote") {
    if (!isoD.test(b.check_in || "") || !isoD.test(b.check_out || "") || b.check_out <= b.check_in) return json({error: "Check-out must be after check-in."}, 400);
    let rt = +b.room_type_id || 0;
    if (!rt && b.room) { const {results} = await env.DB.prepare("SELECT id, room_nos FROM room_types WHERE gh_id = ?").bind(gh.id).all(); const hit = results.find((t) => expandRooms(t.room_nos).includes(String(b.room))); if (hit) rt = hit.id; }
    const cl = await env.DB.prepare("SELECT svc_fee FROM clients WHERE id = ?").bind(gh.client_id).first();
    const rows = await ghRates(env, gh.id, b.check_in, b.check_out);
    return json({cost: ghCostFrom(rows, rt, b.check_in, b.check_out, cl ? cl.svc_fee : 0, b.plan, b.occupancy), room_type_id: rt, plans: plansFrom(rows, rt)});
  }
  return json({error: "Not found."}, 404);
}

/* ---------- Backup ----------
   Every table (except sign-in sessions and reset codes) as one gzip JSON file in the BACKUPS KV namespace.
   Nightly from the cron, or on demand from Admin → Backups. Files older than 30 days are deleted. */
const BACKUP_SKIP = new Set(["_cf_KV", "sqlite_sequence", "sessions", "resets"]), BACKUP_DAYS = 30;
async function backupNow(env, by) {
  if (!env.BACKUPS) return {error: "Backup storage is not set up."};
  const {results: tabs} = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const at = new Date().toISOString(), data = {format: "ltmgh-backup-1", at, by, tables: {}}, counts = {};
  for (const {name} of tabs) { if (BACKUP_SKIP.has(name) || !/^\w+$/.test(name)) continue; const rows = [];
    for (let off = 0; ; off += 1000) { const {results} = await env.DB.prepare('SELECT * FROM "' + name + '" LIMIT 1000 OFFSET ' + off).all(); rows.push(...results); if (results.length < 1000) break; }
    data.tables[name] = rows; counts[name] = rows.length; }
  const raw = new TextEncoder().encode(JSON.stringify(data));
  const gz = await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
  const key = "backup/" + at.replace(/[:.]/g, "-") + ".json.gz", meta = {at, by, bytes: gz.byteLength, raw: raw.byteLength, rows: Object.values(counts).reduce((a, b) => a + b, 0), tables: Object.keys(counts).length};
  await env.BACKUPS.put(key, gz, {metadata: meta});
  const {keys} = await env.BACKUPS.list({prefix: "backup/"});
  for (const k of keys) if (Date.now() - Date.parse((k.metadata || {}).at || 0) > BACKUP_DAYS * 864e5) await env.BACKUPS.delete(k.name);
  return Object.assign({key}, meta);
}
async function backupList(env) {
  if (!env.BACKUPS) return {ready: false, backups: []};
  const {keys} = await env.BACKUPS.list({prefix: "backup/"});
  return {ready: true, keep_days: BACKUP_DAYS, backups: keys.map((k) => Object.assign({key: k.name}, k.metadata || {})).sort((a, b) => String(b.at).localeCompare(String(a.at)))};
}

/* ---------- Audit log ----------
   One row for every change made through the portal (and every sign-in): who, when, what, on which client, from which IP.
   Written after the request has been handled; reads (lists, quotes, previews) are not logged. Secrets and files are never stored. */
const AUDIT_READS = new Set(["/api/admin/state", "/api/admin/quote", "/api/admin/tx/preview", "/api/admin/tx/stored", "/api/admin/tx/uploads", "/api/admin/tx/file", "/api/admin/backups", "/api/admin/backup/download", "/api/admin/audit",
  "/api/manage/state", "/api/admin/sync/state", "/api/admin/sync/test", "/api/tx/voucher", "/api/book/avail", "/api/book/quote", "/api/book/cancel/preview", "/api/trips", "/api/bookings", "/api/guests", "/api/tx"]);
const AUDIT_LABEL = {"/api/login": "Signed in", "/api/forgot": "Asked for a password reset code", "/api/reset": "Reset own password", "/api/vouchers": "Hotel Desk update",
  "/api/book": "Booked a stay", "/api/book/update": "Changed a booking", "/api/book/cancel": "Cancelled a booking", "/api/book/resend": "Sent the booking email",
  "/api/admin/rate": "Saved a rate", "/api/admin/block": "Saved blackout dates", "/api/admin/svc": "Changed the service charge", "/api/admin/cancel": "Saved a cancellation policy", "/api/admin/bulk": "Bulk update",
  "/api/admin/gh": "Saved a guest house", "/api/admin/gh/delete": "Deleted a guest house", "/api/admin/client": "Saved client settings", "/api/admin/client/logo": "Changed the client logo",
  "/api/admin/doc": "Saved a document", "/api/admin/doc/delete": "Deleted a document", "/api/admin/photo": "Added a photo", "/api/admin/photo/delete": "Deleted a photo",
  "/api/admin/booking": "Saved a stay", "/api/admin/booking/delete": "Removed a stay", "/api/admin/booking/restore": "Restored a stay",
  "/api/admin/sync/save": "Changed the live hotel sync settings", "/api/admin/sync/run": "Ran the live hotel sync",
  "/api/admin/tx/import": "Uploaded a hotel report", "/api/admin/tx/undo": "Undid a hotel report upload", "/api/admin/tx/keep": "Kept a possible duplicate", "/api/admin/tx/remove": "Removed a hotel booking", "/api/admin/tx/restore": "Restored a hotel booking",
  "/api/admin/user": "Saved a user", "/api/admin/user/access": "Changed a user's access", "/api/admin/user/reset": "Reset a user's password", "/api/admin/reminders": "Sent document reminders", "/api/admin/backup": "Backed up the data now",
  "/api/manage/user": "Saved a user", "/api/manage/user/access": "Changed a user's access", "/api/manage/user/reset": "Reset a user's password"};
const AUDIT_DROP = /^(password|pw|new_password|new_pw|old_password|current|code|token|relay_key|jwt_secret|pdf|data|file|content|logo|image|photo|csv|rows|xlsx|b64)$/i;
const auditClean = (v, d) => { if (v == null) return v; if (typeof v === "string") return v.length > 160 ? v.slice(0, 160) + "…" : v; if (typeof v !== "object") return v; if (d > 2) return "…";
  if (Array.isArray(v)) return v.length > 12 ? v.slice(0, 12).map((x) => auditClean(x, d + 1)).concat(["… " + (v.length - 12) + " more"]) : v.map((x) => auditClean(x, d + 1));
  const o = {}; for (const [k, x] of Object.entries(v)) { if (AUDIT_DROP.test(k)) { if (x) o[k] = "(not stored)"; continue; } o[k] = auditClean(x, d + 1); } return o; };
async function auditBody(request, path) {
  if (request.method !== "POST" || !path.startsWith("/api/") || AUDIT_READS.has(path)) return null;
  try { const t = await request.clone().text(); return t.length > 200000 ? {_size: t.length} : JSON.parse(t || "{}"); } catch (e) { return {}; }
}
async function auditWrite(env, request, path, body, res) {
  try {
    const login = path === "/api/login", ok = res.status < 400;
    if (!ok && !login) return;   // refused requests change nothing (failed sign-ins are kept)
    await ensureSchema(env); let u = null; if (!login) u = await currentUser(request, env).catch(() => null);
    const email = login || path === "/api/forgot" || path === "/api/reset" ? String(body.email || "").toLowerCase().slice(0, 120) : path === "/api/vouchers" ? "Zuna Hotel Desk" : u ? u.email : "";
    let action = AUDIT_LABEL[path] || path.replace(/^\/api\//, "");
    if (login && !ok) action = "Sign-in failed";
    if (body.delete) action = action.replace(/^Saved an? /, "Deleted a ").replace(/^Saved blackout dates/, "Removed blackout dates");
    const tgt = [body.property, body.name && !login ? body.name : "", body.email && !login && path !== "/api/forgot" && path !== "/api/reset" ? body.email : "", body.code, body.id ? "#" + body.id : ""].filter(Boolean).join(" · ").slice(0, 200);
    if (login && ok) { const r = await env.DB.prepare("SELECT role, client_id FROM users WHERE email = ?").bind(email).first(); if (r) u = {email, admin: r.role === "admin", manager: r.role === "client_admin", client_id: r.client_id}; }
    const cid = +body.client_id || (u && u.client_id) || null;
    await env.DB.prepare("INSERT INTO audit (at, email, role, client_id, action, target, detail, ip, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(new Date().toISOString(), email, u ? (u.admin ? "Zuna admin" : u.manager ? "Client admin" : "Client user") : login ? "" : "System", cid, action, tgt, JSON.stringify(auditClean(body, 0)).slice(0, 4000), request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "", ok ? 1 : 0).run();
  } catch (e) { /* the log must never break a request */ }
}
async function auditList(env, b) {
  const w = [], p = [];
  if (b.from && isoD.test(b.from)) { w.push("at >= ?"); p.push(b.from); }
  if (b.to && isoD.test(b.to)) { w.push("at < ?"); p.push(new Date(Date.parse(b.to) + 864e5).toISOString().slice(0, 10)); }
  if (b.client_id) { w.push("client_id = ?"); p.push(+b.client_id); }
  if (b.kind === "signin") w.push("action IN ('Signed in', 'Sign-in failed')"); else if (b.kind === "bookings") w.push("action IN ('Booked a stay', 'Changed a booking', 'Cancelled a booking', 'Sent the booking email')");
  else if (b.kind === "rates") w.push("(action LIKE '%rate%' OR action LIKE '%blackout%' OR action LIKE '%service charge%' OR action LIKE '%cancellation%')"); else if (b.kind === "changes") w.push("action NOT IN ('Signed in', 'Sign-in failed')");
  if (b.q) { const q = "%" + String(b.q).slice(0, 80).replace(/[%_]/g, "") + "%"; w.push("(email LIKE ? OR action LIKE ? OR target LIKE ? OR detail LIKE ?)"); p.push(q, q, q, q); }
  if (b.before) { w.push("id < ?"); p.push(+b.before); }
  const lim = Math.min(+b.limit || 100, 5000);
  const {results} = await env.DB.prepare("SELECT * FROM audit" + (w.length ? " WHERE " + w.join(" AND ") : "") + " ORDER BY id DESC LIMIT " + (lim + 1)).bind(...p).all();
  return {rows: results.slice(0, lim).map((x) => ({id: x.id, at: x.at, email: x.email || "", role: x.role || "", client_id: x.client_id, action: x.action, target: x.target || "", detail: jparse(x.detail, {}), ip: x.ip || "", ok: !!x.ok})), more: results.length > lim};
}

/* ---------- Book a room + Trips ----------
   Bookings made in the portal are confirmed instantly. Each one is written into the stay data exactly like an
   admin-panel booking (live `bookings` + `manual`), so the Room rack, reports and the hourly email update all see it:
   the updater matches a later guest-house email by guest + check-in and keeps this booking. The `trips` table keeps
   who booked, contact details, e-mail copies and the history. */
const emailList = (s) => [...new Set(String(s || "").split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))].slice(0, 20);
const dayAfter = (d) => new Date(Date.parse(d) + 864e5).toISOString().slice(0, 10);
const genderRow = (x) => /^(m|male)$/i.test(x.gender || "") ? "Male" : /^(f|female)$/i.test(x.gender || "") ? "Female" : /^\s*mr\b/i.test(x.guest || "") ? "Male" : /^\s*(ms|mrs|miss)\b/i.test(x.guest || "") ? "Female" : "Not stated";
const time12 = (t) => { const m = String(t || "").match(/^(\d{1,2}):(\d{2})/); if (!m) return ""; const H = +m[1]; return ((H % 12) || 12) + ":" + m[2] + (H < 12 ? " AM" : " PM"); };
const fmtD = (d) => { const t = new Date(d + "T00:00:00Z"); return t.getUTCDate() + " " + ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][t.getUTCMonth()] + " " + t.getUTCFullYear(); };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"})[c]);
async function bookClient(env, cid) { return env.DB.prepare("SELECT id, name, grades, legal_name, mail_cc, mail_bcc, elig FROM clients WHERE id = ? AND active = 1").bind(+cid || 0).first(); }
// every room of a guest house with its state for the chosen nights: free, shared (a double room with space left) or full
async function roomAvailability(env, client, property, ci, co, skipKey) {
  const gh = (await clientGuestHouses(env, client, true)).find((g) => g.property === property);
  if (!gh) return {error: "Pick one of " + client.name + "'s guest houses."};
  const bk = await readSet(env, "bookings");
  const stays = bk.rows.filter((x) => x.property === property && x.status === "Confirmed" && x.check_in < co && x.check_out > ci && guestKey(x) !== skipKey);
  const rooms = [];
  (gh.room_types || []).forEach((t) => expandRooms(t.room_nos).forEach((rn) => rooms.push({room: rn, type: t.name || "", type_id: t.id || 0, occupancy: t.occupancy || "Single", bed_type: t.bed_type || "", grades: t.grades || []})));
  if (!rooms.length) (gh.rooms_list || []).forEach((rn) => rooms.push({room: rn, type: "", occupancy: "Single", bed_type: "", grades: []}));
  rooms.sort((a, b) => a.room.localeCompare(b.room, "en", {numeric: true}));
  rooms.forEach((r) => { const g = stays.filter((x) => x.room === r.room); let peak = 0;
    for (let d = ci; d < co; d = dayAfter(d)) peak = Math.max(peak, g.filter((x) => x.check_in <= d && x.check_out > d).length);
    r.capacity = /double|twin|shar/i.test(r.occupancy) ? 2 : 1;
    r.state = peak === 0 ? "free" : peak < r.capacity ? "shared" : "full";
    r.guests = g.map((x) => ({gender: genderRow(x), check_in: x.check_in, check_out: x.check_out})); });
  const blocks = await ghBlocks(env, gh.id, ci, co);   // blackout dates set by Zuna
  rooms.forEach((r) => { r.blocks = blocksFor(blocks, r.room).map((x) => ({from: x.from, to: x.to, reason: x.reason})); if (r.blocks.length) r.state = "blocked"; });
  const listed = new Set(rooms.map((r) => r.room));
  return {gh, rooms, nights: Math.round((Date.parse(co) - Date.parse(ci)) / 864e5), unassigned: stays.filter((x) => !listed.has(x.room)).length};
}
function tripInput(b, client, isNew) {
  const iso = /^\d{4}-\d{2}-\d{2}$/, t = {property: clean(b.property, 120), check_in: String(b.check_in || ""), check_out: String(b.check_out || ""), room: clean(b.room, 40),
    title: ["Mr.", "Ms.", "Mrs.", "Dr."].includes(b.title) ? b.title : "", name: clean(b.name, 100).replace(/^\s*(mr|mrs|ms|miss|dr)\b\.?\s*/i, ""), grade: clean(b.grade, 20),
    emp_code: clean(b.emp_code, 30), email: emailList(b.email)[0] || "", phone: clean(b.phone, 20).replace(/[^\d+\-\s]/g, ""), base: clean(b.base, 60), concur_tr: clean(b.concur_tr, 40), wbs: clean(b.wbs, 60),
    occupancy: b.occupancy === "Double" ? "Double" : "Single", plan: PLAN_CODES.includes(b.plan) ? b.plan : "", note: clean(b.note, 300), cc: emailList(client.mail_cc).join(", "), bcc: emailList(client.mail_bcc).join(", ")};   // email copies are set by Zuna in Client settings, never by the booker
  t.gender = ["Male", "Female"].includes(b.gender) ? b.gender : t.title === "Mr." ? "Male" : t.title === "Ms." || t.title === "Mrs." ? "Female" : "";
  if (!t.property) return {err: "Choose the guest house."};
  if (!iso.test(t.check_in) || !iso.test(t.check_out) || t.check_out <= t.check_in) return {err: "Check-out must be after check-in."};
  if (isNew && t.check_in < istToday()) return {err: "Check-in can't be in the past."};
  if ((Date.parse(t.check_out) - Date.parse(t.check_in)) / 864e5 > 90) return {err: "Book up to 90 nights at a time."};
  if (!t.name) return {err: "Enter the guest's name."};
  if (!t.gender) return {err: "Choose the guest's gender (it decides who can share a room)."};
  if (!t.grade) return {err: "Choose the guest's grade."};
  if (!String(b.email || "").trim()) return {err: "Enter the guest's email address."};
  if (!t.email) return {err: "The guest's email address doesn't look right."};
  if (t.phone.replace(/\D/g, "").length < 8) return {err: "Enter the guest's mobile number."};
  return {t};
}
const guestOf = (t) => (t.title ? t.title + " " : "") + t.name;
// pick or check the room, write the stay, keep the trip, send the email
async function placeTrip(env, user, cid, b, trip) {
  const client = await bookClient(env, cid); if (!client) return json({error: "No such client."}, 404);
  const v = tripInput(b, client, !trip); if (v.err) return json({error: v.err}, 400); const t = v.t;
  const el = eligOf(client), ok = el && el[t.gender];
  if (ok && ok.length && !ok.includes(t.grade)) return json({error: "Grade " + t.grade + " is not eligible for a guest house stay (" + t.gender.toLowerCase() + " guests: " + gradeText(ok, (client.grades || DEFAULT_GRADES).split(",")) + ")."}, 400);
  const oldKey = trip ? guestKey({guest: guestOf(trip), check_in: trip.check_in}) : null;
  const av = await roomAvailability(env, client, t.property, t.check_in, t.check_out, oldKey); if (av.error) return json({error: av.error}, 400);
  const fits = (r) => !r.grades.length || r.grades.includes(t.grade);
  const sharable = (r) => r.state === "shared" && r.guests.every((g) => g.gender === t.gender);
  let room;
  if (t.room) { room = av.rooms.find((r) => r.room === t.room); if (!room) return json({error: "Room " + t.room + " is not in " + t.property + "."}, 400);
    if (!fits(room)) return json({error: "Room " + room.room + (room.type ? " (" + room.type + ")" : "") + " is for grades " + room.grades.join(", ") + " only."}, 400);
    if (room.state === "blocked") { const k = room.blocks[0]; return json({error: "Room " + room.room + " is not available from " + fmtD(k.from) + " to " + fmtD(k.to) + (k.reason ? " (" + k.reason + ")" : "") + ". Choose another room or other dates."}, 409); }
    if (room.state === "full") return json({error: "Room " + room.room + " is already taken on some of these nights. Choose another room."}, 409);
    if (room.state === "shared" && !sharable(room)) return json({error: "Room " + room.room + " is shared with a guest of another gender on these nights. Choose another room."}, 409); }
  else { room = av.rooms.find((r) => r.state === "free" && fits(r)) || (t.occupancy === "Double" ? av.rooms.find((r) => sharable(r) && fits(r)) : null);
    if (!room) return json({error: "No room in " + t.property + " is free for these nights for grade " + t.grade + "."}, 409); }
  if (room.state === "shared") t.occupancy = "Double";
  t.room = room.room;
  // rate plan: one of the plans priced for this room type on these nights (the first one if none was chosen)
  if (av.gh && av.gh.id) { const offered = plansFrom(await ghRates(env, av.gh.id, t.check_in, t.check_out), room.type_id);
    if (offered.length && !offered.includes(t.plan)) { if (t.plan) return json({error: "The " + t.plan + " plan is not offered for room " + room.room + " on these dates. Choose " + offered.join(", ") + "."}, 400); t.plan = offered[0]; } }
  // the same guest must not have another stay on these nights
  const bk = await readSet(env, "bookings"), names = new Set((await clientGuestHouses(env, client, true)).map((g) => g.property)), me = nameKey(t.name);
  const clash = bk.rows.find((x) => names.has(x.property) && x.status === "Confirmed" && nameKey(x.guest) === me && x.check_in < t.check_out && x.check_out > t.check_in && guestKey(x) !== oldKey);
  if (clash) return json({error: guestOf(t) + " already has a stay at " + clash.property + " from " + fmtD(clash.check_in) + " to " + fmtD(clash.check_out) + "."}, 409);
  const res = await saveBooking(env, client, {row: Object.assign({}, t, {status: "Confirmed"}), original: trip ? {guest: guestOf(trip), check_in: trip.check_in} : null});
  if (!res.ok) return res;
  const newKey = t.property + "|" + guestKey({guest: guestOf(t), check_in: t.check_in});
  if (trip && trip.code) {   // keep the same ZUNA code when a booking is changed
    const oldCodeKey = trip.property + "|" + oldKey; if (oldCodeKey !== newKey) { await env.DB.prepare("DELETE FROM gh_codes WHERE key = ?").bind(newKey).run(); await env.DB.prepare("UPDATE gh_codes SET key = ? WHERE key = ?").bind(newKey, oldCodeKey).run(); } }
  const stay = {property: t.property, guest: guestOf(t), check_in: t.check_in}; await ghCodes(env, [stay]); const code = stay.booking_code || (trip && trip.code) || "";
  const now = new Date().toISOString(), hist = trip ? jparse(trip.history, []) : [];
  hist.push({at: now, by: user.email, what: trip ? "Changed" : "Booked", detail: t.property + " · room " + t.room + " · " + fmtD(t.check_in) + " → " + fmtD(t.check_out)});
  const cols = ["code", "property", "room", "title", "name", "gender", "grade", "emp_code", "email", "phone", "base", "concur_tr", "wbs", "occupancy", "plan", "check_in", "check_out", "note", "cc", "bcc"], vals = cols.map((k) => k === "code" ? code : t[k]);
  let id;
  if (trip) { await env.DB.prepare("UPDATE trips SET " + cols.map((k) => k + " = ?").join(", ") + ", changed_by = ?, changed_at = ?, history = ? WHERE id = ?").bind(...vals, user.email, now, JSON.stringify(hist), trip.id).run(); id = trip.id; }
  else { const r = await env.DB.prepare("INSERT INTO trips (client_id, " + cols.join(", ") + ", status, booked_by, booked_at, history) VALUES (?, " + cols.map(() => "?").join(", ") + ", 'Confirmed', ?, ?, ?)").bind(client.id, ...vals, user.email, now, JSON.stringify(hist)).run(); id = r.meta ? r.meta.last_row_id : r.lastInsertRowid; }
  await saveGuest(env, client.id, t);
  const saved = await env.DB.prepare("SELECT * FROM trips WHERE id = ?").bind(id).first();
  const mail = b.send_mail === false ? "not sent" : b.mail_later ? "pending" : await tripMail(env, client, saved, av.gh, trip ? "changed" : "confirmed");
  await env.DB.prepare("UPDATE trips SET mail_status = ? WHERE id = ?").bind(mail, id).run();
  const pol = await cxlPolicy(env, av.gh, saved);
  return json({ok: true, trip: Object.assign(tripOut(Object.assign(saved, {mail_status: mail}), user.admin), {helpdesk: helpdeskOf(av.gh), cancel_policy: pol ? pol.line : ""})});
}
// guest house helpdesk for the voucher: the guest house's contacts from the directory
const helpdeskOf = (gh) => ((gh && gh.contacts) || []).filter((c) => c.phone || c.email).slice(0, 4).map((c) => ({name: c.name || '', designation: c.designation || '', phone: c.phone || '', email: c.email || ''}));
const tripOut = (x, admin) => ({id: x.id, code: x.code || "", property: x.property, room: x.room, title: x.title || "", name: x.name, guest: guestOf(x), gender: x.gender, grade: x.grade, emp_code: x.emp_code || "", email: x.email || "", phone: x.phone || "",
  base: x.base || "", concur_tr: x.concur_tr || "", wbs: x.wbs || "", occupancy: x.occupancy, plan: x.plan || "", plan_label: planLabel(x.plan), check_in: x.check_in, check_out: x.check_out, note: x.note || "", status: x.status, cc: admin ? x.cc || "" : "", bcc: admin ? x.bcc || "" : "",
  booked_by: x.booked_by, booked_at: x.booked_at, changed_by: x.changed_by || "", changed_at: x.changed_at || "", cancelled_by: x.cancelled_by || "", cancelled_at: x.cancelled_at || "", cancel_reason: x.cancel_reason || "", cancel_charge: x.cancel_charge == null ? null : +x.cancel_charge, cancel_basis: x.cancel_basis || "", mail_status: x.mail_status || "", history: jparse(x.history, [])});
async function tripFor(env, user, cid, id) { return env.DB.prepare("SELECT * FROM trips WHERE id = ? AND client_id = ?").bind(+id || 0, cid).first(); }
async function cancelTrip(env, user, cid, b) {
  const trip = await tripFor(env, user, cid, b.id); if (!trip) return json({error: "Booking not found."}, 404);
  if (trip.status === "Cancelled") return json({error: "This booking is already cancelled."}, 409);
  if (trip.check_out <= istToday()) return json({error: "This stay has already ended."}, 409);
  const client = await bookClient(env, cid), gh = (await clientGuestHouses(env, client, true)).find((g) => g.property === trip.property) || {property: trip.property};
  const cq = await cxlQuote(env, gh, trip), waive = !!(b.waive && user.admin && cq.charge > 0), charge = waive ? 0 : cq.charge, basis = waive ? "Waived by Zuna (would have been ₹" + cq.charge.toLocaleString("en-IN") + ")" : cq.basis;
  const res = await cancelBooking(env, client, {guest: guestOf(trip), check_in: trip.check_in}); if (!res.ok && res.status !== 404) return res;
  const now = new Date().toISOString(), hist = jparse(trip.history, []), reason = clean(b.reason, 200); hist.push({at: now, by: user.email, what: "Cancelled", detail: [reason, "charge ₹" + charge.toLocaleString("en-IN") + (waive ? " (waived)" : "")].filter(Boolean).join(" · ")});
  await env.DB.prepare("UPDATE trips SET status = 'Cancelled', cancelled_by = ?, cancelled_at = ?, cancel_reason = ?, cancel_charge = ?, cancel_basis = ?, history = ? WHERE id = ?").bind(user.email, now, reason, charge, basis, JSON.stringify(hist), trip.id).run();
  const saved = await env.DB.prepare("SELECT * FROM trips WHERE id = ?").bind(trip.id).first();
  const mail = b.send_mail === false ? "not sent" : await tripMail(env, client, saved, gh, "cancelled");
  await env.DB.prepare("UPDATE trips SET mail_status = ? WHERE id = ?").bind(mail, trip.id).run();
  return json({ok: true, trip: Object.assign(tripOut(Object.assign(saved, {mail_status: mail}), user.admin), {helpdesk: helpdeskOf(gh)})});
}
// confirmation / change / cancellation e-mail to the guest, copies to the CC and BCC addresses
async function tripMail(env, client, trip, gh, kind, pdf) {
  const to = emailList(trip.email), cc = emailList(trip.cc).concat(emailList(gh.team_emails)).filter((e, i, a) => !to.includes(e) && a.indexOf(e) === i), bcc = emailList(trip.bcc).filter((e) => !to.includes(e) && !cc.includes(e));
  if (!to.length && !cc.length) return "no email address";
  if (!env.RESEND_API_KEY) return "not sent (email not set up)";
  const nights = Math.round((Date.parse(trip.check_out) - Date.parse(trip.check_in)) / 864e5), dow = (d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(d + "T00:00:00Z").getUTCDay()] + ", " + fmtD(d);
  const K = {confirmed: {head: "Your stay is confirmed", tag: "CONFIRMED", bg: "#02C988", fg: "#0b0033", subj: "Booking confirmed"},
    changed: {head: "Your booking has been changed", tag: "CHANGED", bg: "#F5B83D", fg: "#2b1a00", subj: "Booking changed"},
    cancelled: {head: "Your booking has been cancelled", tag: "CANCELLED", bg: "#F06B7A", fg: "#ffffff", subj: "Booking cancelled"}}[kind];
  const subject = K.subj + " · " + trip.property + " · " + fmtD(trip.check_in) + " – " + fmtD(trip.check_out) + " · " + (trip.code || "");
  const pol = kind !== "cancelled" ? await cxlPolicy(env, gh, trip).catch(() => null) : null;
  const att = pdf && pdf.content && kind !== "cancelled" ? [{filename: pdf.filename || "Voucher.pdf", content: pdf.content, content_type: "application/pdf"}] : [];
  const live = kind !== "cancelled", L = "font-size:10.5px;letter-spacing:1.2px;font-weight:700;color:#6b6496";
  const rows = [["Guest", guestOf(trip) + (trip.grade ? " · " + trip.grade : "")], ["Room", trip.room + " · " + (trip.occupancy === "Double" ? "Double occupancy (shared)" : "Single occupancy")], ["Meal plan", planLabel(trip.plan)], kind !== "cancelled" && pol ? ["Cancellation", pol.line] : null,
    kind === "cancelled" && trip.cancel_charge != null ? ["Cancellation charge", (+trip.cancel_charge ? "₹" + (+trip.cancel_charge).toLocaleString("en-IN") : "No charge") + (trip.cancel_basis ? " · " + trip.cancel_basis : "")] : null,
    ["Employee code", trip.emp_code || ""], ["Remarks", trip.note || ""], kind === "cancelled" ? ["Reason", trip.cancel_reason || ""] : null].filter((r) => r && r[1]);
  const c0 = helpdeskOf(gh)[0];
  const ln = (t, st) => t ? '<div style="' + (st || "color:#4a4475") + '">' + esc(t) + '</div>' : "";
  const html = '<!doctype html><html><body style="margin:0;background:#f1effa;font-family:Inter,Segoe UI,Arial,sans-serif;color:#12005A">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 12px"><table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">'
    + '<tr><td style="padding:0 4px 14px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font-size:22px;font-weight:800;letter-spacing:-.5px;color:#12005A">zuna<span style="color:#02C988">.</span></td>'
    + '<td align="right" style="font-size:12px;color:#6b6496">' + esc(client.name || "") + ' · Guest house booking</td></tr></table></td></tr>'
    + '<tr><td style="background:#ffffff;border-radius:18px;border:1px solid #e4e0f3;overflow:hidden"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">'
    + '<tr><td style="background:#12005A;padding:22px 28px;border-radius:18px 18px 0 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td>'
    + '<div style="display:inline-block;background:' + K.bg + ';color:' + K.fg + ';font-size:11px;font-weight:800;letter-spacing:1.4px;padding:4px 10px;border-radius:99px">' + K.tag + '</div>'
    + '<div style="color:#ffffff;font-size:22px;font-weight:800;margin-top:10px">' + esc(K.head) + '</div>'
    + '<div style="color:#c9c2ec;font-size:13px;margin-top:3px">' + esc(guestOf(trip)) + (att.length ? ' · voucher attached as PDF' : '') + '</div></td>'
    + '<td align="right" valign="top"><div style="color:#c9c2ec;' + L.replace("color:#6b6496", "") + '">BOOKING CODE</div><div style="color:#ffffff;font-size:20px;font-weight:800;letter-spacing:.5px;margin-top:4px">' + esc(trip.code || "—") + '</div></td></tr></table></td></tr>'
    + '<tr><td style="padding:22px 28px 6px"><div style="font-size:19px;font-weight:800">' + esc(trip.property) + '</div>' + ln(gh.address || gh.city || "", "font-size:13px;color:#6b6496;margin-top:3px") + '</td></tr>'
    + '<tr><td style="padding:14px 28px 4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f5fc;border-radius:14px"><tr>'
    + '<td style="padding:14px 18px" width="42%"><div style="' + L + '">CHECK-IN</div><div style="font-size:17px;font-weight:800;margin-top:4px">' + esc(dow(trip.check_in)) + '</div>' + ln(gh.checkin_time ? "from " + time12(gh.checkin_time) : "", "font-size:12.5px;color:#6b6496;margin-top:2px") + '</td>'
    + '<td align="center" width="16%"><div style="display:inline-block;border:1px solid #d9d4ef;border-radius:99px;padding:5px 10px;font-size:12px;font-weight:700;color:#12005A;background:#fff;white-space:nowrap">' + nights + (nights === 1 ? " night" : " nights") + '</div></td>'
    + '<td style="padding:14px 18px" align="right" width="42%"><div style="' + L + '">CHECK-OUT</div><div style="font-size:17px;font-weight:800;margin-top:4px">' + esc(dow(trip.check_out)) + '</div>' + ln(gh.checkout_time ? "by " + time12(gh.checkout_time) : "", "font-size:12.5px;color:#6b6496;margin-top:2px") + '</td></tr></table></td></tr>'
    + '<tr><td style="padding:14px 28px 4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">'
    + rows.map(([k, v], n) => { const bd = n < rows.length - 1 ? "border-bottom:1px solid #efedf7;" : ""; return '<tr><td style="padding:8px 0;color:#6b6496;width:140px;vertical-align:top;' + bd + '">' + esc(k) + '</td><td style="padding:8px 0;font-weight:700;' + bd + '">' + esc(v) + '</td></tr>'; }).join("")
    + '</table></td></tr>'
    + (live && gh.map_url ? '<tr><td style="padding:16px 28px 4px"><a href="' + esc(gh.map_url) + '" style="display:inline-block;background:#12005A;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:11px 18px;border-radius:12px;border-bottom:3px solid #02C988">Open in Google Maps</a></td></tr>' : '')
    + '<tr><td style="padding:18px 28px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e4e0f3;border-radius:14px"><tr>'
    + (live && c0 ? '<td style="padding:14px 16px;font-size:13px;vertical-align:top;border-right:1px solid #e4e0f3" width="50%"><div style="' + L + '">GUEST HOUSE HELPDESK</div>' + ln(c0.name + (c0.designation ? " · " + c0.designation : ""), "font-weight:700;margin-top:5px") + ln(c0.phone) + ln(c0.email) + '</td>' : '')
    + '<td style="padding:14px 16px;font-size:13px;vertical-align:top"><div style="' + L + '">ZUNA SUPPORT</div><div style="font-weight:700;margin-top:5px">Zuna Hotel Desk</div><div style="color:#4a4475">+91 91009 90530</div><div style="color:#4a4475">hotel@zuna.ai</div></td></tr></table></td></tr>'
    + '</table></td></tr>'
    + '<tr><td style="padding:16px 6px;font-size:12px;color:#7d76a8;line-height:1.5">' + (live ? (att.length ? 'Please show the attached voucher or this email at check-in. ' : 'Please show this email at check-in. ') + 'To change or cancel the booking, contact Zuna support.' : 'If this is not expected, contact Zuna support.') + '<br>Zuna Travel Solutions</td></tr>'
    + '</table></td></tr></table></body></html>';
  const text = K.head + "\n\nBooking code: " + (trip.code || "") + "\nGuest house: " + trip.property + (gh.address ? ", " + gh.address : "") + "\nCheck-in: " + dow(trip.check_in) + (gh.checkin_time ? ", from " + time12(gh.checkin_time) : "")
    + "\nCheck-out: " + dow(trip.check_out) + (gh.checkout_time ? ", by " + time12(gh.checkout_time) : "") + "\nNights: " + nights + "\n" + rows.map(([k, v]) => k + ": " + v).join("\n")
    + (live && c0 ? "\n\nGuest house helpdesk: " + [c0.name, c0.phone, c0.email].filter(Boolean).join(" · ") : "") + "\nZuna support: +91 91009 90530 · hotel@zuna.ai\n\nZuna Travel Solutions";
  const main = to.length ? to : cc.slice(0, 1), copies = to.length ? cc : cc.slice(1);
  try { const r = await fetch("https://api.resend.com/emails", {method: "POST", headers: {authorization: "Bearer " + env.RESEND_API_KEY, "content-type": "application/json"},
      body: JSON.stringify(Object.assign({from: env.MAIL_FROM || "Zuna Hotel Desk <noreply@zuna.ai>", to: main, subject, html, text}, copies.length ? {cc: copies} : {}, bcc.length ? {bcc} : {}, att.length ? {attachments: att} : {}))});
    return r.ok ? "sent" : "failed"; } catch (e) { return "failed"; }
}
// guest list: one row per person (employee code, else name + email), newest details win
const guestKeyOf = (t) => t.emp_code ? "E:" + String(t.emp_code).trim().toLowerCase() : "N:" + nameKey(t.name) + "|" + String(t.email || "").toLowerCase();
async function saveGuest(env, cid, t) {
  if (!t.name) return; const key = guestKeyOf(t), now = new Date().toISOString();
  if (t.emp_code) await env.DB.prepare("DELETE FROM guests WHERE client_id = ? AND gkey = ?").bind(cid, "N:" + nameKey(t.name) + "|" + String(t.email || "").toLowerCase()).run();   // an older entry without the employee code
  await env.DB.prepare("INSERT INTO guests (client_id, gkey, title, name, gender, email, phone, grade, emp_code, base, uses, last_used) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT (client_id, gkey) DO UPDATE SET title = excluded.title, name = excluded.name, gender = excluded.gender, email = COALESCE(NULLIF(excluded.email, ''), guests.email), phone = COALESCE(NULLIF(excluded.phone, ''), guests.phone), grade = excluded.grade, emp_code = excluded.emp_code, base = COALESCE(NULLIF(excluded.base, ''), guests.base), uses = guests.uses + 1, last_used = excluded.last_used")
    .bind(cid, key, t.title || "", t.name, t.gender || "", t.email || "", t.phone || "", t.grade || "", t.emp_code || "", t.base || "", now).run();
}
async function findGuests(env, client, q) {
  const out = [], seen = new Set(), add = (g) => { const k = nameKey(g.name); if (!k || seen.has(k)) return; seen.add(k); out.push(g); };
  const pick = (r) => ({title: r.title || "", name: r.name, gender: r.gender || "", email: r.email || "", phone: r.phone || "", grade: r.grade || "", emp_code: r.emp_code || "", base: r.base || "", last: (r.last_used || "").slice(0, 10), uses: r.uses || 0, saved: true});
  const term = String(q || "").trim().toLowerCase().slice(0, 60);
  if (term.length < 3) { const {results} = await env.DB.prepare("SELECT * FROM guests WHERE client_id = ? ORDER BY last_used DESC LIMIT 8").bind(client.id).all(); results.forEach((r) => add(pick(r))); return out; }
  const like = "%" + term.replace(/[%_]/g, "") + "%";
  const {results} = await env.DB.prepare("SELECT * FROM guests WHERE client_id = ? AND (lower(name) LIKE ? OR lower(emp_code) LIKE ? OR lower(email) LIKE ?) ORDER BY uses DESC, last_used DESC LIMIT 8").bind(client.id, like, like, like).all();
  results.forEach((r) => add(pick(r)));
  if (out.length < 8) {   // past stays in the stay data (e.g. from guest house emails) as extra suggestions
    const names = new Set((await clientGuestHouses(env, client, false)).map((g) => g.property)), bk = await readSet(env, "bookings");
    bk.rows.filter((x) => names.has(x.property) && String(x.guest || "").toLowerCase().includes(term)).sort((a, b) => (a.check_in < b.check_in ? 1 : -1)).forEach((x) => { if (out.length >= 8) return;
      const m = String(x.guest).match(/^\s*(Mr|Ms|Mrs|Miss|Dr)\.?\s+(.*)$/i), title = m ? ({mr: "Mr.", ms: "Ms.", mrs: "Mrs.", miss: "Ms.", dr: "Dr."})[m[1].toLowerCase()] : "";
      add({title, name: (m ? m[2] : x.guest).trim(), gender: /^(Male|Female)$/.test(x.gender || "") ? x.gender : "", email: "", phone: "", grade: /not stated/i.test(x.grade || "") ? "" : x.grade || "", emp_code: x.emp_code || "", base: /not stated/i.test(x.base || "") ? "" : x.base || "", last: x.check_in, uses: 0, saved: false}); });
  }
  return out;
}
async function bookApi(req, env, user, path) {
  let b; try { b = await req.json(); } catch (e) { return json({error: "Bad request."}, 400); }
  const cid = user.admin ? +b.client_id : user.client_id; if (!cid) return json({error: "No client."}, 400);
  if (path === "/api/trips") { if (!user.book && !user.manager) return json({error: "You don't have access to bookings. Ask your admin."}, 403);
    const {results} = await env.DB.prepare("SELECT * FROM trips WHERE client_id = ? ORDER BY check_in DESC, id DESC LIMIT 3000").bind(cid).all(); const gl = await clientGuestHouses(env, await bookClient(env, cid) || {id: cid}, true), ghs = new Map(gl.map((g) => [g.property, g]));
    const ids = gl.map((g) => g.id).filter(Boolean), cx = ids.length ? (await env.DB.prepare("SELECT * FROM gh_cancel WHERE gh_id IN (" + ids.map(() => "?").join(",") + ")").bind(...ids).all()).results.map(cxlOut) : [];
    return json({trips: results.map((t) => { const g = ghs.get(t.property), pol = g && t.status !== "Cancelled" ? cxlPolicyFrom(cx.filter((r) => r.gh_id === g.id), g, t) : null;
      return Object.assign(tripOut(t, user.admin), {helpdesk: g ? helpdeskOf(g) : [], cancel_policy: pol ? pol.line : ""}); })}); }
  if (path === "/api/bookings") {   // fresh stay list for the dashboard after a booking changes
    const client = await bookClient(env, cid); if (!client) return json({error: "No client."}, 404);
    const names = new Set((await clientGuestHouses(env, client, false)).map((g) => g.property)), bk = await readSet(env, "bookings");
    const rows = bk.rows.filter((x) => names.has(x.property) && x.status !== "Cancelled"); await ghCodes(env, rows); return json({bookings: rows}); }
  if (!user.book) return json({error: "You can't book rooms yet. Ask your admin to switch on Book rooms for you."}, 403);
  if (path === "/api/guests") { const client = await bookClient(env, cid); if (!client) return json({error: "No client."}, 404); return json({guests: await findGuests(env, client, b.q)}); }
  if (path === "/api/book/avail") { const client = await bookClient(env, cid); if (!client) return json({error: "No such client."}, 404);
    const iso = /^\d{4}-\d{2}-\d{2}$/; if (!iso.test(b.check_in || "") || !iso.test(b.check_out || "") || b.check_out <= b.check_in) return json({error: "Check-out must be after check-in."}, 400);
    let skip = null; if (b.exclude_id) { const tr = await tripFor(env, user, cid, b.exclude_id); if (tr) skip = guestKey({guest: guestOf(tr), check_in: tr.check_in}); }
    const av = await roomAvailability(env, client, clean(b.property, 120), b.check_in, b.check_out, skip); if (av.error) return json({error: av.error}, 400);
    return json({rooms: av.rooms, nights: av.nights, unassigned: av.unassigned}); }
  if (path === "/api/book/quote") {   // charges for a stay, shown while booking: fare (or Nil), tax, the client's service charge and GST
    const client = await bookClient(env, cid); if (!client) return json({error: "No such client."}, 404);
    if (!isoD.test(b.check_in || "") || !isoD.test(b.check_out || "") || b.check_out <= b.check_in) return json({error: "Check-out must be after check-in."}, 400);
    const gh = (await clientGuestHouses(env, client, true)).find((g) => g.property === clean(b.property, 120)); if (!gh) return json({error: "Pick one of " + client.name + "'s guest houses."}, 400);
    const rt = b.room ? ((gh.room_types || []).find((t) => expandRooms(t.room_nos).includes(String(b.room))) || {}).id || 0 : 0;
    const fee = await env.DB.prepare("SELECT svc_fee FROM clients WHERE id = ?").bind(client.id).first(), svc = fee ? fee.svc_fee : 0;
    if (b.all) {   // every room type at once, so the page can show charges the moment a room is picked
      const ids = [0].concat((gh.room_types || []).map((t) => t.id)), costs = {}, rows = await ghRates(env, gh.id, b.check_in, b.check_out);
      ids.forEach((id) => { const by = {}; const ps = plansFrom(rows, id); (ps.length ? ps : ["EP"]).forEach((p) => { by[p] = {Single: ghCostFrom(rows, id, b.check_in, b.check_out, svc, p, "Single"), Double: ghCostFrom(rows, id, b.check_in, b.check_out, svc, p, "Double")}; }); costs[id] = by; });
      const cr = await cxlRules(env, gh.id), cancel = {}; ids.forEach((id) => { const r = cxlFor(cr, id); cancel[id] = r ? Object.assign({text: cxlText(r)}, r) : null; });
      return json({costs, plans: PLANS, cancel, checkin_time: gh.checkin_time || "12:00"}); }
    return json({cost: await ghCost(env, gh.id, rt, b.check_in, b.check_out, svc, b.plan, b.occupancy)}); }
  if (path === "/api/book") return placeTrip(env, user, cid, b, null);
  if (path === "/api/book/update") { const tr = await tripFor(env, user, cid, b.id); if (!tr) return json({error: "Booking not found."}, 404);
    if (tr.status === "Cancelled") return json({error: "A cancelled booking can't be changed. Make a new booking instead."}, 409);
    if (tr.check_out <= istToday()) return json({error: "This stay has already ended."}, 409); return placeTrip(env, user, cid, b, tr); }
  if (path === "/api/book/cancel/preview") { const tr = await tripFor(env, user, cid, b.id); if (!tr) return json({error: "Booking not found."}, 404); const client = await bookClient(env, cid);
    const gh = (await clientGuestHouses(env, client, true)).find((g) => g.property === tr.property); return json(await cxlQuote(env, gh, tr)); }
  if (path === "/api/book/cancel") return cancelTrip(env, user, cid, b);
  if (path === "/api/book/resend") { const tr = await tripFor(env, user, cid, b.id); if (!tr) return json({error: "Booking not found."}, 404); const client = await bookClient(env, cid);
    const gh = (await clientGuestHouses(env, client, true)).find((g) => g.property === tr.property) || {property: tr.property};
    const pdf = typeof b.pdf === "string" && b.pdf.length < 4e6 && /^[A-Za-z0-9+/=]+$/.test(b.pdf) ? {content: b.pdf, filename: clean(b.pdf_name, 120).replace(/[^\w.\- ]/g, "") || "Voucher.pdf"} : null;
    const mail = await tripMail(env, client, tr, gh, tr.status === "Cancelled" ? "cancelled" : tr.changed_at ? "changed" : "confirmed", pdf);
    await env.DB.prepare("UPDATE trips SET mail_status = ? WHERE id = ?").bind(mail, tr.id).run(); return json({ok: true, mail_status: mail}); }
  return json({error: "Not found."}, 404);
}

/* ---------- hotel transaction reports ----------
   The file is final as received: rows are stored exactly as uploaded (dates made ISO), keyed by Booking Code.
   A newer upload updates a booking; bookings missing from a later file are kept; the latest upload can be undone. */
const TX_COLS = ["Booking Code", "Entity Name", "Property Name", "Property Category", "City", "State", "Emp Code", "Guest Name", "Booked Date", "Check-In Date", "Check-Out Date", "Designation", "Grade", "Eligibility Criteria", "Tariff Per Day", "Stay Days", "Total Tariff", "Taxes", "Tariff Payment Mode", "Room Type", "Booking Level", "Occupancy", "Status", "Net Amount Charged", "GST Charges", "Cancellation Charges Total", "Transaction Fee", "Transaction Fee GST Charged", "Invoice No", "WBS/ID or Cost Code", "Concur Request Date", "Purpose of Travel", "Travel Req ID", "Base Location", "Approving Manager", "Request Policy", "Employee Email ID", "Contact Number", "Remarks"];
const TX_DATES = new Set(["Booked Date", "Check-In Date", "Check-Out Date", "Concur Request Date"]);
const TX_TEXT = new Set(["Booking Code", "Emp Code", "Contact Number", "Invoice No", "Travel Req ID", "WBS/ID or Cost Code"]);
const TX_NEED = ["Guest Name", "Booked Date", "Check-In Date", "Check-Out Date"];
// each hotel booking is matched by its Invoice No (unique per booking); rows without one fall back to the Booking Code
const txKey = (r) => { const inv = String(r["Invoice No"] || "").trim(); if (inv) return inv; const bc = String(r["Booking Code"] || "").trim(); return bc ? "BC:" + bc : ""; };
const txKeyLabel = (k) => k.startsWith("BC:") ? "booking code " + k.slice(3) : "invoice " + k;
const nameKey = (s) => String(s || "").toLowerCase().replace(/^\s*(mr|mrs|ms|miss|dr)\b\.?/, "").replace(/[^a-z]/g, "");
const stayKey = (r) => nameKey(r["Guest Name"]) + "|" + (r["Check-In Date"] || "") + "|" + (r["Check-Out Date"] || "");
const hkey = (s) => String(s == null ? "" : s).toLowerCase().replace(/\s+/g, " ").trim();
function txDate(v) {
  if (v == null || v === "") return "";
  if (typeof v === "number" && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10);   // Excel serial day
  const s = String(v).trim(); let m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) return m[1] + "-" + m[2].padStart(2, "0") + "-" + m[3].padStart(2, "0");
  if ((m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(s))) return m[3] + "-" + m[2].padStart(2, "0") + "-" + m[1].padStart(2, "0");   // dd/mm/yyyy (India)
  if ((m = /^(\d{1,2})[\s-]([A-Za-z]{3})[a-z]*[\s-,]+(\d{4})$/.exec(s)) && MON3[m[2].toLowerCase()]) return m[3] + "-" + MON3[m[2].toLowerCase()] + "-" + m[1].padStart(2, "0");
  return null;   // not a date we can read
}
// header row + data rows (arrays) -> {rows, problems}
function txParse(header, data) {
  const idx = {}; (header || []).forEach((h, i) => { const k = hkey(h); const col = TX_COLS.find((c) => hkey(c) === k); if (col && !(col in idx)) idx[col] = i; });
  const missing = TX_NEED.filter((c) => !(c in idx));
  if (!("Invoice No" in idx) && !("Booking Code" in idx)) missing.unshift("Invoice No");
  if (missing.length) return {error: "This doesn't look like the transaction report. Missing column" + (missing.length > 1 ? "s: " : ": ") + missing.join(", ") + "."};
  const rows = [], problems = [], seen = new Map(); let dupSame = 0, dupDiff = 0;
  (data || []).forEach((arr, n) => {
    if (!Array.isArray(arr) || arr.every((v) => v == null || v === "")) return;
    const r = {}; for (const c of TX_COLS) { let v = c in idx ? arr[idx[c]] : ""; if (v == null) v = "";
      if (TX_DATES.has(c)) { const d = txDate(v); if (d === null) { problems.push({line: n + 2, issue: c + ' "' + String(v).slice(0, 20) + '" is not a date'}); v = String(v); } else v = d; }
      else if (TX_TEXT.has(c)) v = String(v).trim().slice(0, 120);   // IDs and phone numbers stay text (no 9.1E+12 in Excel)
      else v = typeof v === "number" ? v : String(v).trim().slice(0, 400);
      r[c] = v; }
    const code = txKey(r);
    if (!code) { problems.push({line: n + 2, issue: "No Invoice No or Booking Code; row skipped"}); return; }
    if (code.startsWith("BC:")) problems.push({line: n + 2, code: code.slice(3), issue: "No Invoice No; matched by Booking Code instead"});
    if (!r["Check-In Date"] || !r["Check-Out Date"] || r["Check-Out Date"] < r["Check-In Date"]) problems.push({line: n + 2, code, issue: "Check-out is before check-in"});
    if (seen.has(code)) { const same = JSON.stringify(seen.get(code)) === JSON.stringify(r); same ? dupSame++ : dupDiff++; if (!same) problems.push({line: n + 2, code, issue: "The same " + txKeyLabel(code) + " appears twice with different details; the later row is used"}); }
    seen.set(code, r);
  });
  for (const r of seen.values()) rows.push(r);
  return {rows, problems, dupSame, dupDiff};
}
const txFlags = (r) => { const t = +r["Tariff Per Day"] || 0, e = +String(r["Eligibility Criteria"]).replace(/,/g, "") || 0; return {over: !!(e && t > e), cancelled: /cancel/i.test(r.Status || "")}; };
async function txImport(env, cid, b, user, dry) {
  const p = txParse(b.header, b.rows); if (p.error) return json({error: p.error}, 400);
  if (Array.isArray(b.skip) && b.skip.length) { const sk = new Set(b.skip.map(String)); p.rows = p.rows.filter((r) => !sk.has(txKey(r))); }   // rows the team chose not to import
  if (!p.rows.length) return json({error: "No bookings found in this file."}, 400);
  if (p.rows.length > 20000) return json({error: "Upload up to 20,000 bookings at a time."}, 400);
  const codes = p.rows.map(txKey), old = new Map(), fromUp = new Map();
  for (let i = 0; i < codes.length; i += 90) { const part = codes.slice(i, i + 90);
    const {results} = await env.DB.prepare("SELECT code, row, upload_id FROM transactions WHERE client_id = ? AND code IN (" + part.map(() => "?").join(",") + ")").bind(cid, ...part).all();
    results.forEach((x) => { old.set(x.code, x.row); fromUp.set(x.code, x.upload_id); }); }
  // fingerprint of the file's content (row order ignored) to spot the very same report being uploaded again
  const hash = await sha256(JSON.stringify(p.rows.slice().sort((x, y) => txKey(x).localeCompare(txKey(y)))));
  const exact = await env.DB.prepare("SELECT id, filename, at, by_email FROM tx_uploads WHERE client_id = ? AND hash = ? AND undone IS NULL ORDER BY id DESC LIMIT 1").bind(cid, hash).first();
  const added = [], changed = [], same = [];
  p.rows.forEach((r) => { const code = txKey(r), was = old.get(code), now = JSON.stringify(r);
    if (!was) added.push(r); else if (was === now) same.push(r); else { const o = JSON.parse(was); changed.push({r, prev: was, fields: TX_COLS.filter((c) => String(o[c] ?? "") !== String(r[c] ?? "")).map((c) => ({col: c, from: o[c] ?? "", to: r[c] ?? ""}))}); } });
  const all = p.rows, sum = (k) => all.reduce((t, r) => t + (+r[k] || 0), 0);
  const summary = {rows: all.length, added: added.length, changed: changed.length, unchanged: same.length, dup_same: p.dupSame, dup_diff: p.dupDiff, problems: p.problems.slice(0, 50), problem_count: p.problems.length,
    over_policy: all.filter((r) => txFlags(r).over).length, cancelled: all.filter((r) => txFlags(r).cancelled).length, no_emp: all.filter((r) => !String(r["Emp Code"]).trim()).length,
    booked_from: all.reduce((m, r) => r["Booked Date"] && (!m || r["Booked Date"] < m) ? r["Booked Date"] : m, ""), booked_to: all.reduce((m, r) => r["Booked Date"] > m ? r["Booked Date"] : m, ""),
    net: Math.round(sum("Net Amount Charged") * 100) / 100,
    changes: changed.slice(0, 25).map((c) => ({code: txKey(c.r), guest: c.r["Guest Name"], fields: c.fields.slice(0, 6)})),
    sample_new: added.slice(0, 5).map((r) => ({code: txKey(r), guest: r["Guest Name"], hotel: r["Property Name"], booked: r["Booked Date"]}))};
  // possible duplicates: same guest name and stay dates under a different invoice (already in the portal, or twice in this file)
  const sameStay = [], newStay = new Map(); added.forEach((r) => { const k = stayKey(r); if (!newStay.has(k)) newStay.set(k, []); newStay.get(k).push(r); });
  for (const [, list] of newStay) if (list.length > 1) sameStay.push({guest: list[0]["Guest Name"], check_in: list[0]["Check-In Date"], check_out: list[0]["Check-Out Date"], where: "file", invoices: list.map(txKey), hotels: [...new Set(list.map((x) => x["Property Name"]))]});
  const cis = [...new Set(added.map((r) => r["Check-In Date"]).filter(Boolean))];
  for (let i = 0; i < cis.length; i += 90) { const part = cis.slice(i, i + 90);
    const {results} = await env.DB.prepare("SELECT code, row, upload_id FROM transactions WHERE client_id = ? AND checkin IN (" + part.map(() => "?").join(",") + ")").bind(cid, ...part).all();
    results.forEach((x) => { const o = JSON.parse(x.row), hits = newStay.get(stayKey(o)); if (!hits) return; hits.filter((r) => txKey(r) !== x.code).forEach((r) => sameStay.push({guest: r["Guest Name"], check_in: r["Check-In Date"], check_out: r["Check-Out Date"], where: "portal", invoices: [txKey(r), x.code], hotels: [...new Set([r["Property Name"], o["Property Name"]])], upload_id: x.upload_id})); }); }
  summary.same_stay = sameStay.slice(0, 40); summary.same_stay_count = sameStay.length;
  // new rows that look like duplicates are stored but held back from the client until an admin keeps or removes them
  const holdSet = new Set(); sameStay.forEach((x) => (x.where === "portal" ? [x.invoices[0]] : x.invoices.slice(1)).forEach((k) => holdSet.add(k)));
  summary.held = holdSet.size;
  // which earlier uploads already brought in the bookings that are in this file
  const known = new Map(); [...same, ...changed.map((c) => c.r)].forEach((r) => { const u = fromUp.get(txKey(r)) || 0; known.set(u, (known.get(u) || 0) + 1); });
  const ids = [...known.keys()].filter(Boolean), info = new Map();
  if (ids.length) { const {results} = await env.DB.prepare("SELECT id, filename, at, by_email FROM tx_uploads WHERE id IN (" + ids.slice(0, 90).map(() => "?").join(",") + ")").bind(...ids.slice(0, 90)).all(); results.forEach((u) => info.set(u.id, u)); }
  summary.already = same.length + changed.length;
  summary.exact = exact ? {filename: exact.filename, at: exact.at, by: exact.by_email} : null;
  summary.from = [...known.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, n]) => { const u = info.get(id); return u ? {filename: u.filename, at: u.at, by: u.by_email, count: n} : {filename: "an earlier upload", at: null, by: null, count: n}; });
  if (dry) return json({ok: true, preview: summary});
  if (!added.length && !changed.length) return json({error: "Nothing new in this file: every booking in it is already in the portal" + (exact ? " (same report as " + (exact.filename || "an earlier upload") + ")" : "") + "."}, 409);
  const now = new Date().toISOString();
  // keep the original file, so it can be downloaded again from the upload history at any time
  let fileId = null; const f64 = String(b.file_b64 || "");
  if (f64 && f64.length <= 1900000 && /^[A-Za-z0-9+/=]+$/.test(f64)) { const mime = /\.csv$/i.test(b.filename || "") ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const fr = await env.DB.prepare("INSERT INTO files (client_id, mime, data, created) VALUES (NULL, ?, ?, ?)").bind(mime, f64, now).run(); fileId = fr.meta ? fr.meta.last_row_id : fr.lastInsertRowid; }
  const up = await env.DB.prepare("INSERT INTO tx_uploads (client_id, by_email, at, filename, rows, added, changed, unchanged, hash, file_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(cid, user.email, now, clean(b.filename, 160), all.length, added.length, changed.length, same.length, hash, fileId).run();
  const uid = up.meta ? up.meta.last_row_id : up.lastInsertRowid, st = [];
  const put = (r) => env.DB.prepare("INSERT INTO transactions (client_id, code, booked, checkin, checkout, status, row, upload_id, updated, held) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(client_id, code) DO UPDATE SET booked = excluded.booked, checkin = excluded.checkin, checkout = excluded.checkout, status = excluded.status, row = excluded.row, upload_id = excluded.upload_id, updated = excluded.updated")
    .bind(cid, txKey(r), r["Booked Date"] || "", r["Check-In Date"] || "", r["Check-Out Date"] || "", r.Status || "", JSON.stringify(r), uid, now, holdSet.has(txKey(r)) ? 1 : 0);
  added.forEach((r) => { st.push(env.DB.prepare("INSERT INTO tx_versions (upload_id, code, prev) VALUES (?, ?, NULL)").bind(uid, txKey(r)), put(r)); });
  changed.forEach((c) => { st.push(env.DB.prepare("INSERT INTO tx_versions (upload_id, code, prev) VALUES (?, ?, ?)").bind(uid, txKey(c.r), c.prev), put(c.r)); });
  for (let i = 0; i < st.length; i += 80) await env.DB.batch(st.slice(i, i + 80));
  return json({ok: true, upload_id: uid, result: summary});
}
// guest house booking codes: each stay (guest house + guest + check-in) gets a permanent code ZUNA00001, ZUNA00002 … the first time it is seen
async function ghCodes(env, bookings) {
  const keyOf = (b) => (b.property || "") + "|" + guestKey(b), keys = [...new Set(bookings.map(keyOf))], ids = new Map();
  const load = async (list) => { for (let i = 0; i < list.length; i += 90) { const part = list.slice(i, i + 90);
    const {results} = await env.DB.prepare("SELECT id, key FROM gh_codes WHERE key IN (" + part.map(() => "?").join(",") + ")").bind(...part).all(); results.forEach((r) => ids.set(r.key, r.id)); } };
  await load(keys); const missing = keys.filter((k) => !ids.has(k));
  if (missing.length) { const now = new Date().toISOString(), st = missing.map((k) => env.DB.prepare("INSERT OR IGNORE INTO gh_codes (key, created) VALUES (?, ?)").bind(k, now));
    for (let i = 0; i < st.length; i += 80) await env.DB.batch(st.slice(i, i + 80)); await load(missing); }
  bookings.forEach((b) => { const id = ids.get(keyOf(b)); if (id) b.booking_code = "ZUNA" + String(id).padStart(5, "0"); });
}
// every upload ever made for the client (newest first), with whether its original file is kept
async function txUploads(env, cid) { const {results} = await env.DB.prepare("SELECT id, by_email, at, filename, rows, added, changed, unchanged, undone, file_id IS NOT NULL AS has_file FROM tx_uploads WHERE client_id = ? ORDER BY id DESC LIMIT 1000").bind(cid).all(); return results; }
// all hotel bookings stored for a client (compact), with possible-duplicate groups: same guest and stay dates, different invoice
async function txStored(env, cid) {
  const {results} = await env.DB.prepare("SELECT t.code, t.row, t.upload_id, t.held, u.filename, u.at FROM transactions t LEFT JOIN tx_uploads u ON u.id = t.upload_id WHERE t.client_id = ? ORDER BY t.booked DESC, t.code").bind(cid).all();
  const rows = results.map((x) => { const r = JSON.parse(x.row); return {code: x.code, held: x.held ? 1 : 0, guest: r["Guest Name"] || "", emp: r["Emp Code"] || "", hotel: r["Property Name"] || "", city: r.City || "", check_in: r["Check-In Date"] || "", check_out: r["Check-Out Date"] || "", booked: r["Booked Date"] || "", invoice: r["Invoice No"] || "", booking_code: r["Booking Code"] || "", net: +r["Net Amount Charged"] || 0, status: r.Status || "", file: x.filename || "", uploaded: x.at || "", stay: stayKey(r)}; });
  const groups = new Map(); rows.forEach((r) => { if (!groups.has(r.stay)) groups.set(r.stay, []); groups.get(r.stay).push(r); });
  let g = 0; for (const list of groups.values()) if (list.length > 1) { g++; list.forEach((r) => { r.dup = g; }); }
  const {results: rem} = await env.DB.prepare("SELECT id, code, row, by_email, at FROM tx_removed WHERE client_id = ? AND restored IS NULL ORDER BY id DESC LIMIT 1000").bind(cid).all();
  return json({rows: rows.map(({stay, ...r}) => r), dup_groups: g, held: rows.filter((r) => r.held).length, removed: rem.map((x) => { const r = JSON.parse(x.row); return {id: x.id, code: x.code, guest: r["Guest Name"] || "", hotel: r["Property Name"] || "", check_in: r["Check-In Date"] || "", check_out: r["Check-Out Date"] || "", invoice: r["Invoice No"] || "", net: +r["Net Amount Charged"] || 0, by: x.by_email, at: x.at}; })});
}
// keep a booking that was held as a possible duplicate: the client sees it from now on
async function txKeep(env, cid, code) {
  const r = await env.DB.prepare("UPDATE transactions SET held = 0 WHERE client_id = ? AND code = ?").bind(cid, String(code || "")).run();
  return (r.meta ? r.meta.changes : r.changes) ? json({ok: true}) : json({error: "That booking is not in the portal."}, 404);
}
// remove one hotel booking (it moves to tx_removed and can be restored)
async function txRemove(env, cid, code, user) {
  const t = await env.DB.prepare("SELECT code, row, upload_id FROM transactions WHERE client_id = ? AND code = ?").bind(cid, String(code || "")).first();
  if (!t) return json({error: "That booking is not in the portal."}, 404);
  await env.DB.batch([env.DB.prepare("INSERT INTO tx_removed (client_id, code, row, upload_id, by_email, at) VALUES (?, ?, ?, ?, ?, ?)").bind(cid, t.code, t.row, t.upload_id, user.email, new Date().toISOString()),
    env.DB.prepare("DELETE FROM transactions WHERE client_id = ? AND code = ?").bind(cid, t.code)]);
  return json({ok: true});
}
async function txRestore(env, cid, id) {
  const x = await env.DB.prepare("SELECT code, row, upload_id FROM tx_removed WHERE id = ? AND client_id = ? AND restored IS NULL").bind(+id, cid).first();
  if (!x) return json({error: "Nothing to restore."}, 404);
  if (await env.DB.prepare("SELECT 1 FROM transactions WHERE client_id = ? AND code = ?").bind(cid, x.code).first()) return json({error: "A booking with this invoice was uploaded again since it was removed, so there is nothing to restore."}, 409);
  const r = JSON.parse(x.row), now = new Date().toISOString();
  await env.DB.batch([env.DB.prepare("INSERT INTO transactions (client_id, code, booked, checkin, checkout, status, row, upload_id, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(cid, x.code, r["Booked Date"] || "", r["Check-In Date"] || "", r["Check-Out Date"] || "", r.Status || "", x.row, x.upload_id, now),
    env.DB.prepare("UPDATE tx_removed SET restored = ? WHERE id = ?").bind(now, +id)]);
  return json({ok: true});
}
async function txFile(env, cid, id) {
  const u = await env.DB.prepare("SELECT filename, file_id FROM tx_uploads WHERE id = ? AND client_id = ?").bind(+id, cid).first();
  if (!u || !u.file_id) return json({error: "The original file for this upload was not kept."}, 404);
  const f = await env.DB.prepare("SELECT mime, data FROM files WHERE id = ?").bind(u.file_id).first(); if (!f) return json({error: "File not found."}, 404);
  return json({name: u.filename || "transaction-report.xlsx", mime: f.mime, data: f.data});
}
async function txUndo(env, cid, id) {
  const last = await env.DB.prepare("SELECT id FROM tx_uploads WHERE client_id = ? AND undone IS NULL ORDER BY id DESC LIMIT 1").bind(cid).first();
  if (!last || last.id !== +id) return json({error: "Only the latest upload can be undone."}, 400);
  const {results} = await env.DB.prepare("SELECT code, prev FROM tx_versions WHERE upload_id = ?").bind(last.id).all(), st = [];
  results.forEach((v) => { if (v.prev == null) st.push(env.DB.prepare("DELETE FROM transactions WHERE client_id = ? AND code = ?").bind(cid, v.code));
    else { const r = JSON.parse(v.prev); st.push(env.DB.prepare("UPDATE transactions SET booked = ?, checkin = ?, checkout = ?, status = ?, row = ?, upload_id = NULL, updated = ? WHERE client_id = ? AND code = ?").bind(r["Booked Date"] || "", r["Check-In Date"] || "", r["Check-Out Date"] || "", r.Status || "", v.prev, new Date().toISOString(), cid, v.code)); } });
  st.push(env.DB.prepare("UPDATE tx_uploads SET undone = ? WHERE id = ?").bind(new Date().toISOString(), last.id));
  for (let i = 0; i < st.length; i += 80) await env.DB.batch(st.slice(i, i + 80));
  return json({ok: true, reverted: results.length});
}
// client side: bookings by booked date or check-out date (both optional; at most about 13 months at a time)
async function txList(env, cid, b) {
  const iso = /^\d{4}-\d{2}-\d{2}$/, w = ["client_id = ?"], args = [cid];
  for (const [k, col] of [["booked", "booked"], ["checkout", "checkout"]]) { const f = b[k + "_from"], t = b[k + "_to"];
    if (f || t) { if (!iso.test(f || "") || !iso.test(t || "") || t < f) return json({error: "Choose a valid date range."}, 400);
      if ((Date.parse(t) - Date.parse(f)) / 864e5 > 400) return json({error: "Choose up to 13 months at a time."}, 400);
      w.push(col + " >= ? AND " + col + " <= ?"); args.push(f, t); } }
  w.push("(held IS NULL OR held = 0)");   // possible duplicates stay hidden until an admin keeps them
  const {results} = await env.DB.prepare("SELECT row FROM transactions WHERE " + w.join(" AND ") + " ORDER BY booked DESC, code LIMIT 10001").bind(...args).all();
  const last = await env.DB.prepare("SELECT at FROM tx_uploads WHERE client_id = ? AND undone IS NULL ORDER BY id DESC LIMIT 1").bind(cid).first();
  const live = syncReady(await syncCfg(env, cid));
  return json({rows: results.slice(0, 10000).map((x) => JSON.parse(x.row)), more: results.length > 10000, updated: last ? last.at : null, cols: TX_COLS, live: !!live});
}

// ---------- live hotel sync: the partner's bookings API, called through Zuna's fixed-IP relay ----------
// The partner allow-lists one IP, so every call goes worker -> relay (DigitalOcean reserved IP) -> partner.
// Bookings come in under the same Invoice No as the uploaded reports (HB<financial year>/<booking id>) and go
// through the normal import, so matching, possible-duplicate holds, history and undo all work as for uploads.
const SYNC_DEF = {api_url: "https://bff.prod.cbtsuite.com", relay_url: "https://174-138-123-123.sslip.io", relay_key: "", token: "", months: 2, skip_free_cxl: 1, enabled: 0, fee: 100, fee_gst: 18, hotel_gst: 18, gst_slab: 1, jwt_secret: "", jwt_iss: "https://vantiscorp.com", jwt_aud: "cbt-bff-api", jwt_client: "", jwt_corporate: ""};
// the partner shares a signing secret: the portal makes its own short-lived token for every call, so nothing ever expires
const syncSigned = (c) => !!(c.jwt_secret && c.jwt_client && c.jwt_corporate);
const syncReady = (c) => !!(c.relay_key && (c.token || syncSigned(c)));
const b64url = (bytes) => { let s = ""; new Uint8Array(bytes).forEach((x) => { s += String.fromCharCode(x); }); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
async function mintToken(c) {
  const now = Math.floor(Date.now() / 1000), enc = new TextEncoder();
  const data = b64url(enc.encode(JSON.stringify({alg: "HS256", typ: "JWT"}))) + "." + b64url(enc.encode(JSON.stringify({clientId: String(c.jwt_client), corporateId: String(c.jwt_corporate), iss: c.jwt_iss, aud: c.jwt_aud, iat: now, nbf: now - 60, exp: now + 3600})));
  const key = await crypto.subtle.importKey("raw", enc.encode(c.jwt_secret), {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
  return data + "." + b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}
const partnerToken = (c) => syncSigned(c) ? mintToken(c) : c.token;
const SYNC_PATH = {report: "/api/LtmReport/ltm_bookings", totals: "/api/LtmReport/ltm_bookings-transaction-report", voucher: "/api/LtmReport/ltm_booking-voucher-links/"};
async function syncCfg(env, cid) { const r = await env.DB.prepare("SELECT * FROM tx_sync WHERE client_id = ?").bind(cid).first(); const c = {...SYNC_DEF, client_id: cid}; if (r) for (const k in r) if (r[k] != null) c[k] = r[k]; return c; }
const jwtInfo = (t) => { try { let s = String(t).split(".")[1].replace(/-/g, "+").replace(/_/g, "/"); s += "===".slice((s.length + 3) % 4); const p = JSON.parse(atob(s));
  return {exp: p.exp ? new Date(p.exp * 1000).toISOString() : null, client: p.clientId ?? null, corporate: p.corporateId ?? null}; } catch (e) { return null; } };
const syncView = (c) => ({api_url: c.api_url, relay_url: c.relay_url, months: +c.months, fee: +c.fee, fee_gst: +c.fee_gst, hotel_gst: +c.hotel_gst, gst_slab: c.gst_slab ? 1 : 0, ready: syncReady(c), signing: {has_secret: !!c.jwt_secret, iss: c.jwt_iss || "", aud: c.jwt_aud || "", client: c.jwt_client || "", corporate: c.jwt_corporate || ""}, skip_free_cxl: c.skip_free_cxl ? 1 : 0, enabled: c.enabled ? 1 : 0, has_key: !!c.relay_key, has_token: !!c.token,
  token: c.token ? jwtInfo(c.token) : null, last_run: c.last_run || null, last_ok: c.last_ok || null, last_error: c.last_error || null, last_result: jparse(c.last_result, null)});
const b64text = (b) => new TextDecoder().decode(Uint8Array.from(atob(b || ""), (ch) => ch.charCodeAt(0)));
// one call to the partner API through the relay; 5xx and network errors are retried twice, 401/403 are not
async function partnerCall(c, method, path, body) {
  if (!c.relay_url || !c.relay_key) throw new Error("The relay address and key are not saved yet.");
  if (!c.token && !syncSigned(c)) throw new Error(c.jwt_secret ? "The client ID and corporate ID are not saved yet." : "The signing secret is not saved yet.");
  const req = {url: String(c.api_url).replace(/\/+$/, "") + path, method, headers: {authorization: "Bearer " + await partnerToken(c), "content-type": "application/json", accept: "application/json"}};
  if (body) req.body = JSON.stringify(body);
  let last;
  for (let i = 0; i < 3; i++) {
    if (i) await new Promise((ok) => setTimeout(ok, 1500 * i * i));
    let r, o;
    try { r = await fetch(String(c.relay_url).replace(/\/+$/, "") + "/forward", {method: "POST", headers: {"content-type": "application/json", "x-relay-key": c.relay_key}, body: JSON.stringify(req), signal: AbortSignal.timeout(70000)}); o = await r.json().catch(() => ({})); }
    catch (e) { last = new Error("The relay did not answer (" + (e.message || "network error") + ")."); continue; }
    if (r.status === 401) throw new Error("The relay refused the key. Check the relay key.");
    if (!r.ok) { last = new Error("Relay: " + (o.error || "HTTP " + r.status)); if (r.status === 403 || r.status === 400) throw last; continue; }
    const txt = b64text(o.body_b64); let data = null; try { data = JSON.parse(txt); } catch (e) { /* not JSON */ }
    if (o.status === 403) throw new Error(/token/i.test(txt) ? (syncSigned(c) ? "The booking system rejected our token: check the signing secret, issuer, audience, client ID and corporate ID." : "The API token was rejected or has expired. Save a new token.") : "Access denied by the partner: our IP is not on their allow-list.");
    if (o.status === 401) throw new Error("The partner says the API token is missing or malformed.");
    if (o.status === 404) return {status: 404, data};
    if (o.status >= 500) { last = new Error("Partner API error " + o.status + ((data && data.errorDetails) ? ": " + data.errorDetails : "")); continue; }
    if (o.status >= 400 || !data) throw new Error("Partner API " + o.status + ": " + ((data && data.message) || txt.slice(0, 160) || "no answer"));
    if (data.status === "failure") throw new Error("Partner API: " + (data.message || "failure"));
    return {status: o.status, data};
  }
  throw last;
}
// partner timestamps are UTC; the portal works in IST dates
const istDate = (s) => { if (!s) return ""; const v = String(s), t = Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(v) ? v : v + "Z"); return isNaN(t) ? "" : new Date(t + 19800000).toISOString().slice(0, 10); };
const fyTag = (d) => { const y = +d.slice(0, 4), m = +d.slice(5, 7); return String((m >= 4 ? y : y - 1) % 100).padStart(2, "0"); };   // HB26 = April 2026 to March 2027
const apiInvoice = (x) => { const n = x.invoiceNumber ?? x.bookingId, d = istDate(x.bookingDate); return n != null && n !== "" && d ? "HB" + fyTag(d) + "/" + n : ""; };
const nz = (v) => v == null ? "" : v;
// the partner's totalAmountINR = room amount (incl. hotel GST) + the transaction fee + GST on it; split it the way the reports do
function apiAmounts(x, c) {
  const total = +(x.totalAmountINR ?? x.totalAmount); if (!(total > 0)) return {};
  const fee = +c.fee || 0, feeGst = r2(fee * (+c.fee_gst || 0) / 100), room = Math.max(total - fee - feeGst, 0), cxl = /cancel/i.test(x.status || "");
  // the room amount already includes the hotel's taxes: it is not split into tariff and GST
  return {"Total Tariff": "", "GST Charges": "", "Net Amount Charged": cxl ? (+x.totalCancellationCharges || 0) : r2(room), "Transaction Fee": fee, "Transaction Fee GST Charged": feeGst};
}
function apiRow(x, c = SYNC_DEF) {
  const r = {}; TX_COLS.forEach((k) => { r[k] = ""; });
  Object.assign(r, {"Booking Code": String(nz(x.hotelConfirmationNumber) || nz(x.supplierConfirmationNumber)), "Entity Name": nz(x.billingEntity), "Property Name": nz(x.propertyName), "Property Category": nz(x.category), City: nz(x.city),
    "Emp Code": String(nz(x.employeeId)), "Guest Name": nz(x.travellerName), "Booked Date": istDate(x.bookingDate), "Check-In Date": istDate(x.checkIn), "Check-Out Date": istDate(x.checkOut), Grade: nz(x.grade),
    "Tariff Per Day": nz(x.ratePerNight), "Stay Days": nz(x.totalNumberOfNights), "Total Tariff": nz(x.totalAmountINR ?? x.totalAmount), Status: nz(x.status), "Cancellation Charges Total": nz(x.totalCancellationCharges),
    "Invoice No": apiInvoice(x), "WBS/ID or Cost Code": String(nz(x.wbs) || nz(x.costCentre)), "Travel Req ID": String(nz(x.travelRequestId)), "Base Location": nz(x.ltiBaseLocation)}, apiAmounts(x, c));
  return r;
}
// a booking already in the portal (from a report upload) keeps its billing figures; the API only brings
// cancellations, changed dates and anything the upload left blank
const SYNC_LIVE = ["Check-In Date", "Check-Out Date", "Stay Days", "Cancellation Charges Total"];
function apiMerge(old, a) {
  const r = {...old};
  for (const k of TX_COLS) if ((r[k] == null || r[k] === "") && a[k] !== "") r[k] = a[k];
  for (const k of SYNC_LIVE) if (a[k] !== "" && a[k] != null) r[k] = a[k];
  if (/cancel/i.test(a.Status) && !/cancel/i.test(r.Status || "")) r.Status = a.Status;
  return r;
}
const monthRanges = (n, now = new Date()) => { const out = [], y = now.getUTCFullYear(), m = now.getUTCMonth();
  for (let i = n; i >= 0; i--) { const s = new Date(Date.UTC(y, m - i, 1)), e = new Date(Date.UTC(y, m - i + 1, 1) - 1000); out.push({startDate: s.toISOString().slice(0, 19) + "Z", endDate: e.toISOString().slice(0, 19) + "Z"}); } return out; };
// quick check (every minute): bookings made yesterday and today, IST; a full check covers the last months
const quickRange = (now = new Date()) => { const t = new Date(now.getTime() + 19800000), s = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() - 1) - 19800000;
  return [{startDate: new Date(s).toISOString().slice(0, 19) + "Z", endDate: now.toISOString().slice(0, 19) + "Z"}]; };
async function syncRun(env, cid, by, mode) {
  await ensureSchema(env);
  const c = await syncCfg(env, cid), at = new Date().toISOString(), res = {fetched: 0, months: 0, added: 0, changed: 0, skipped_cancelled: 0, skipped_removed: 0, skipped_other: 0, held: 0, amt_checked: 0, amt_match: 0};
  const save = (ok, err) => env.DB.prepare("INSERT INTO tx_sync (client_id, last_run, last_ok, last_error, last_result) VALUES (?, ?, ?, ?, ?) ON CONFLICT(client_id) DO UPDATE SET last_run = excluded.last_run, last_ok = COALESCE(excluded.last_ok, tx_sync.last_ok), last_error = excluded.last_error, last_result = CASE WHEN ? THEN tx_sync.last_result ELSE excluded.last_result END")
    .bind(cid, at, ok ? at : null, err || null, JSON.stringify(res), mode === "quick" && ok && !res.added && !res.changed ? 1 : 0).run();   // a quiet quick check keeps the last full check's figures
  try {
    const got = new Map();
    for (const range of mode === "quick" ? quickRange() : monthRanges(Math.min(Math.max(+c.months || 0, 0), 12))) {
      for (let off = 0, total = Infinity; off < total && off < 50000;) {
        const {data} = await partnerCall(c, "POST", SYNC_PATH.report, {bookingDateRange: range, pagination: {offset: off, limit: 1000}});
        const list = Array.isArray(data.bookings) ? data.bookings : []; total = +data.totalCount || 0;
        list.forEach((x) => { const r = apiRow(x, c); if (r["Invoice No"]) got.set(r["Invoice No"], r); else res.skipped_other++; });
        res.fetched += list.length; if (!list.length) break; off += list.length;
      }
      res.months++;
    }
    const codes = [...got.keys()], old = new Map(), removed = new Set();
    for (let i = 0; i < codes.length; i += 90) { const part = codes.slice(i, i + 90), q = part.map(() => "?").join(",");
      (await env.DB.prepare("SELECT code, row FROM transactions WHERE client_id = ? AND code IN (" + q + ")").bind(cid, ...part).all()).results.forEach((x) => old.set(x.code, JSON.parse(x.row)));
      (await env.DB.prepare("SELECT code FROM tx_removed WHERE client_id = ? AND restored IS NULL AND code IN (" + q + ")").bind(cid, ...part).all()).results.forEach((x) => removed.add(x.code)); }
    const rows = [];
    for (const [code, a] of got) {
      if (old.has(code)) { const o = old.get(code);
        // check the amount split against the uploaded report (same booking, both confirmed): proves the settings are right
        if (a["Net Amount Charged"] !== "" && +o["Net Amount Charged"] > 0 && !/cancel/i.test(a.Status + " " + o.Status)) { res.amt_checked++; if (Math.abs(+o["Net Amount Charged"] - a["Net Amount Charged"]) <= 1) res.amt_match++; }
        rows.push(apiMerge(o, a)); continue; }
      if (removed.has(code)) { res.skipped_removed++; continue; }   // the Zuna team removed it on purpose
      if (/planned/i.test(a.Status)) { res.skipped_other++; continue; }
      if (c.skip_free_cxl && /cancel/i.test(a.Status) && !(+a["Cancellation Charges Total"] > 0)) { res.skipped_cancelled++; continue; }   // cancelled free of charge: nothing to bill
      rows.push(a);
    }
    if (rows.length) {
      const r = await txImport(env, cid, {header: TX_COLS, rows: rows.map((o) => TX_COLS.map((k) => o[k])), filename: "Live sync · " + istStamp(new Date())}, {email: by || "Zuna Hotel Desk"}, false);
      const o = await r.json();
      if (r.status === 200 && o.result) { res.added = o.result.added; res.changed = o.result.changed; res.held = o.result.held || 0; res.upload_id = o.upload_id; }
      else if (r.status !== 409) throw new Error(o.error || "Could not save the bookings.");
    }
    await save(true, null); return {ok: true, result: res};
  } catch (e) { await save(false, e.message || String(e)); return {ok: false, error: e.message || String(e), result: res}; }
}
async function syncAll(env, mode) {
  await ensureSchema(env);
  const {results} = await env.DB.prepare("SELECT client_id FROM tx_sync WHERE enabled = 1").all();
  for (const x of results) await syncRun(env, x.client_id, "Zuna Hotel Desk", mode).catch(() => null);
}
async function syncApi(env, user, path, b) {
  const cid = +b.client_id; if (!cid || !(await env.DB.prepare("SELECT 1 FROM clients WHERE id = ?").bind(cid).first())) return json({error: "Client not found."}, 404);
  if (path === "/api/admin/sync/state") return json({sync: syncView(await syncCfg(env, cid))});
  if (path === "/api/admin/sync/save") {
    const c = await syncCfg(env, cid), url = (v, d) => { const s = clean(v, 200).replace(/\/+$/, ""); return /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(s) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(s) ? s : d; };
    const api = b.api_url !== undefined ? url(b.api_url, null) : c.api_url, relay = b.relay_url !== undefined ? url(b.relay_url, null) : c.relay_url;
    if (!api || !relay) return json({error: "Addresses must start with https:// and be just the host, like https://example.com."}, 400);
    let key = c.relay_key, token = c.token, secret = c.jwt_secret;
    if (b.jwt_secret) { secret = String(b.jwt_secret).trim().slice(0, 500); if (secret.length < 16) return json({error: "That signing secret looks too short."}, 400); }
    const idf = (v, d) => v === undefined ? d : clean(v, 60), iss = idf(b.jwt_iss, c.jwt_iss), aud = idf(b.jwt_aud, c.jwt_aud), jcl = idf(b.jwt_client, c.jwt_client), jco = idf(b.jwt_corporate, c.jwt_corporate);
    if (b.relay_key) { key = clean(b.relay_key, 200); if (!/^[A-Za-z0-9_-]{32,200}$/.test(key)) return json({error: "That relay key doesn't look right: it should be the long code printed by the relay setup."}, 400); }
    if (b.token) { token = clean(b.token, 4000).replace(/^bearer\s+/i, ""); if (!jwtInfo(token)) return json({error: "That doesn't look like an API token. Paste the full token you received from the partner."}, 400); }
    const num = (v, d, max) => { if (v === undefined || v === null || v === "") return d; const n = +v; return isFinite(n) && n >= 0 && n <= max ? r2(n) : NaN; };
    const fee = num(b.fee, +c.fee, 100000), feeGst = num(b.fee_gst, +c.fee_gst, 100), hGst = num(b.hotel_gst, +c.hotel_gst, 100);
    if ([fee, feeGst, hGst].some((v) => isNaN(v))) return json({error: "Check the transaction fee and GST figures."}, 400);
    // live as soon as both secrets are saved: no switch, no manual sync
    const slab = b.gst_slab !== undefined ? (b.gst_slab ? 1 : 0) : (c.gst_slab ? 1 : 0), months = Math.min(Math.max(parseInt(b.months ?? c.months, 10) || 0, 0), 12), skip = b.skip_free_cxl !== undefined ? (b.skip_free_cxl ? 1 : 0) : c.skip_free_cxl, on = syncReady({relay_key: key, token, jwt_secret: secret, jwt_client: jcl, jwt_corporate: jco}) ? 1 : 0;
    await env.DB.prepare("INSERT INTO tx_sync (client_id, api_url, relay_url, relay_key, token, months, skip_free_cxl, enabled, fee, fee_gst, hotel_gst, gst_slab, jwt_secret, jwt_iss, jwt_aud, jwt_client, jwt_corporate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(client_id) DO UPDATE SET api_url = excluded.api_url, relay_url = excluded.relay_url, relay_key = excluded.relay_key, token = excluded.token, months = excluded.months, skip_free_cxl = excluded.skip_free_cxl, enabled = excluded.enabled, fee = excluded.fee, fee_gst = excluded.fee_gst, hotel_gst = excluded.hotel_gst, gst_slab = excluded.gst_slab, jwt_secret = excluded.jwt_secret, jwt_iss = excluded.jwt_iss, jwt_aud = excluded.jwt_aud, jwt_client = excluded.jwt_client, jwt_corporate = excluded.jwt_corporate")
      .bind(cid, api, relay, key, token, months, skip, on, fee, feeGst, hGst, slab, secret, iss, aud, jcl, jco).run();
    const first = on ? await syncRun(env, cid, user.email) : null;   // bring the data in straight away
    return json({ok: true, synced: first, sync: syncView(await syncCfg(env, cid))});
  }
  if (path === "/api/admin/sync/run") { const r = await syncRun(env, cid, user.email); return json({...r, sync: syncView(await syncCfg(env, cid))}, r.ok ? 200 : 502); }
  if (path === "/api/admin/sync/test") {   // relay up? which IP do partners see? does the partner accept us? (this month's totals)
    const c = await syncCfg(env, cid), steps = [];
    try { const r = await fetch(String(c.relay_url).replace(/\/+$/, "") + "/health", {signal: AbortSignal.timeout(15000)}); steps.push({step: "Relay reachable", ok: r.ok, detail: r.ok ? c.relay_url : "HTTP " + r.status}); }
    catch (e) { steps.push({step: "Relay reachable", ok: false, detail: e.message || "no answer"}); return json({steps}); }
    if (!c.relay_key) { steps.push({step: "Relay key", ok: false, detail: "Not saved yet"}); return json({steps}); }
    try { const r = await fetch(String(c.relay_url).replace(/\/+$/, "") + "/ip", {headers: {"x-relay-key": c.relay_key}, signal: AbortSignal.timeout(15000)}); const o = await r.json().catch(() => ({}));
      steps.push(r.ok ? {step: "Outgoing IP", ok: true, detail: o.ip || "?"} : {step: "Relay key", ok: false, detail: r.status === 401 ? "The relay refused the key" : (o.error || "HTTP " + r.status)}); if (!r.ok) return json({steps}); }
    catch (e) { steps.push({step: "Outgoing IP", ok: false, detail: e.message}); return json({steps}); }
    try { const {data} = await partnerCall(c, "POST", SYNC_PATH.totals, {bookingDateRange: monthRanges(0)[0]});
      steps.push({step: "Partner API", ok: true, detail: "This month: " + (data.totalBookings || 0) + " bookings, " + (data.totalCancelledBookings || 0) + " cancelled", totals: data}); }
    catch (e) { steps.push({step: "Partner API", ok: false, detail: e.message}); }
    return json({steps});
  }
  return json({error: "Not found."}, 404);
}
// confirmation / reconfirmation voucher links of one hotel booking (made fresh by the partner on each call)
async function txVoucher(env, cid, code) {
  const m = /^HB\d{2}\/(\d{1,12})$/.exec(String(code || "").trim()); if (!m) return json({error: "This booking has no partner booking number."}, 400);
  if (!(await env.DB.prepare("SELECT 1 FROM transactions WHERE client_id = ? AND code = ?").bind(cid, String(code).trim()).first())) return json({error: "Booking not found."}, 404);
  const c = await syncCfg(env, cid); if (!syncReady(c)) return json({error: "Vouchers aren't available yet: the live connection is not set up."}, 503);
  try { const {status, data} = await partnerCall(c, "GET", SYNC_PATH.voucher + m[1]);
    if (status === 404) return json({error: "The partner has no voucher for this booking."}, 404);
    const ok = (u) => typeof u === "string" && /^https:\/\//i.test(u);
    return json({confirmation: ok(data.confirmationVoucherUrl) ? data.confirmationVoucherUrl : null, reconfirmations: (Array.isArray(data.reconfirmationVoucherUrls) ? data.reconfirmationVoucherUrls : [data.reconfirmationVoucherUrl]).filter(ok)}); }
  catch (e) { return json({error: e.message}, 502); }
}

async function adminApi(req, env, user, path) {
  let b; try { b = await req.json(); } catch (e) { return json({error: "Bad request."}, 400); }
  const now = new Date().toISOString();
  try {
    switch (path) {
      case "/api/admin/state": return json(await adminState(env, user));
      case "/api/admin/backups": return json(await backupList(env));
      case "/api/admin/backup": { const r = await backupNow(env, user.email); return r.error ? json(r, 503) : json({ok: true, backup: r}); }
      case "/api/admin/backup/download": { if (!env.BACKUPS || !/^backup\/[\w.-]+\.json\.gz$/.test(b.key || "")) return json({error: "Backup not found."}, 404);
        const v = await env.BACKUPS.get(b.key, "arrayBuffer"); if (!v) return json({error: "Backup not found."}, 404);
        return new Response(v, {headers: {"content-type": "application/gzip", "content-disposition": 'attachment; filename="' + b.key.slice(7) + '"', "cache-control": "no-store"}}); }
      case "/api/admin/audit": return json(await auditList(env, b));
      case "/api/admin/rate":
      case "/api/admin/block":
      case "/api/admin/quote":
      case "/api/admin/cancel": return ratesApi(env, user, path, b);
      case "/api/admin/bulk": {   // the same rule saved for several guest houses (or room types) at once, or several rates deleted / extended
        const kind = {rate: "/api/admin/rate", block: "/api/admin/block", cancel: "/api/admin/cancel"}[b.kind]; if (!kind) return json({error: "Choose what to update."}, 400);
        const cid = +b.client_id || 0, {results: owned} = await env.DB.prepare("SELECT id, name FROM guesthouses WHERE client_id = ?").bind(cid).all(), own = new Map(owned.map((g) => [g.id, g.name]));
        let items = Array.isArray(b.items) ? b.items.slice(0, 500) : [];
        if (b.op === "delete" || b.op === "extend") {
          if (kind !== "/api/admin/rate" && b.op === "extend") return json({error: "Only rates can be extended."}, 400);
          const tbl = kind === "/api/admin/rate" ? "gh_rates" : kind === "/api/admin/block" ? "gh_blocks" : "gh_cancel";
          if (b.op === "extend" && !isoD.test(b.to || "")) return json({error: "Pick the new last night."}, 400);
          let n = 0; for (const id of items.map((x) => +x).filter(Boolean)) { const r = await env.DB.prepare("SELECT id, gh_id, from_date FROM " + tbl + " WHERE id = ?").bind(id).first(); if (!r || !own.has(r.gh_id)) continue;
            if (b.op === "delete") await env.DB.prepare("DELETE FROM " + tbl + " WHERE id = ?").bind(id).run();
            else { if (b.to < r.from_date) continue; await env.DB.prepare("UPDATE gh_rates SET to_date = ?, by_email = ?, at = ? WHERE id = ?").bind(b.to, user.email, now, id).run(); }
            n++; }
          return json({ok: true, done: n, failed: []}); }
        // items: [{gh_id, room_type_id}] — one save per guest house / room type, with the shared fields
        const done = [], failed = [];
        for (const it of items) { const gid = +it.gh_id || 0; if (!own.has(gid)) { failed.push({gh_id: gid, error: "Not this client's guest house."}); continue; }
          const one = Object.assign({}, b, {gh_id: gid, room_type_id: +it.room_type_id || 0, id: undefined}); if (kind === "/api/admin/block") { one.rooms = Array.isArray(it.rooms) ? it.rooms : [];   // a room type: every room of that type
            if (!one.rooms.length && one.room_type_id) { const t = await env.DB.prepare("SELECT room_nos FROM room_types WHERE id = ? AND gh_id = ?").bind(one.room_type_id, gid).first(); one.rooms = t ? expandRooms(t.room_nos) : []; if (!one.rooms.length) { failed.push({gh_id: gid, name: own.get(gid), room_type_id: one.room_type_id, error: "That room type has no rooms."}); continue; } } }
          const r = await ratesApi(env, user, kind, one), j = await r.clone().json().catch(() => ({}));
          (r.status < 400 ? done : failed).push({gh_id: gid, name: own.get(gid), room_type_id: +it.room_type_id || 0, error: j.error || ""}); }
        return json({ok: true, done: done.length, failed}, done.length || !failed.length ? 200 : 400); }
      case "/api/admin/svc": {   // the client's service charge per booking (before 18% GST)
        const fee = Math.round((+b.svc_fee || 0) * 100) / 100; if (fee < 0 || fee > 1000000) return json({error: "Check the amount."}, 400);
        const r = await env.DB.prepare("UPDATE clients SET svc_fee = ? WHERE id = ?").bind(fee, +b.client_id || 0).run(); return json({ok: true, svc_fee: fee}); }
      case "/api/admin/client": {
        const name = clean(b.name, 120); if (!name) return json({error: "Enter the client name."}, 400);
        const grades = (Array.isArray(b.grades) ? b.grades : String(b.grades || DEFAULT_GRADES).split(",")).map((g) => clean(g, 20)).filter(Boolean).join(",") || DEFAULT_GRADES;
        if (b.id) await env.DB.prepare("UPDATE clients SET name = ?, grades = ?, active = ?, legal_name = ?, mail_cc = ?, mail_bcc = ? WHERE id = ?").bind(name, grades, b.active === false ? 0 : 1, clean(b.legal_name, 160), emailList(b.mail_cc).join(", "), emailList(b.mail_bcc).join(", "), +b.id).run();
        if (b.id && ("elig_male" in b || "elig_female" in b)) { const M = parseGrades(b.elig_male), F = parseGrades(b.elig_female);
          await env.DB.prepare("UPDATE clients SET elig = ? WHERE id = ?").bind(M.length || F.length ? JSON.stringify({Male: M, Female: F}) : null, +b.id).run(); }
        else { const r = await env.DB.prepare("INSERT INTO clients (name, grades, active, created) VALUES (?, ?, 1, ?)").bind(name, grades, now).run(); return json({ok: true, id: r.meta ? r.meta.last_row_id : r.lastInsertRowid}); }
        return json({ok: true, id: +b.id});
      }
      case "/api/admin/client/logo": {
        const c = await env.DB.prepare("SELECT id, logo_file FROM clients WHERE id = ?").bind(+b.client_id).first(); if (!c) return json({error: "No such client."}, 404);
        const fid = await saveFile(env, c.id, b.data_url);
        await env.DB.prepare("UPDATE clients SET logo_file = ? WHERE id = ?").bind(fid, c.id).run();
        if (c.logo_file) await env.DB.prepare("DELETE FROM files WHERE id = ?").bind(c.logo_file).run();
        return json({ok: true, logo: "/files/" + fid});
      }
      case "/api/admin/gh": {
        const name = clean(b.name, 120); if (!name) return json({error: "Enter the guest house name."}, 400);
        const c = await env.DB.prepare("SELECT id FROM clients WHERE id = ?").bind(+b.client_id).first(); if (!c) return json({error: "No such client."}, 404);
        const status = b.status === "Live" ? "Live" : "Coming soon";
        const show = {}; for (const k of Object.keys(SHOW_DEFAULT)) show[k] = !(b.show && b.show[k] === false);
        const tags = (a) => JSON.stringify((Array.isArray(a) ? a : []).map((x) => clean(x, 80)).filter(Boolean).slice(0, 40));
        const vals = [name, clean(b.city, 80), clean(b.state, 80), clean(b.country, 80), clean(b.address, 400), clean(b.map_url, 500), clean(b.operator, 120), status, clean(b.cancellation, 3000), tags(b.inclusions), tags(b.amenities), JSON.stringify(show), now];
        let id = +b.id || 0;
        if (id) { const ex = await env.DB.prepare("SELECT id FROM guesthouses WHERE id = ? AND client_id = ?").bind(id, c.id).first(); if (!ex) return json({error: "No such guest house."}, 404);
          await env.DB.prepare("UPDATE guesthouses SET name = ?, city = ?, state = ?, country = ?, address = ?, map_url = ?, operator = ?, status = ?, cancellation = ?, inclusions = ?, amenities = ?, show_json = ?, updated = ? WHERE id = ?").bind(...vals, id).run(); }
        else { const r = await env.DB.prepare("INSERT INTO guesthouses (name, city, state, country, address, map_url, operator, status, cancellation, inclusions, amenities, show_json, updated, client_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(...vals, c.id).run(); id = r.meta ? r.meta.last_row_id : r.lastInsertRowid; }
        const hhmm = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || "")) ? t : "";
        const stmts = [env.DB.prepare("UPDATE guesthouses SET checkin_time = ?, checkout_time = ?, team_emails = ? WHERE id = ?").bind(hhmm(b.checkin_time), hhmm(b.checkout_time), emailList(b.team_emails).join(", "), id), env.DB.prepare("DELETE FROM contacts WHERE gh_id = ?").bind(id)];
        const {results: oldRts} = await env.DB.prepare("SELECT id FROM room_types WHERE gh_id = ?").bind(id).all(), keepIds = new Set();
        const gradeList = (r) => [...new Set((Array.isArray(r.grades) ? r.grades : []).map((g) => clean(g, 20).replace(/,/g, " ")).filter(Boolean))];
        (Array.isArray(b.room_types) ? b.room_types : []).slice(0, 20).forEach((r, i) => {
          const v = [clean(r.name, 60), Math.max(0, Math.min(500, parseInt(r.rooms, 10) || 0)), clean(r.room_nos, 200), ["Single", "Double", "Single / Double"].includes(r.occupancy) ? r.occupancy : "Single", ["King", "Queen", "Twin", "Double"].includes(r.bed_type) ? r.bed_type : "", JSON.stringify(gradeList(r)), i];
          if (r.id && oldRts.some((o) => o.id === +r.id)) { keepIds.add(+r.id); stmts.push(env.DB.prepare("UPDATE room_types SET name = ?, rooms = ?, room_nos = ?, occupancy = ?, bed_type = ?, grades = ?, sort = ? WHERE id = ? AND gh_id = ?").bind(...v, +r.id, id)); }
          else stmts.push(env.DB.prepare("INSERT INTO room_types (gh_id, name, rooms, room_nos, occupancy, bed_type, grades, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id, ...v)); });
        oldRts.filter((o) => !keepIds.has(o.id)).forEach((o) => stmts.push(env.DB.prepare("DELETE FROM room_types WHERE id = ?").bind(o.id)));
        // grades typed in for a room type are added to the client's grade list
        const cg = await env.DB.prepare("SELECT grades FROM clients WHERE id = ?").bind(c.id).first();
        const before = (cg && cg.grades || DEFAULT_GRADES).split(",").filter(Boolean);
        const have = Array.isArray(b.client_grades) ? gradeList({grades: b.client_grades}) : before;   // the form can add or remove grades
        const next = have.concat([...new Set((Array.isArray(b.room_types) ? b.room_types : []).flatMap(gradeList))].filter((g) => !have.includes(g))).slice(0, 80);
        if (next.join(",") !== before.join(",")) stmts.push(env.DB.prepare("UPDATE clients SET grades = ? WHERE id = ?").bind(next.join(",") || DEFAULT_GRADES, c.id));
        (Array.isArray(b.contacts) ? b.contacts : []).slice(0, 20).forEach((x, i) => { if (clean(x.name) || clean(x.phone) || clean(x.email))
          stmts.push(env.DB.prepare("INSERT INTO contacts (gh_id, name, designation, email, phone, sort) VALUES (?, ?, ?, ?, ?, ?)").bind(id, clean(x.name, 120), clean(x.designation, 80), clean(x.email, 160), clean(x.phone, 60), i)); });
        await env.DB.batch(stmts);
        return json({ok: true, id});
      }
      case "/api/admin/gh/delete": {
        const id = +b.id; const {results: ph} = await env.DB.prepare("SELECT file_id FROM photos WHERE gh_id = ? UNION ALL SELECT file_id FROM documents WHERE gh_id = ? AND file_id IS NOT NULL").bind(id, id).all();
        await env.DB.batch([...ph.map((p) => env.DB.prepare("DELETE FROM files WHERE id = ?").bind(p.file_id)),
          ...["photos", "room_types", "contacts", "documents"].map((t) => env.DB.prepare("DELETE FROM " + t + " WHERE gh_id = ?").bind(id)), env.DB.prepare("DELETE FROM guesthouses WHERE id = ?").bind(id)]);
        return json({ok: true});
      }
      case "/api/admin/photo": {
        const g = await env.DB.prepare("SELECT id, client_id FROM guesthouses WHERE id = ?").bind(+b.gh_id).first(); if (!g) return json({error: "Save the guest house first."}, 404);
        const fid = await saveFile(env, g.client_id, b.data_url);
        const n = await env.DB.prepare("SELECT count(*) AS n FROM photos WHERE gh_id = ?").bind(g.id).first();
        await env.DB.prepare("INSERT INTO photos (gh_id, file_id, caption, sort) VALUES (?, ?, ?, ?)").bind(g.id, fid, clean(b.caption, 120), n ? n.n : 0).run();
        return json({ok: true, url: "/files/" + fid});
      }
      case "/api/admin/photo/delete": {
        const p = await env.DB.prepare("SELECT id, file_id FROM photos WHERE id = ?").bind(+b.id).first(); if (!p) return json({ok: true});
        await env.DB.batch([env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(p.id), env.DB.prepare("DELETE FROM files WHERE id = ?").bind(p.file_id)]);
        return json({ok: true});
      }
      case "/api/admin/user": {
        const email = clean(b.email, 200).toLowerCase();
        const ex = email && await env.DB.prepare("SELECT client_id FROM users WHERE email = ?").bind(email).first();
        const cid = ex && ex.client_id ? ex.client_id : +b.client_id;
        if (!(await env.DB.prepare("SELECT id FROM clients WHERE id = ?").bind(cid).first())) return json({error: "No such client."}, 404);
        return userAction(env, cid, b, user, "save");
      }
      case "/api/admin/doc": {
        const g = await env.DB.prepare("SELECT id, client_id FROM guesthouses WHERE id = ?").bind(+b.gh_id).first(); if (!g) return json({error: "No such guest house."}, 404);
        const iso = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || "") ? d : "";
        const type = DOC_TYPES.includes(b.doc_type) ? b.doc_type : "Other", title = clean(b.title, 120) || type;
        if (iso(b.issued) && iso(b.expires) && b.expires < b.issued) return json({error: "Expiry date is before the issue date."}, 400);
        const ex = b.id ? await env.DB.prepare("SELECT id, file_id FROM documents WHERE id = ? AND gh_id = ?").bind(+b.id, g.id).first() : null;
        if (b.id && !ex) return json({error: "No such document."}, 404);
        if (!ex && !b.data_url) return json({error: "Attach the document file (PDF or image)."}, 400);
        const fid = b.data_url ? await saveFile(env, g.client_id, b.data_url, true) : ex.file_id;
        const vals = [type, title, clean(b.number, 80), iso(b.issued), iso(b.expires), [15, 30, 45, 60, 90].includes(+b.remind_days) ? +b.remind_days : 30, b.visible === false ? 0 : 1, clean(b.file_name, 120) || (ex ? null : ""), now, fid];
        if (ex) { await env.DB.prepare("UPDATE documents SET doc_type = ?, title = ?, number = ?, issued = ?, expires = ?, remind_days = ?, visible = ?, file_name = COALESCE(NULLIF(?, ''), file_name), updated = ?, file_id = ?, last_notice = NULL WHERE id = ?").bind(...vals, ex.id).run();
          if (b.data_url && ex.file_id) await env.DB.prepare("DELETE FROM files WHERE id = ?").bind(ex.file_id).run(); return json({ok: true, id: ex.id}); }
        const r = await env.DB.prepare("INSERT INTO documents (doc_type, title, number, issued, expires, remind_days, visible, file_name, updated, file_id, gh_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(...vals, g.id).run();
        return json({ok: true, id: r.meta ? r.meta.last_row_id : r.lastInsertRowid});
      }
      case "/api/admin/doc/delete": {
        const d = await env.DB.prepare("SELECT id, file_id FROM documents WHERE id = ?").bind(+b.id).first(); if (!d) return json({ok: true});
        await env.DB.batch([env.DB.prepare("DELETE FROM documents WHERE id = ?").bind(d.id), env.DB.prepare("DELETE FROM files WHERE id = ?").bind(d.file_id || 0)]);
        return json({ok: true});
      }
      case "/api/admin/reminders": return json(await docReminders(env));
      case "/api/admin/tx/preview":
      case "/api/admin/tx/import": {
        const c = await env.DB.prepare("SELECT id FROM clients WHERE id = ?").bind(+b.client_id).first(); if (!c) return json({error: "No such client."}, 404);
        return txImport(env, c.id, b, user, path.endsWith("/preview"));
      }
      case "/api/admin/tx/uploads": return json({uploads: await txUploads(env, +b.client_id)});
      case "/api/admin/tx/undo": return txUndo(env, +b.client_id, b.id);
      case "/api/admin/tx/file": return txFile(env, +b.client_id, b.id);
      case "/api/admin/tx/stored": return txStored(env, +b.client_id);
      case "/api/admin/tx/remove": return txRemove(env, +b.client_id, b.code, user);
      case "/api/admin/tx/keep": return txKeep(env, +b.client_id, b.code);
      case "/api/admin/tx/restore": return txRestore(env, +b.client_id, b.id);
      case "/api/admin/sync/state":
      case "/api/admin/sync/save":
      case "/api/admin/sync/run":
      case "/api/admin/sync/test": return syncApi(env, user, path, b);
      case "/api/admin/booking":
      case "/api/admin/booking/delete":
      case "/api/admin/booking/restore": {
        const c = await env.DB.prepare("SELECT id, name, grades FROM clients WHERE id = ?").bind(+b.client_id).first(); if (!c) return json({error: "No such client."}, 404);
        return path.endsWith("/delete") ? cancelBooking(env, c, b) : path.endsWith("/restore") ? restoreBooking(env, c, b) : saveBooking(env, c, b);
      }
      case "/api/admin/user/reset":
      case "/api/admin/user/access": {
        const u = await env.DB.prepare("SELECT client_id, role FROM users WHERE email = ?").bind(clean(b.email, 200).toLowerCase()).first();
        if (!u || u.role === "admin" || !u.client_id) return json({error: "No such client user."}, 404);
        return userAction(env, u.client_id, b, user, path.endsWith("/access") ? "access" : "reset");
      }
    }
  } catch (e) { return json({error: e.message || "Something went wrong."}, 400); }
  return json({error: "Not found."}, 404);
}

async function dashboard(env, user, url) {
  const {results} = await env.DB.prepare("SELECT id, json, updated_at FROM datasets WHERE id IN ('bookings', 'properties', 'period')").all();
  const data = {}; let updated = "";
  for (const r of results) { data[r.id] = JSON.parse(r.json); if (r.id === "bookings") updated = r.updated_at; }
  data.bookings = (data.bookings || []).filter((b) => b.status !== "Cancelled");
  if (await multiClient(env)) {
    const {results: clients} = await env.DB.prepare("SELECT id, name, logo_file, grades, legal_name, mail_cc, mail_bcc, elig FROM clients WHERE active = 1 ORDER BY id").all();
    const want = user.admin ? (+url.searchParams.get("client") || (clients[0] || {}).id) : user.client_id;
    const client = clients.find((c) => c.id === want);
    if (!client) return html(LOGIN.replace("</body>", "<script>document.getElementById('err').textContent='Your account is not linked to a client yet. Please contact the Zuna Hotel Desk.';document.getElementById('err').classList.remove('hidden');</script></body>"));
    data.properties = await clientGuestHouses(env, client, false);
    const names = new Set(data.properties.map((p) => p.property));
    data.bookings = (data.bookings || []).filter((b) => names.has(b.property));
    data.client = {id: client.id, name: client.name, legal_name: client.legal_name || "", logo: client.logo_file ? "/files/" + client.logo_file : ""};
    if (user.book) { if (user.admin) { data.client.mail_cc = client.mail_cc || ""; data.client.mail_bcc = client.mail_bcc || ""; } data.client.grades = (client.grades || DEFAULT_GRADES).split(",").filter(Boolean); const el = eligOf(client); if (el) data.client.elig = el; }
    if (user.admin) data.clients = clients.map((c) => ({id: c.id, name: c.name}));
    if (user.tx) {   // travel policy caps (hotel rate per night by grade group and city zone) for the consolidated report's Eligibility column
      const pol = await env.DB.prepare("SELECT json FROM datasets WHERE id = ?").bind("policy:" + client.id).first();
      if (pol) { const P = jparse(pol.json, {}); data.policy = {caps: (P.hotel_caps || []).map((c) => ({group: c.group, zone: c.zone, cap: c.hotel_per_night})), zones: (P.city_zones || []).filter((z) => !/other/i.test(z.city)).map((z) => [z.city, z.zone])}; }
    }
    if (user.manager && !user.admin) data.users = await clientUsers(env, client.id);   // Users & access view, shown without a page load
  }
  await ghCodes(env, data.bookings || []);
  const payload = JSON.stringify(data).replace(/</g, "\\u003c");
  const userJs = JSON.stringify({name: user.name || "", email: user.email, admin: !!user.admin, manager: !!user.manager, tx: !!user.tx, book: !!user.book}).replace(/</g, "\\u003c");
  let page = TEMPLATE.replace("__DATA__", () => payload).replace("__USER__", () => userJs);
  if (updated) page = page.replace(/REPORT_DATE = '\d{4}-\d{2}-\d{2}'/, "REPORT_DATE = '" + updated.slice(0, 10) + "'");
  return html(page);
}

// ---- branded error pages ----
const ERR_ICON = {
  404: '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>',
  500: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>'};
const errorPage = (status, title, msg, href = "/", btn = "Go to the portal") => new Response(ERRPAGE.replace(/__CODE__/g, String(status)).replace(/__TITLE__/g, title).replace("__MSG__", msg).replace("__HREF__", href).replace("__BTN__", btn).replace("__ICON__", ERR_ICON[status] || ERR_ICON[500]),
  {status, headers: {"content-type": "text/html; charset=utf-8", "content-security-policy": CSP, "cache-control": "no-store", ...SEC}});
// sign-in page; if the browser still sent a session cookie it has expired, so say so and clear it
const signIn = (request) => {
  if (!getCookie(request, COOKIE)) return html(LOGIN);
  const note = "<script>(function(){var e=document.getElementById('err');if(!e)return;e.textContent='Your session has expired. Please sign in again.';e.className='mt-6 rounded-xl bg-amber-50 ring-1 ring-amber-200 px-4 py-3 text-sm text-amber-900 font-medium';e.setAttribute('role','status');})();</script></body>";
  return html(LOGIN.replace("</body>", note), {"set-cookie": COOKIE + "=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"});
};

const WORKER = {
  // daily (Cloudflare cron trigger): e-mail reminders for guest house documents nearing expiry
  // every 15 minutes: live hotel sync (new, changed and cancelled bookings of the last months); 02:30 UTC: nightly jobs
  async scheduled(event, env, ctx) {
    if (!event || event.cron !== "30 2 * * *") ctx.waitUntil(syncAll(env, "full").catch(() => null));
    if (event && event.cron && event.cron !== "30 2 * * *") return;
    ctx.waitUntil(docReminders(env)); ctx.waitUntil(backupNow(env, "nightly").catch(() => null));
    ctx.waitUntil(env.DB.prepare("DELETE FROM audit WHERE at < ?").bind(new Date(Date.now() - 3 * 365 * 864e5).toISOString()).run().catch(() => null)); },
  async fetch(request, env, ctx) {
    const path0 = new URL(request.url).pathname, body0 = await auditBody(request, path0);
    const res = await WORKER.route(request, env);
    if (body0) { const w = auditWrite(env, request, path0, body0, res); if (ctx && ctx.waitUntil) ctx.waitUntil(w); else await w; }
    return res;
  },
  async route(request, env) {
    try { return await handle(request, env); }
    catch (e) {
      console.error(e && e.stack || e);
      if (new URL(request.url).pathname.startsWith("/api/")) return json({error: "Something went wrong. Please try again."}, 500);
      return errorPage(500, "Something went wrong", "We couldn't load this page just now. Please try again in a moment. If it keeps happening, contact the Zuna Hotel Desk.", "/", "Try again");
    }
  },
};
async function handle(request, env) {
  {
    const url = new URL(request.url);
    if (env.PRIMARY_HOST && url.hostname !== env.PRIMARY_HOST && url.hostname.endsWith("zuna.ai") && (request.method === "GET" || request.method === "HEAD"))
      return new Response(null, {status: 301, headers: {location: "https://" + env.PRIMARY_HOST + url.pathname + url.search, ...SEC}});
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const API = {"/api/login": login, "/api/forgot": forgot, "/api/reset": resetPassword, "/api/vouchers": vouchers};
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
    if (path.startsWith("/api/admin/") && request.method === "POST") {
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) return json({error: "Bad origin."}, 403);
      if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) return json({error: "Bad request."}, 415);
      const u = await currentUser(request, env);
      if (!u || !u.admin) return json({error: "Not allowed."}, 403);
      return adminApi(request, env, u, path);
    }
    if ((path === "/api/trips" || path === "/api/bookings" || path === "/api/guests" || path.startsWith("/api/book")) && request.method === "POST") {   // Book a room + Trips
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) return json({error: "Bad origin."}, 403);
      const u = await currentUser(request, env);
      if (!u) return json({error: "Your session has expired."}, 403);
      return bookApi(request, env, u, path);
    }
    if (path === "/api/tx" && request.method === "POST") {   // hotel bookings for the signed-in client
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) return json({error: "Bad origin."}, 403);
      const u = await currentUser(request, env);
      if (!u) return json({error: "Your session has expired."}, 403);
      if (!u.tx) return json({error: "You don't have access to hotel bookings. Ask your admin."}, 403);
      let b; try { b = await request.json(); } catch (e) { return json({error: "Bad request."}, 400); }
      const cid = u.admin ? +b.client_id : u.client_id;
      if (!cid) return json({error: "No client."}, 400);
      return txList(env, cid, b);
    }
    if (path === "/api/tx/voucher" && request.method === "POST") {   // partner voucher links of one hotel booking
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) return json({error: "Bad origin."}, 403);
      const u = await currentUser(request, env);
      if (!u) return json({error: "Your session has expired."}, 403);
      if (!u.tx) return json({error: "You don't have access to hotel bookings. Ask your admin."}, 403);
      let b; try { b = await request.json(); } catch (e) { return json({error: "Bad request."}, 400); }
      const cid = u.admin ? +b.client_id : u.client_id;
      if (!cid) return json({error: "No client."}, 400);
      return txVoucher(env, cid, b.code);
    }
    if (path.startsWith("/api/manage/") && request.method === "POST") {
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) return json({error: "Bad origin."}, 403);
      if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) return json({error: "Bad request."}, 415);
      const u = await currentUser(request, env);
      if (!u || !u.manager) return json({error: "Not allowed."}, 403);
      return manageApi(request, env, u, path);
    }
    if (path === "/manage") {
      const u = await currentUser(request, env);
      if (!u) return signIn(request);
      if (u.admin) return redirect("/admin");
      return redirect(u.manager ? "/#users" : "/");   // Users & access lives inside the dashboard
    }
    const fm = path.match(/^\/files\/(\d+)$/);
    if (fm) { const u = await currentUser(request, env); return u ? serveFile(env, u, +fm[1]) : new Response("Not found", {status: 404, headers: SEC}); }
    if (path === "/admin") {
      const u = await currentUser(request, env);
      if (!u) return signIn(request);
      if (!u.admin) return redirect("/");
      const safe = (o) => JSON.stringify(o).replace(/</g, "\\u003c").replace(/\u2028|\u2029/g, "");
      const st = await adminState(env, u);   // sent with the page so it shows immediately
      return html(ADMIN.replace("__ME__", () => safe({name: u.name || "", email: u.email})).replace("__STATE__", () => safe(st)), {"content-security-policy": ADMIN_CSP});
    }
    if (path !== "/") {
      if (request.method === "GET" || request.method === "HEAD") return errorPage(404, "Page not found", "The page you're looking for doesn't exist or has moved. Check the address, or go back to the guest house portal.", "/", "Go to the portal");
      return json({error: "Not found."}, 404);
    }
    const user = await currentUser(request, env);
    if (!user) return signIn(request);
    return dashboard(env, user, url);
  }
}

export default WORKER;
const LOGIN = "";
const ERRPAGE = "";
const TEMPLATE = "";
const ADMIN = "";
