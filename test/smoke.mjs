// End-to-end smoke test of the built app (run `npm run build` first). No network, no browser.
//   npm test
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {openDb} from '../server/db.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const worker = (await import(pathToFileURL(path.join(root, 'worker.mjs')).href)).default;
const DB = openDb(':memory:');
DB.raw.exec(fs.readFileSync(path.join(root, 'test', 'schema.sql'), 'utf8'));
const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.pbkdf2Sync('Smoke-Test-123', Buffer.from(salt, 'hex'), 10000, 32, 'sha256').toString('hex');
DB.raw.prepare('INSERT INTO users (email, name, salt, hash) VALUES (?, ?, ?, ?)').run('smoke@example.com', 'Smoke Test', salt, hash);

const mails = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => String(u).startsWith('https://api.resend.com/') ? (mails.push(JSON.parse(o.body)), new Response('{}', {status: 200})) : realFetch(u, o);

const ORIGIN = 'https://gh.example.com';
let env = {DB};
const call = (p, {method = 'GET', body, headers = {}, cookie} = {}) => worker.fetch(new Request(ORIGIN + p, {method, body: body && JSON.stringify(body),
  headers: {...(body ? {'content-type': 'application/json'} : {}), ...(cookie ? {cookie} : {}), ...headers}}), env);
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || !extra ? '' : '  -> ' + extra)); };

