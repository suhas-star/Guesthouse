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
  const row = await env.DB.prepare("SELECT s.email, s.expires, u.name, u.active, u.role, u.client_id FROM sessions s JOIN users u ON u.email = s.email WHERE s.token_hash = ?").bind(await sha256(tok)).first();
  if (!row || !row.active || row.expires < new Date().toISOString()) return null;
  return {email: row.email, name: row.name, role: row.role || "client", client_id: row.client_id, admin: row.role === "admin", manager: row.role === "client_admin" && !!row.client_id};
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
];
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  for (const q of SCHEMA) await env.DB.prepare(q).run();
  for (const c of ["users ADD COLUMN role TEXT", "users ADD COLUMN client_id INTEGER", "guesthouses ADD COLUMN state TEXT", "guesthouses ADD COLUMN country TEXT", "room_types ADD COLUMN bed_type TEXT"]) { try { await env.DB.prepare("ALTER TABLE " + c).run(); } catch (e) { /* exists */ } }
  schemaReady = true;
}
const DEFAULT_GRADES = "M1,M2,M3,M4,M5,M6,M7,M8,P1,P2,P3,E1,E2,E3,E4,E5,E6,E7";
const SHOW_DEFAULT = {amenities: true, inclusions: true, cancellation: true, photos: true, contacts: true};
const jparse = (t, d) => { try { const v = JSON.parse(t); return v == null ? d : v; } catch (e) { return d; } };
const list = (t) => jparse(t, []).filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().slice(0, 120));
// "E1,E2,E3,P1,P2,P3" -> "E1–E3, P1–P3"; every grade -> "All grades"
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
  const {results: clients} = await env.DB.prepare("SELECT id, name, logo_file, grades, active FROM clients ORDER BY id").all();
  const [bk, mn] = await Promise.all([readSet(env, "bookings"), readSet(env, "manual")]), manualKeys = new Set(mn.rows.filter((x) => x.status !== "Cancelled").map(guestKey));
  const out = await Promise.all(clients.map(async (c) => {
    const [users, guesthouses] = await Promise.all([clientUsers(env, c.id), clientGuestHouses(env, c, true)]);
    const names = new Set(guesthouses.map((g) => g.property));
    return {id: c.id, name: c.name, active: !!c.active, logo: c.logo_file ? "/files/" + c.logo_file : "", grades: (c.grades || DEFAULT_GRADES).split(",").filter(Boolean), users, guesthouses,
      bookings: bk.rows.filter((x) => names.has(x.property) && x.status !== "Cancelled").map((x) => Object.assign({}, x, {manual: manualKeys.has(guestKey(x))}))}; }));
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
async function clientUsers(env, cid) { const {results} = await env.DB.prepare("SELECT email, name, active, last_login, locked_until, role FROM users WHERE client_id = ? AND (role IS NULL OR role <> 'admin') ORDER BY name").bind(cid).all(); return results.map((u) => Object.assign(u, {role: u.role === "client_admin" ? "client_admin" : "client"})); }
async function userAction(env, cid, b, actor, action) {
  const email = clean(b.email, 200).toLowerCase(), name = clean(b.name, 120), role = b.role === "client_admin" ? "client_admin" : "client";
  if (!email) return json({error: "Enter an email address or user ID."}, 400);
  const ex = await env.DB.prepare("SELECT email, name, role, client_id FROM users WHERE email = ?").bind(email).first();
  if (ex && (ex.role === "admin" || ex.client_id !== cid)) return json({error: ex.role === "admin" ? "That account is a Zuna admin." : "That email already has an account."}, 400);
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
      id: g.id, property: g.name, city: g.city || "", state: g.state || "", country: g.country || "", address: g.address || "", map_url: g.map_url || "", operator: g.operator || "", status: g.status || "Coming soon",
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
    if (forAdmin) gh.show = show;
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
  const gender = title === "Mr." ? "Male" : title === "Ms." || title === "Mrs." ? "Female" : ["Male", "Female"].includes(r.gender) ? r.gender : "Not stated";
  const row = {property: gh.property, guest: (title ? title + " " : "") + name, grade: clean(r.grade, 20) || "Not stated", base: clean(r.base, 60) || "Not stated", check_in: r.check_in, check_out: r.check_out,
    nights: String(Math.round((Date.parse(r.check_out) - Date.parse(r.check_in)) / 864e5)), room, status, concur_tr: clean(r.concur_tr, 40), note: clean(r.note, 300), gender, occupancy: r.occupancy === "Double" ? "Double" : "Single"};
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
  const man = mn.rows.filter((x) => guestKey(x) !== key); man.push(Object.assign({}, old, {status: "Cancelled", note: "Cancelled from the admin panel"}));
  await env.DB.batch([writeSet(env, "bookings", bk.rows.filter((x) => x !== old), istToday()), writeSet(env, "manual", man, istToday())]);
  return json({ok: true});
}

