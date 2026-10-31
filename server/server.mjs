// Self-hosted runner: serves the same app as the Cloudflare Worker, on Node.js 22+ with a SQLite file.
// Put it behind an HTTPS reverse proxy (nginx, IIS ARR, a load balancer...) that sets X-Forwarded-Proto.
//
//   npm run build && npm start
//
// Environment:
//   PORT              default 8080
//   HOST              default 0.0.0.0
//   DB_PATH           default ./var/ltmgh.sqlite
//   RESEND_API_KEY    enables "Forgot password" e-mails (resend.com)
//   MAIL_FROM         default "Zuna Hotel Desk <noreply@zuna.ai>"
//   PRIMARY_HOST      e.g. gh.zuna.ai: other *.zuna.ai hosts 301-redirect there
//   TRUST_PROXY       "1" (default) uses X-Forwarded-Proto / X-Forwarded-Host
//   INSECURE_COOKIES  "1" only for local testing over plain http on a non-localhost name
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {openDb} from './db.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const worker = (await import(pathToFileURL(path.join(root, 'worker.mjs')).href)).default;
const E = process.env;
const env = {
  DB: openDb(E.DB_PATH || path.join(root, 'var', 'ltmgh.sqlite')),
  RESEND_API_KEY: E.RESEND_API_KEY || '',
  MAIL_FROM: E.MAIL_FROM || undefined,
  PRIMARY_HOST: E.PRIMARY_HOST || '',
  VOUCHER_TOKEN: E.VOUCHER_TOKEN || '',
};
const trust = E.TRUST_PROXY !== '0', MAX_BODY = 12 * 1024 * 1024;  // vouchers carry base64 PDFs

const server = http.createServer(async (req, res) => {
  try {
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > MAX_BODY) { res.writeHead(413).end(); return; } chunks.push(c); }
    const proto = (trust && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()) || (req.socket.encrypted ? 'https' : 'http');
    const host = (trust && req.headers['x-forwarded-host']) || req.headers.host || 'localhost';
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    const r = await worker.fetch(new Request(proto + '://' + host + req.url, {method: req.method, headers, body: chunks.length && !['GET', 'HEAD'].includes(req.method) ? Buffer.concat(chunks) : undefined}), env);
    const out = {};
    r.headers.forEach((v, k) => { if (k !== 'set-cookie') out[k] = v; });
    const cookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (cookies.length) out['set-cookie'] = E.INSECURE_COOKIES === '1' ? cookies.map((c) => c.replace(/;\s*Secure/i, '')) : cookies;
    res.writeHead(r.status, out);
    res.end(req.method === 'HEAD' ? undefined : Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    console.error(new Date().toISOString(), req.method, req.url, e);
    if (!res.headersSent) res.writeHead(500, {'content-type': 'text/plain'});
    res.end('Server error');
  }
});
server.listen(+(E.PORT || 8080), E.HOST || '0.0.0.0', () => console.log('Guest house portal listening on', (E.HOST || '0.0.0.0') + ':' + (E.PORT || 8080)));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => server.close(() => process.exit(0)));