let r = await call('/');
const loginHtml = await r.text();
check('login page served', r.status === 200 && loginHtml.includes('id="f"'));
check('security headers', !!r.headers.get('content-security-policy') && r.headers.get('x-frame-options') === 'DENY' && !!r.headers.get('strict-transport-security'));
check('no unfilled build placeholders', !/__[A-Z]+__|\/\*__CSS__\*\//.test(loginHtml));

r = await call('/api/login', {method: 'POST', body: {email: 'smoke@example.com', password: 'wrong'}});
check('wrong password -> 401', r.status === 401);
r = await call('/api/login', {method: 'POST', body: {email: 'nobody@example.com', password: 'x'}});
check('unknown user -> 401 (same message)', r.status === 401 && (await r.json()).error === 'Incorrect email or password.');
r = await worker.fetch(new Request(ORIGIN + '/api/login', {method: 'POST', headers: {'content-type': 'text/plain'}, body: '{}'}), env);
check('non-JSON POST -> 415', r.status === 415);
r = await call('/api/login', {method: 'POST', body: {}, headers: {origin: 'https://evil.example'}});
check('cross-origin POST -> 403', r.status === 403);

r = await call('/api/login', {method: 'POST', body: {email: 'Smoke@Example.com', password: 'Smoke-Test-123', remember: true}});
const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
check('login ok (case-insensitive email)', r.status === 200 && cookie.startsWith('ltmgh_s='));
check('cookie is HttpOnly + Secure + SameSite', /HttpOnly/.test(r.headers.get('set-cookie')) && /Secure/.test(r.headers.get('set-cookie')) && /SameSite=Lax/.test(r.headers.get('set-cookie')));
r = await call('/', {cookie});
const dash = await r.text();
check('dashboard served with data', r.status === 200 && dash.includes('Arjun Mehta') && !dash.includes('__DATA__'));

r = await call('/api/forgot', {method: 'POST', body: {email: 'smoke@example.com'}});
check('forgot without mail key -> 503', r.status === 503);
env = {DB, RESEND_API_KEY: 'test'};
r = await call('/api/forgot', {method: 'POST', body: {email: 'nobody@example.com'}});
check('forgot unknown email -> 200, no mail', r.status === 200 && mails.length === 0);
r = await call('/api/forgot', {method: 'POST', body: {email: 'smoke@example.com'}});
const code = (mails[0]?.text.match(/\b(\d{6})\b/) || [])[1];
check('forgot sends a 6-digit code', r.status === 200 && !!code);
r = await call('/api/reset', {method: 'POST', body: {email: 'smoke@example.com', code: '000000', password: 'New-Password-2026'}});
check('wrong code rejected', r.status === 400);
r = await call('/api/reset', {method: 'POST', body: {email: 'smoke@example.com', code, password: 'short'}});
check('weak password rejected', r.status === 400);
r = await call('/api/reset', {method: 'POST', body: {email: 'smoke@example.com', code, password: 'New-Password-2026'}});
check('reset with right code', r.status === 200);
r = await call('/', {cookie});
check('old sessions signed out after reset', (await r.text()).includes('id="f"'));
r = await call('/api/login', {method: 'POST', body: {email: 'smoke@example.com', password: 'New-Password-2026'}});
check('new password works', r.status === 200);
const cookie2 = (r.headers.get('set-cookie') || '').split(';')[0];

for (let i = 0; i < 5; i++) await call('/api/login', {method: 'POST', body: {email: 'smoke@example.com', password: 'bad' + i}});
r = await call('/api/login', {method: 'POST', body: {email: 'smoke@example.com', password: 'New-Password-2026'}});
check('lockout after 5 wrong passwords', r.status === 429);

r = await call('/logout', {cookie: cookie2});
check('logout clears cookie', r.status === 302 && /Max-Age=0/.test(r.headers.get('set-cookie') || ''));

env = {DB, PRIMARY_HOST: 'gh.zuna.ai'};
r = await worker.fetch(new Request('https://ltmgh.zuna.ai/x?y=1'), env);
check('old host redirects to PRIMARY_HOST', r.status === 301 && r.headers.get('location') === 'https://gh.zuna.ai/x?y=1');

// voucher intake: a tiny hand-made PDF with a Flate-compressed content stream
{
  const zlib = await import('node:zlib');
  const content = zlib.deflateSync(Buffer.from('BT /F1 12 Tf 72 720 Td (Guest Name: Mr. Test Guest) Tj 0 -16 Td (Room No: 03) Tj 0 -16 Td (Occupancy: Single) Tj ET'));
  const parts = ['%PDF-1.4\n', '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n', '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n',
    '3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj\n',
    '4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n', `5 0 obj << /Length ${content.length} /Filter /FlateDecode >> stream\n`];
  const pdf = Buffer.concat([Buffer.from(parts.join('')), content, Buffer.from('\nendstream endobj\ntrailer << /Root 1 0 R >>\n%%EOF')]);
  const vpost = (body, tok) => worker.fetch(new Request(ORIGIN + '/api/vouchers', {method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer ' + tok}, body: JSON.stringify(body)}), env);
  env = {DB, VOUCHER_TOKEN: 'v-secret'};
  check('voucher intake refuses a wrong token', (await vpost({known: []}, 'wrong')).status === 401);
  r = await vpost({key: 'm1#0', received: '2026-10-30 13:36', from: 'bookings@example.com', subject: 'Re: Booking', file: 'Mr. Test Guest.pdf', pdf: pdf.toString('base64')}, 'v-secret');
  const vj = await r.json();
  check('voucher PDF text extracted (guest, room, occupancy)', r.status === 200 && vj.guest === 'Mr. Test Guest' && vj.room === '03' && vj.occupancy === 'Single', JSON.stringify(vj));
  r = await vpost({known: ['m1#0', 'm2#0']}, 'v-secret');
  check('voucher "known" lookup', JSON.stringify((await r.json()).known) === '["m1#0"]');
  // a Sapphire-style voucher fills the room of the matching booking straight away
  {
    const lines = ['Guest Name', 'Ms . Neha Joshi', 'Arrival Date 02 - Nov - 2026', 'Departure Date 0 4 - Nov - 2026', 'Room Type Room in an Apartment', 'Room No 03'];
    const c2 = zlib.deflateSync(Buffer.from('BT /F1 10 Tf 50 800 Td ' + lines.map((l) => '(' + l + ') Tj 0 -12 Td').join(' ') + ' ET'));
    const p2 = Buffer.concat([Buffer.from(parts.slice(0, 5).join('') + `5 0 obj << /Length ${c2.length} /Filter /FlateDecode >> stream\n`), c2, Buffer.from('\nendstream endobj\ntrailer << /Root 1 0 R >>\n%%EOF')]);
    r = await vpost({key: 'm3#0', file: 'Ms. Neha Joshi.pdf', pdf: p2.toString('base64')}, 'v-secret');
    const aj = await r.json();
    const neha = JSON.parse(DB.raw.prepare("SELECT json FROM datasets WHERE id = 'bookings'").get().json).find((b) => b.guest === 'Ms. Neha Joshi');
    check('voucher room applied to booking immediately', /set for Ms. Neha Joshi/.test(aj.applied) && neha.room === '1001-103', aj.applied);
    r = await vpost({key: 'm4#0', file: 'Mr. Neha Joshi.pdf', pdf: p2.toString('base64').replace(/x/g, 'x')}, 'v-secret');
    check('voucher never overwrites an assigned room', /already set/.test((await r.json()).applied));
  }
  env = {DB};
  check('voucher intake off without VOUCHER_TOKEN', (await vpost({known: []}, '')).status === 401);
}

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