async function adminApi(req, env, user, path) {
  let b; try { b = await req.json(); } catch (e) { return json({error: "Bad request."}, 400); }
  const now = new Date().toISOString();
  try {
    switch (path) {
      case "/api/admin/state": return json(await adminState(env, user));
      case "/api/admin/client": {
        const name = clean(b.name, 120); if (!name) return json({error: "Enter the client name."}, 400);
        const grades = (Array.isArray(b.grades) ? b.grades : String(b.grades || DEFAULT_GRADES).split(",")).map((g) => clean(g, 20)).filter(Boolean).join(",") || DEFAULT_GRADES;
        if (b.id) await env.DB.prepare("UPDATE clients SET name = ?, grades = ?, active = ? WHERE id = ?").bind(name, grades, b.active === false ? 0 : 1, +b.id).run();
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
        const stmts = [env.DB.prepare("DELETE FROM room_types WHERE gh_id = ?").bind(id), env.DB.prepare("DELETE FROM contacts WHERE gh_id = ?").bind(id)];
        const gradeList = (r) => [...new Set((Array.isArray(r.grades) ? r.grades : []).map((g) => clean(g, 20).replace(/,/g, " ")).filter(Boolean))];
        (Array.isArray(b.room_types) ? b.room_types : []).slice(0, 20).forEach((r, i) => stmts.push(env.DB.prepare("INSERT INTO room_types (gh_id, name, rooms, room_nos, occupancy, bed_type, grades, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(id, clean(r.name, 60), Math.max(0, Math.min(500, parseInt(r.rooms, 10) || 0)), clean(r.room_nos, 200), ["Single", "Double", "Single / Double"].includes(r.occupancy) ? r.occupancy : "Single", ["King", "Queen", "Twin", "Double"].includes(r.bed_type) ? r.bed_type : "", JSON.stringify(gradeList(r)), i)));
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
      case "/api/admin/booking":
      case "/api/admin/booking/delete": {
        const c = await env.DB.prepare("SELECT id, name, grades FROM clients WHERE id = ?").bind(+b.client_id).first(); if (!c) return json({error: "No such client."}, 404);
        return path.endsWith("/delete") ? cancelBooking(env, c, b) : saveBooking(env, c, b);
      }
      case "/api/admin/user/reset": {
        const u = await env.DB.prepare("SELECT client_id, role FROM users WHERE email = ?").bind(clean(b.email, 200).toLowerCase()).first();
        if (!u || u.role === "admin" || !u.client_id) return json({error: "No such client user."}, 404);
        return userAction(env, u.client_id, b, user, "reset");
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
    const {results: clients} = await env.DB.prepare("SELECT id, name, logo_file, grades FROM clients WHERE active = 1 ORDER BY id").all();
    const want = user.admin ? (+url.searchParams.get("client") || (clients[0] || {}).id) : user.client_id;
    const client = clients.find((c) => c.id === want);
    if (!client) return html(LOGIN.replace("</body>", "<script>document.getElementById('err').textContent='Your account is not linked to a client yet. Please contact the Zuna Hotel Desk.';document.getElementById('err').classList.remove('hidden');</script></body>"));
    data.properties = await clientGuestHouses(env, client, false);
    const names = new Set(data.properties.map((p) => p.property));
    data.bookings = (data.bookings || []).filter((b) => names.has(b.property));
    data.client = {id: client.id, name: client.name, logo: client.logo_file ? "/files/" + client.logo_file : ""};
    if (user.admin) data.clients = clients.map((c) => ({id: c.id, name: c.name}));
  }
  const payload = JSON.stringify(data).replace(/</g, "\\u003c");
  const userJs = JSON.stringify({name: user.name || "", email: user.email, admin: !!user.admin, manager: !!user.manager}).replace(/</g, "\\u003c");
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

export default {
  // daily (Cloudflare cron trigger): e-mail reminders for guest house documents nearing expiry
  async scheduled(event, env, ctx) { ctx.waitUntil(docReminders(env)); },
  async fetch(request, env) {
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
      if (!u.manager) return redirect("/");
      const safe = (o) => JSON.stringify(o).replace(/</g, "\\u003c").replace(/\u2028|\u2029/g, "");
      const st = await manageState(env, u);
      return html(ADMIN.replace("__ME__", () => safe({name: u.name || "", email: u.email, mode: "client"})).replace("__STATE__", () => safe(st)), {"content-security-policy": ADMIN_CSP});
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

const LOGIN = "";
const ERRPAGE = "";
const TEMPLATE = "";
const ADMIN = "";
