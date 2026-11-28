// Zuna relay: a fixed-IP exit for portal calls to partner APIs that whitelist by IP.
// The portal (Cloudflare Worker) calls POST /forward with the shared key; the relay calls the partner API
// from this server's reserved IP and returns the answer. Only hosts listed in ALLOW_HOSTS can be reached.
import http from 'node:http';

const KEY = process.env.RELAY_KEY || '';
const ALLOW = new Set((process.env.ALLOW_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean));
const PORT = +process.env.PORT || 8080, MAX = 10 * 1024 * 1024, TIMEOUT = 60000;
if (KEY.length < 32) { console.error('RELAY_KEY missing or too short'); process.exit(1); }

const send = (res, code, obj) => { res.writeHead(code, {'content-type': 'application/json', 'cache-control': 'no-store'}); res.end(JSON.stringify(obj)); };
const same = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, {ok: true});
    if (!same(String(req.headers['x-relay-key'] || ''), KEY)) return send(res, 401, {error: 'Not allowed.'});
    if (req.method === 'GET' && req.url === '/ip') {   // which IP partners see (should be the reserved IP)
      const r = await fetch('https://api.ipify.org?format=json', {signal: AbortSignal.timeout(10000)}); return send(res, 200, await r.json()); }
    if (req.method !== 'POST' || req.url !== '/forward') return send(res, 404, {error: 'Not found.'});
    const chunks = []; let size = 0; for await (const c of req) { size += c.length; if (size > MAX) return send(res, 413, {error: 'Too large.'}); chunks.push(c); }
    const b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    let u; try { u = new URL(b.url); } catch (e) { return send(res, 400, {error: 'Bad url.'}); }
    if (u.protocol !== 'https:' || !ALLOW.has(u.hostname.toLowerCase())) return send(res, 403, {error: 'Host not allowed: ' + u.hostname});
    const method = String(b.method || 'GET').toUpperCase();
    const r = await fetch(u, {method, headers: b.headers || {}, body: ['GET', 'HEAD'].includes(method) ? undefined : (b.body_b64 ? Buffer.from(b.body_b64, 'base64') : b.body), redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT)});
    const buf = Buffer.from(await r.arrayBuffer()), headers = {}; r.headers.forEach((v, k) => { headers[k] = v; });
    console.log(new Date().toISOString(), method, u.hostname + u.pathname, r.status, buf.length);
    send(res, 200, {status: r.status, headers, body_b64: buf.toString('base64')});
  } catch (e) { console.error(e && e.message); send(res, 502, {error: 'Relay could not reach the partner: ' + (e && e.message || 'error')}); }
}).listen(PORT, '127.0.0.1', () => console.log('relay on 127.0.0.1:' + PORT + ' · allowed: ' + ([...ALLOW].join(', ') || 'none yet')));
