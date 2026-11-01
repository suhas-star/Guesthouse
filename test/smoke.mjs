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

// ---------- admin panel / multi-client ----------
{
  env = {DB};
  const mk = (email, role, client) => { const sl = crypto.randomBytes(16).toString('hex');
    DB.raw.prepare('INSERT OR REPLACE INTO users (email, name, salt, hash, active, failed) VALUES (?, ?, ?, ?, 1, 0)').run(email, email, sl, crypto.pbkdf2Sync('Pass-word-123', Buffer.from(sl, 'hex'), 10000, 32, 'sha256').toString('hex')); };
  await call('/');                                   // runs schema setup (role / client_id columns)
  mk('boss@zuna.example'); DB.raw.prepare("UPDATE users SET role = 'admin' WHERE email = 'boss@zuna.example'").run();
  const loginAs = async (email) => (await call('/api/login', {method: 'POST', body: {email, password: 'Pass-word-123'}})).headers.get('set-cookie').split(';')[0];
  const admin = await loginAs('boss@zuna.example');
  const A = async (p, body) => { const x = await call('/api/admin/' + p, {method: 'POST', body, cookie: admin}); return {status: x.status, j: await x.json()}; };
  let x = await A('client', {name: 'Acme'}); const acme = x.j.id;
  x = await A('client', {name: 'Other Co'}); const other = x.j.id;
  check('admin creates clients', !!acme && !!other);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  x = await A('client/logo', {client_id: acme, data_url: png}); check('admin uploads client logo', x.status === 200 && /^\/files\/\d+$/.test(x.j.logo));
  const logoUrl = x.j.logo;
  x = await A('gh', {client_id: acme, name: 'Acme House', city: 'Pune', status: 'Live', address: '1 Main Rd', cancellation: 'Free until 24h before',
    inclusions: ['Breakfast'], amenities: ['Wi-Fi'], show: {photos: false},
    room_types: [{name: 'Deluxe', rooms: 2, room_nos: 'A1 to A2', occupancy: 'Single', grades: ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7']}, {name: 'Suite', rooms: 1, room_nos: 'S1', occupancy: 'Double', grades: ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'P1', 'P2', 'P3', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7']}],
    contacts: [{name: 'Ravi', designation: 'Caretaker', phone: '+91 90000 00000', email: 'ravi@acme.example'}]});
  const gh = x.j.id; check('admin creates guest house with room types and contacts', x.status === 200 && !!gh);
  x = await A('photo', {gh_id: gh, data_url: png}); check('admin uploads guest house photo', x.status === 200);
  await A('gh', {client_id: other, name: 'Other House', status: 'Live', room_types: [{name: 'Std', rooms: 1, room_nos: 'X1', grades: []}]});
  x = await A('user', {client_id: acme, name: 'Asha Rao', email: 'asha@acme.example'});
  check('admin creates client user with generated password', x.j.created === true && /^Asha@[2-9]{4}$/.test(x.j.password), JSON.stringify(x.j));
  const ashaPw = x.j.password;
  x = await A('state', {}); const st = x.j.clients.find((c) => c.id === acme);
  check('admin state lists guest house, eligibility text and user', st.guesthouses[0].room_types[0].eligible === 'E1–E7' && st.guesthouses[0].room_types[1].eligible === 'All grades' && st.users.length === 1);
  // client user
  r = await call('/api/login', {method: 'POST', body: {email: 'asha@acme.example', password: ashaPw}});
  const asha = (r.headers.get('set-cookie') || '').split(';')[0];
  check('client user logs in with generated password', r.status === 200);
  const page = await (await call('/', {cookie: asha})).text();
  const data = JSON.parse(page.match(/window\.__LTMGH_DATA = (.*?);\nconst REPORT_DATE/s)[1]);
  check('client sees only its own guest houses', data.properties.length === 1 && data.properties[0].property === 'Acme House' && data.client.name === 'Acme');
  check('hidden sections are not sent to client (photos off)', !('photos' in data.properties[0]) && data.properties[0].cancellation === 'Free until 24h before' && data.properties[0].rooms_list.join() === 'A1,A2,S1');
  check('client user cannot use admin API', (await call('/api/admin/state', {method: 'POST', body: {}, cookie: asha})).status === 403);
  check('client user cannot open /admin', (await call('/admin', {cookie: asha})).status === 302);
  check('client user can load own logo', (await call(logoUrl, {cookie: asha})).status === 200);
  const otherLogo = await A('client/logo', {client_id: other, data_url: png});
  check("client user cannot load another client's files", (await call(otherLogo.j.logo, {cookie: asha})).status === 404);
  check('admin page served to admin', /Admin/.test(await (await call('/admin', {cookie: admin})).text()));
  // bookings from the admin panel
  x = await A('booking', {client_id: acme, row: {property: 'Acme House', title: 'Ms.', name: 'Neha Iyer', grade: 'E2', base: 'Pune', check_in: '2026-11-03', check_out: '2026-11-05', room: 'A1', occupancy: 'Single', status: 'Confirmed'}});
  check('admin adds a booking', x.status === 200 && x.j.row.guest === 'Ms. Neha Iyer' && x.j.row.gender === 'Female' && x.j.row.nights === '2' && x.j.row.room === 'A1');
  x = await A('booking', {client_id: acme, row: {property: 'Other House', name: 'X', check_in: '2026-11-03', check_out: '2026-11-04'}});
  check("booking can't go to another client's guest house", x.status === 400);
  x = await A('booking', {client_id: acme, row: {property: 'Acme House', name: 'Y', check_in: '2026-11-05', check_out: '2026-11-03'}});
  check('booking with check-out before check-in refused', x.status === 400);
  x = await A('booking', {client_id: acme, original: {guest: 'Ms. Neha Iyer', check_in: '2026-11-03'}, row: {property: 'Acme House', title: 'Ms.', name: 'Neha Iyer', check_in: '2026-11-04', check_out: '2026-11-06', room: 'Z9', status: 'Confirmed'}});
  let mrow = JSON.parse(DB.raw.prepare("SELECT json FROM datasets WHERE id = 'manual'").get().json);
  let brow = JSON.parse(DB.raw.prepare("SELECT json FROM datasets WHERE id = 'bookings'").get().json);
  check('edited booking replaces the old one; unknown room -> Not assigned; old stay marked cancelled for the updater',
    brow.filter((b) => /Neha Iyer/.test(b.guest)).length === 1 && brow.find((b) => /Neha Iyer/.test(b.guest)).room === 'Not assigned' && mrow.some((m) => m.check_in === '2026-11-03' && m.status === 'Cancelled') && mrow.some((m) => m.check_in === '2026-11-04' && m.status === 'Confirmed'));
  x = await A('state', {}); check('admin state lists the booking as a Zuna entry', x.j.clients.find((c) => c.id === acme).bookings.some((b) => b.manual && b.check_in === '2026-11-04'));
  x = await A('booking/delete', {client_id: acme, guest: 'Neha Iyer', check_in: '2026-11-04'});
  brow = JSON.parse(DB.raw.prepare("SELECT json FROM datasets WHERE id = 'bookings'").get().json); mrow = JSON.parse(DB.raw.prepare("SELECT json FROM datasets WHERE id = 'manual'").get().json);
  check('cancel removes the booking and records the cancellation', x.status === 200 && !brow.some((b) => /Neha Iyer/.test(b.guest)) && mrow.filter((m) => /Neha Iyer/.test(m.guest)).every((m) => m.status === 'Cancelled'));
  // client admins
  x = await A('user', {client_id: acme, name: 'Meera Nair', email: 'meera@acme.example', role: 'client_admin'});
  const meera = (await call('/api/login', {method: 'POST', body: {email: 'meera@acme.example', password: x.j.password}})).headers.get('set-cookie').split(';')[0];
  const M = async (p, body) => { const y = await call('/api/manage/' + p, {method: 'POST', body, cookie: meera}); return {status: y.status, j: await y.json()}; };
  x = await M('state', {}); check('client admin sees own users only', x.status === 200 && x.j.clients.length === 1 && x.j.clients[0].users.some((u) => u.email === 'asha@acme.example') && !JSON.stringify(x.j).includes('Other House'));
  x = await M('user', {name: 'Kiran Das', email: 'kiran@acme.example'}); check('client admin creates a viewer', x.status === 200 && x.j.created && /^Kiran@/.test(x.j.password));
  check('client admin cannot disable own account', (await M('user', {email: 'meera@acme.example', name: 'Meera', active: false})).status === 400);
  await A('user', {client_id: other, name: 'Zed', email: 'zed@other.example'});
  check("client admin cannot touch another client's user", (await M('user', {email: 'zed@other.example', name: 'Zed', active: false})).status === 400 && (await M('user/reset', {email: 'zed@other.example'})).status === 400);
  check('client admin cannot reset a Zuna admin', (await M('user/reset', {email: 'boss@zuna.example'})).status === 400);
  check('viewer cannot use the manage API', (await call('/api/manage/state', {method: 'POST', body: {}, cookie: asha})).status === 403);
  check('client admin cannot use the Zuna admin API', (await call('/api/admin/state', {method: 'POST', body: {}, cookie: meera})).status === 403);
  check('/manage page served to client admin', (await (await call('/manage', {cookie: meera})).text()).includes('"mode":"client"'));
  // documents
  const pdf = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');
  const soon = new Date(Date.now() + 5.5 * 3600e3 + 30 * 864e5).toISOString().slice(0, 10);
  x = await A('doc', {gh_id: gh, doc_type: 'Trade licence', title: 'Trade licence', number: 'TL-1', issued: '2026-01-01', expires: soon, remind_days: 30, data_url: pdf, file_name: 'tl.pdf'});
  check('admin uploads a PDF document', x.status === 200 && !!x.j.id);
  x = await A('doc', {gh_id: gh, doc_type: 'Lease agreement', title: 'Lease (internal)', expires: '2027-03-31', visible: false, data_url: pdf});
  check('admin uploads a hidden document', x.status === 200);
  check('non-PDF data refused', (await A('doc', {gh_id: gh, title: 'x', data_url: 'data:application/pdf;base64,' + Buffer.from('hello world').toString('base64')})).status === 400);
  const cpage = await (await call('/', {cookie: meera})).text(); const cdata = JSON.parse(cpage.match(/window\.__LTMGH_DATA = (.*?);\nconst REPORT_DATE/s)[1]);
  const docs = cdata.properties[0].documents;
  check('client sees visible documents with expiry state', docs.length === 1 && docs[0].title === 'Trade licence' && docs[0].state === 'expiring' && docs[0].days_left === 30);
  const pr = await call(docs[0].url, {cookie: meera}); check('client opens the PDF', pr.status === 200 && pr.headers.get('content-type') === 'application/pdf' && /inline; filename="tl.pdf"/.test(pr.headers.get('content-disposition')));
  const hid = (await A('state', {})).j.clients.find((c) => c.id === acme).guesthouses[0].documents.find((d) => !d.visible);
  check("client can't open a hidden document's file", (await call(hid.url, {cookie: meera})).status === 404);
  env.RESEND_API_KEY = 'test';
  const before = mails.length; await worker.scheduled({}, env, {waitUntil: (p) => p}); await new Promise((r) => setTimeout(r, 50));
  const rm = mails.slice(before);
  check('expiry reminder e-mailed to Zuna admin and client admin', rm.length === 2 && rm.some((m) => m.to[0] === 'meera@acme.example') && rm.every((m) => /Trade licence/.test(m.text) && /Expires in 30 days/.test(m.text)));
  await worker.scheduled({}, env, {waitUntil: (p) => p}); await new Promise((r) => setTimeout(r, 50));
  check('reminder not repeated the same day', mails.length === before + 2);
  x = await A('user', {email: 'asha@acme.example', name: 'Asha Rao', active: false});
  check('disabled user is signed out', (await (await call('/', {cookie: asha})).text()).includes('id="f"'));
}

// branded error pages
env = {DB};
r = await call('/no-such-page');
let eh = await r.text(); check('unknown page -> branded 404', r.status === 404 && eh.includes('Page not found') && eh.includes('Go to the portal') && !/__[A-Z]+__/.test(eh));
r = await call('/', {cookie: 'ltmgh_s=' + 'a'.repeat(64)});
eh = await r.text(); check('expired session -> sign-in page says so and clears the cookie', eh.includes('Your session has expired') && /Max-Age=0/.test(r.headers.get('set-cookie') || ''));
check('fresh visitor sees no expiry notice', !(await (await call('/')).text()).includes('Your session has expired'));
r = await worker.fetch(new Request(ORIGIN + '/', {headers: {cookie: 'ltmgh_s=' + 'b'.repeat(64)}}), {DB: {prepare() { throw new Error('db down'); }}});
eh = await r.text(); check('server error -> branded 500 page', r.status === 500 && eh.includes('Something went wrong') && !eh.includes('db down'));

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
