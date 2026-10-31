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
  return json({ok: true, chars: text.length, guest, room: vGuess(V_ROOM, text), occupancy: vGuess(V_OCC, text)});
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
    if (path !== "/") return redirect("/");
    const user = await currentUser(request, env);
    if (!user) return html(LOGIN);
    return dashboard(env, user);
  }
};

const LOGIN = "";
const TEMPLATE = "";
