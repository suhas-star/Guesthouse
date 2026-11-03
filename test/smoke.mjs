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
  { const u = x.j.undo; x = await A('booking/restore', Object.assign({client_id: acme}, u));
    brow = JSON.parse(DB.raw.prepare("SELECT json FROM datasets WHERE id = 'bookings'").get().json); mrow = JSON.parse(DB.raw.prepare("SELECT json FROM datasets WHERE id = 'manual'").get().json);
    check('undo puts the cancelled stay back exactly, with its manual entry', x.status === 200 && brow.some((b) => /Neha Iyer/.test(b.guest) && b.check_in === '2026-11-04') && mrow.some((m) => /Neha Iyer/.test(m.guest) && m.check_in === '2026-11-04' && m.status === 'Confirmed'));
    x = await A('booking/restore', {client_id: acme, row: Object.assign({}, u.row, {property: 'Other House'})}); check("undo can't move a stay to another client's guest house", x.status === 400);
    await A('booking/delete', {client_id: acme, guest: 'Neha Iyer', check_in: '2026-11-04'}); }
  x = await A('client', {id: acme, name: 'Acme', legal_name: 'Acme Industries Limited', grades: ['E1', 'E2']});
  { const pg = await (await call('/', {cookie: asha})).text(); const dd = JSON.parse(pg.match(/window\.__LTMGH_DATA = (.*?);\nconst REPORT_DATE/s)[1]);
    check('client company name (for the GH Report) reaches the dashboard', dd.client.legal_name === 'Acme Industries Limited');
    DB.raw.prepare("INSERT INTO datasets (id, json, updated_at) VALUES (?, ?, '2026-11-01')").run('policy:' + acme, JSON.stringify({hotel_caps: [{group: 'L1-L8', zone: 'Zone 1', hotel_per_night: 6500}, {group: 'E1 & above', zone: 'Mumbai', hotel_per_night: 10000}], city_zones: [{city: 'Pune', zone: 'Zone 1'}, {city: 'All other cities in India', zone: 'Zone 2'}]}));
    const pg2 = await (await call('/', {cookie: asha})).text(); const d2 = JSON.parse(pg2.match(/window\.__LTMGH_DATA = (.*?);\nconst REPORT_DATE/s)[1]);
    check('policy caps are not sent to users without hotel access', !d2.policy);
    const pg3 = await (await call('/', {cookie: admin})).text(); const d3 = JSON.parse(pg3.match(/window\.__LTMGH_DATA = (.*?);\nconst REPORT_DATE/s)[1]);
    check('policy caps (for the consolidated report) reach users with hotel access', d3.policy && d3.policy.caps.length === 2 && d3.policy.zones.length === 1 && d3.policy.zones[0][0] === 'Pune');
    // guest house booking codes
    await A('booking', {client_id: acme, row: {property: 'Acme House', title: 'Mr.', name: 'Code Test', check_in: '2026-12-01', check_out: '2026-12-03', room: 'Z1', status: 'Confirmed'}});
    await A('booking', {client_id: acme, row: {property: 'Acme House', title: 'Ms.', name: 'Code Test Two', check_in: '2026-12-05', check_out: '2026-12-06', room: 'Z1', status: 'Confirmed'}});
    const codesOf = async () => { const pg = await (await call('/', {cookie: admin})).text(); const d = JSON.parse(pg.match(/window\.__LTMGH_DATA = (.*?);\nconst REPORT_DATE/s)[1]); return Object.fromEntries(d.bookings.map((b) => [b.guest, b.booking_code])); };
    const c1 = await codesOf(), c2 = await codesOf(), vals = Object.values(c1);
    check('every guest house stay gets a ZUNA booking code', vals.length >= 2 && vals.every((v) => /^ZUNA\d{5}$/.test(v)));
    check('booking codes are unique and stay the same on every visit', new Set(vals).size === vals.length && JSON.stringify(c1) === JSON.stringify(c2));
    await A('booking/delete', {client_id: acme, guest: 'Code Test', check_in: '2026-12-01'}); await A('booking/delete', {client_id: acme, guest: 'Code Test Two', check_in: '2026-12-05'}); }
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
  // hotel transaction reports (made-up rows)
  { const H = ['Booking Code', 'Entity Name', 'Property Name', 'Property Category', 'City', 'State', 'Emp Code', 'Guest Name ', 'Booked Date', 'Check-In Date ', 'Check-Out Date ', 'Grade', 'Eligibility Criteria', 'Tariff Per Day', 'Stay Days ', 'Total Tariff ', 'Status', 'Net Amount Charged', 'GST Charges', 'Invoice No'];
    const row = (code, guest, booked, ci, co, tariff, status = 'Billed') => [code, 'Acme Industries', 'Lakeside Inn', 'Hotel', 'Pune', 'Maharashtra', 'E' + code, guest, booked, ci, co, 'M5', 6500, tariff, 2, tariff * 2, status, tariff * 2.36, tariff * 0.36, 'INV-' + code];
    const rows = [row('TX1', 'Ravi Menon', '2026-10-19', '2026-10-20', '2026-10-22', 5000), row('TX2', 'Sara Khan', '21/10/2026', '2026-10-24', '2026-10-26', 7000), row('TX2', 'Sara Khan', '21/10/2026', '2026-10-24', '2026-10-26', 7000), row('TX3', 'Dev Rao', 46326, '2026-11-01', '2026-11-03', 4000)];
    x = await A('tx/preview', {client_id: acme, header: ['Name', 'Amount'], rows: [['a', 1]]}); check('transaction upload: wrong file is refused with the missing columns named', x.status === 400 && /Invoice No/.test(x.j.error));
    x = await A('tx/preview', {client_id: acme, header: H, rows}); const pv = x.j.preview || {};
    check('transaction preview: 3 new, identical duplicate folded, 1 over policy, dates read in any format', x.status === 200 && pv.added === 3 && pv.dup_same === 1 && pv.over_policy === 1 && pv.booked_from === '2026-10-19' && pv.booked_to === '2026-10-31');
    check('preview writes nothing', DB.raw.prepare('SELECT COUNT(*) n FROM transactions').get().n === 0);
    x = await A('tx/import', {client_id: acme, header: H, rows, filename: 'week1.xlsx', file_b64: 'UEsDBBQ='}); const up1 = x.j.upload_id;
    check('transaction import stores 3 bookings', x.status === 200 && DB.raw.prepare('SELECT COUNT(*) n FROM transactions WHERE client_id = ?').get(acme).n === 3);
    const T = async (cookie, body = {}) => { const y = await call('/api/tx', {method: 'POST', body, cookie}); return {status: y.status, j: await y.json()}; };
    check('viewer without access cannot see hotel bookings', (await T(asha)).status === 403);
    x = await T(meera, {checkout_from: '2026-10-21', checkout_to: '2026-10-26'}); check('client admin sees hotel bookings filtered by check-out date', x.status === 200 && x.j.rows.length === 2 && x.j.rows.every((r) => r['Check-Out Date'] <= '2026-10-26'));
    x = await T(meera, {booked_from: '2026-10-21', booked_to: '2026-10-21'}); check('filter by booked date (dd/mm/yyyy in the file read as Indian format)', x.j.rows.length === 1 && x.j.rows[0]['Booking Code'] === 'TX2');
    check('access switch for an unknown email creates nobody', (await M('user/access', {email: 'ghost@acme.example', tx: true})).status === 404 && !DB.raw.prepare("SELECT 1 FROM users WHERE email = 'ghost@acme.example'").get());
    check('client admin gives a viewer access', (await M('user/access', {email: 'asha@acme.example', tx: true})).status === 200);
    x = await T(asha, {client_id: other}); check("viewer with access sees own client's bookings only", x.status === 200 && x.j.rows.length === 3);
    check("client admin cannot switch access for another client's user", (await M('user/access', {email: 'zed@other.example', tx: true})).status === 400);
    { const shuffled = [rows[3], rows[0], rows[1]];   // the same report again, rows in another order
      x = await A('tx/preview', {client_id: acme, header: H, rows: shuffled}); const pv2 = x.j.preview;
      check('same report again: recognised as already uploaded, with the earlier file named', pv2.added === 0 && pv2.changed === 0 && pv2.already === 3 && pv2.exact && pv2.exact.filename === 'week1.xlsx' && pv2.from[0].count === 3 && pv2.from[0].filename === 'week1.xlsx');
      x = await A('tx/import', {client_id: acme, header: H, rows: shuffled, filename: 'again.xlsx'});
      check('importing a report with nothing new is refused and leaves no upload behind', x.status === 409 && DB.raw.prepare('SELECT COUNT(*) n FROM tx_uploads WHERE client_id = ?').get(acme).n === 1);
      x = await A('tx/preview', {client_id: acme, header: H, rows: [rows[0], ['TX9', 'Acme Industries', 'Lakeside Inn', 'Hotel', 'Pune', 'Maharashtra', 'E9', 'New Guest', '2026-10-30', '2026-10-31', '2026-11-02', 'M5', 6500, 4000, 2, 8000, 'Billed', 9440, 1440, 'INV-TX9']]});
      check('overlapping report: says how many are already in and only the new one is imported', x.j.preview.added === 1 && x.j.preview.already === 1 && !x.j.preview.exact);
      // matched by invoice number; same guest + same stay dates under another invoice is flagged
      const twin = rows[0].slice(); twin[0] = 'TX1-B'; twin[19] = 'INV-OTHER';   // same guest and dates as TX1, new booking code and invoice
      x = await A('tx/preview', {client_id: acme, header: H, rows: [twin]});
      check('same guest and stay dates under a different invoice is flagged as a possible duplicate', x.j.preview.added === 1 && x.j.preview.same_stay_count === 1 && x.j.preview.same_stay[0].where === 'portal' && x.j.preview.same_stay[0].invoices.includes('INV-TX1'));
      const recode = rows[0].slice(); recode[0] = 'NEW-BOOKING-CODE';   // same invoice, different booking code -> same booking (invoice is the key)
      x = await A('tx/preview', {client_id: acme, header: H, rows: [recode]});
      check('a row is matched by its invoice number, not its booking code', x.j.preview.added === 0 && x.j.preview.changed === 1);
      const noInv = rows[3].slice(); noInv[19] = ''; noInv[0] = 'ONLY-BC';
      x = await A('tx/preview', {client_id: acme, header: H, rows: [twin, twin.map((v, i) => i === 19 ? 'INV-THIRD' : v), noInv]});
      check('within the file: same guest and dates twice is flagged; a row without invoice falls back to booking code and is noted', x.j.preview.same_stay.some((s) => s.where === 'file') && x.j.preview.problems.some((p) => /No Invoice No/.test(p.issue)));
      x = await A('tx/uploads', {client_id: acme}); check('upload history keeps the original file of each upload', x.j.uploads[0].has_file === 1 || x.j.uploads[0].has_file === true);
      x = await A('tx/file', {client_id: acme, id: x.j.uploads[0].id}); check('the original file can be downloaded again', x.status === 200 && x.j.name === 'week1.xlsx' && x.j.data === 'UEsDBBQ=');
      // skip chosen duplicates, list stored bookings with duplicate groups, remove and restore
      const before = DB.raw.prepare('SELECT COUNT(*) n FROM transactions WHERE client_id = ?').get(acme).n;
      x = await A('tx/import', {client_id: acme, header: H, rows: [twin, rows[0]], filename: 'twin.xlsx', skip: ['INV-OTHER']});
      check('a duplicate the team chose to skip is not imported', x.status === 409 && DB.raw.prepare('SELECT COUNT(*) n FROM transactions WHERE client_id = ?').get(acme).n === before);
      x = await A('tx/import', {client_id: acme, header: H, rows: [twin], filename: 'twin.xlsx'}); const upTwin = x.j.upload_id;
      x = await A('tx/stored', {client_id: acme}); const tw = x.j.rows.filter((r) => r.dup);
      check('stored bookings list groups same guest + stay dates under different invoices', x.j.dup_groups === 1 && tw.length === 2 && tw.every((r) => r.dup === tw[0].dup) && tw.some((r) => r.invoice === 'INV-OTHER'));
      const T2 = async () => (await (await call('/api/tx', {method: 'POST', body: {}, cookie: meera})).json()).rows;
      check('a possible duplicate is held: stored for the admin but hidden from the client', x.j.held === 1 && tw.find((r) => r.invoice === 'INV-OTHER').held === 1 && tw.find((r) => r.invoice === 'INV-TX1').held === 0 && !(await T2()).some((r) => r['Invoice No'] === 'INV-OTHER') && (await T2()).some((r) => r['Invoice No'] === 'INV-TX1'));
      x = await A('tx/keep', {client_id: acme, code: 'INV-OTHER'}); check('Keep makes the booking visible to the client', x.status === 200 && (await T2()).some((r) => r['Invoice No'] === 'INV-OTHER'));
      x = await A('tx/remove', {client_id: acme, code: 'INV-OTHER'});
      check('a removed booking disappears for the client', x.status === 200 && !(await T2()).some((r) => r['Invoice No'] === 'INV-OTHER'));
      x = await A('tx/stored', {client_id: acme}); const rid = x.j.removed[0] && x.j.removed[0].id;
      check('removed bookings are listed (kept for restore)', x.j.removed.length === 1 && x.j.removed[0].invoice === 'INV-OTHER' && x.j.dup_groups === 0);
      x = await A('tx/restore', {client_id: acme, id: rid}); check('a removed booking can be restored', x.status === 200 && (await T2()).some((r) => r['Invoice No'] === 'INV-OTHER'));
      check('restoring twice is refused', (await A('tx/restore', {client_id: acme, id: rid})).status === 404);
      await A('tx/undo', {client_id: acme, id: upTwin}); }
    rows[1][16] = 'Cancelled'; rows[2][16] = 'Cancelled';
    x = await A('tx/import', {client_id: acme, header: H, rows, filename: 'week1-again.xlsx'}); const up2 = x.j.upload_id;
    check('re-upload updates by Booking Code (no duplicates): 1 changed, 2 unchanged', x.j.result.changed === 1 && x.j.result.unchanged === 2 && x.j.result.added === 0 && DB.raw.prepare('SELECT COUNT(*) n FROM transactions WHERE client_id = ?').get(acme).n === 3);
    check('only the latest upload can be undone', (await A('tx/undo', {client_id: acme, id: up1})).status === 400);
    x = await A('tx/undo', {client_id: acme, id: up2}); const st = JSON.parse(DB.raw.prepare("SELECT row FROM transactions WHERE code = 'INV-TX2'").get().row).Status;
    check('undo restores the earlier version', x.status === 200 && st === 'Billed');
    x = await A('tx/undo', {client_id: acme, id: up1}); check('undoing the first upload removes its bookings', x.status === 200 && DB.raw.prepare('SELECT COUNT(*) n FROM transactions WHERE client_id = ?').get(acme).n === 0);
    x = await A('tx/uploads', {client_id: acme}); check('upload history lists every upload as undone', x.j.uploads.length === 3 && x.j.uploads.every((u) => u.undone));
    await M('user/access', {email: 'asha@acme.example', tx: false}); check('access can be switched off again', (await T(asha)).status === 403); }
  check('client admin cannot use the Zuna admin API', (await call('/api/admin/state', {method: 'POST', body: {}, cookie: meera})).status === 403);
  { const rr = await call('/manage', {cookie: meera}); check('/manage opens Users & access inside the dashboard', rr.status === 302 && rr.headers.get('location').endsWith('/#users')); }
  { const pg = await (await call('/', {cookie: meera})).text(); const dd = JSON.parse(pg.match(/window\.__LTMGH_DATA = (.*?);\nconst REPORT_DATE/s)[1]);
    check('client admin dashboard carries its users (no extra load)', Array.isArray(dd.users) && dd.users.some((u) => u.email === 'kiran@acme.example'));
    const vp = await (await call('/', {cookie: asha})).text(); check('viewer dashboard carries no user list', !JSON.parse(vp.match(/window\.__LTMGH_DATA = (.*?);\nconst REPORT_DATE/s)[1]).users); }
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
