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
{ const bad = []; for (const m of dash.matchAll(/<script>([\s\S]*?)<\/script>/g)) { try { new Function(m[1]); } catch (e) { bad.push(e.message); } }
  check('dashboard scripts compile', !bad.length, bad.join('; ')); }
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
  { // Book a room + Trips
    const D = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
    const B = async (who, p, body, raw) => { if (!raw && body && body.name && /^book(\/update)?$/.test(p)) body = Object.assign({email: 'guest@acme.example', phone: '+91 98450 12345'}, body);
      const y = await call('/api/' + p, {method: 'POST', body, cookie: who}); return {status: y.status, j: await y.json()}; };
    check('booking needs the Book rooms switch', (await B(asha, 'book/avail', {property: 'Acme House', check_in: D(200), check_out: D(203)})).status === 403);
    check('client admin switches Book rooms on', (await M('user/access', {email: 'asha@acme.example', book: true})).status === 200);
    await A('client', {id: acme, name: 'Acme', legal_name: 'Acme Industries Limited', grades: ['E1', 'E2'], mail_cc: 'desk@zuna.example, bad-address', mail_bcc: 'audit@zuna.example'});
    { const pg = await (await call('/', {cookie: asha})).text(); const dd = JSON.parse(pg.match(/window\.__LTMGH_DATA = (.*?);\nconst REPORT_DATE/s)[1]);
      check('client dashboard does not carry the email copies', dd.client.mail_cc === undefined && dd.client.mail_bcc === undefined && pg.includes('"book":true')); }
    x = await B(asha, 'book/avail', {property: 'Acme House', check_in: D(200), check_out: D(203)});
    check('availability lists every room as free', x.status === 200 && x.j.rooms.length === 3 && x.j.rooms.every((r) => r.state === 'free') && x.j.nights === 3);
    check('guest email is required', (await B(asha, 'book', {property: 'Acme House', check_in: D(240), check_out: D(241), title: 'Mr.', name: 'No Mail', grade: 'E1', phone: '+91 98450 12345'}, true)).status === 400);
    check('guest mobile is required', (await B(asha, 'book', {property: 'Acme House', check_in: D(240), check_out: D(241), title: 'Mr.', name: 'No Phone', grade: 'E1', email: 'np@acme.example'}, true)).status === 400);
    check('past check-in refused', (await B(asha, 'book', {property: 'Acme House', check_in: D(-2), check_out: D(1), title: 'Mr.', name: 'Old Guest', grade: 'E1'})).status === 400);
    const m0 = mails.length;
    x = await B(asha, 'book', {property: 'Acme House', check_in: D(200), check_out: D(203), room: 'A1', title: 'Mr.', name: 'Karan Mehta', grade: 'E1', email: 'karan@acme.example', cc: 'someone@else.example', bcc: 'spy@else.example', note: 'Late arrival'});
    const t1 = x.j.trip;
    check('booker never sees or sets the email copies', t1.cc === '' && t1.bcc === '');
    check('booking carries the guest house helpdesk for the voucher', t1.helpdesk.length === 1 && t1.helpdesk[0].name === 'Ravi' && t1.helpdesk[0].phone === '+91 90000 00000');
    check('booking is confirmed instantly with a ZUNA code', x.status === 200 && /^ZUNA\d+$/.test(t1.code) && t1.status === 'Confirmed' && t1.room === 'A1');
    const em = mails[m0];
    check('confirmation e-mail goes to the guest with CC and BCC', mails.length === m0 + 1 && em.to[0] === 'karan@acme.example' && em.cc[0] === 'desk@zuna.example' && em.bcc[0] === 'audit@zuna.example' && /Booking confirmed/.test(em.subject) && em.text.includes(t1.code) && em.text.includes('Late arrival') && t1.mail_status === 'sent');
    x = await B(asha, 'guests', {q: 'kar'}); check('booked guest is saved and found by the first letters', x.status === 200 && x.j.guests.length === 1 && x.j.guests[0].name === 'Karan Mehta' && x.j.guests[0].email === 'karan@acme.example' && x.j.guests[0].grade === 'E1' && x.j.guests[0].title === 'Mr.');
    x = await B(asha, 'guests', {q: ''}); check('recent guests are offered before typing', x.j.guests.some((g) => g.name === 'Karan Mehta'));
    x = await B(admin, 'guests', {client_id: other, q: 'kar'}); check("another client's guest list is separate", x.status === 200 && !x.j.guests.some((g) => g.name === 'Karan Mehta'));
    x = await B(asha, 'bookings', {}); check('the stay shows in the stay list with its code', x.j.bookings.some((b) => b.guest === 'Mr. Karan Mehta' && b.room === 'A1' && b.booking_code === t1.code));
    check('room taken on those nights is refused', (await B(asha, 'book', {property: 'Acme House', check_in: D(201), check_out: D(202), room: 'A1', title: 'Ms.', name: 'Priya S', grade: 'E1'})).status === 409);
    check('same guest cannot be booked twice for the same nights', (await B(asha, 'book', {property: 'Acme House', check_in: D(201), check_out: D(204), room: 'A2', title: 'Mr.', name: 'Karan Mehta', grade: 'E1'})).status === 409);
    check('room not open to the grade is refused', (await B(asha, 'book', {property: 'Acme House', check_in: D(200), check_out: D(201), room: 'A2', title: 'Ms.', name: 'Priya S', grade: 'M1'})).status === 400);
    x = await B(asha, 'book', {property: 'Acme House', check_in: D(200), check_out: D(202), room: 'S1', title: 'Ms.', name: 'Priya S', grade: 'E2', occupancy: 'Double'});
    check('booking in a double room', x.status === 200);
    check('a man cannot share a room with a woman', (await B(asha, 'book', {property: 'Acme House', check_in: D(200), check_out: D(201), room: 'S1', title: 'Mr.', name: 'Ravi K', grade: 'E1'})).status === 409);
    x = await B(asha, 'book', {property: 'Acme House', check_in: D(200), check_out: D(201), room: 'S1', title: 'Ms.', name: 'Anu P', grade: 'E1', send_mail: false});
    check('a woman can share it and no e-mail when switched off', x.status === 200 && x.j.trip.occupancy === 'Double' && x.j.trip.mail_status === 'not sent');
    x = await B(asha, 'book/avail', {property: 'Acme House', check_in: D(200), check_out: D(201)});
    check('availability shows taken rooms as full', x.j.rooms.find((r) => r.room === 'A1').state === 'full' && x.j.rooms.find((r) => r.room === 'S1').state === 'full');
    x = await B(asha, 'book/avail', {property: 'Acme House', check_in: D(200), check_out: D(201), exclude_id: t1.id});
    check('modify sees its own room as free', x.j.rooms.find((r) => r.room === 'A1').state === 'free');
    x = await B(admin, 'book/update', {client_id: acme, id: t1.id, property: 'Acme House', check_in: D(205), check_out: D(207), room: 'A2', title: 'Mr.', name: 'Karan Mehta', grade: 'E1', email: 'karan@acme.example'});
    check('Zuna admin changes the booking for the client and the code stays', x.status === 200 && x.j.trip.code === t1.code && x.j.trip.room === 'A2' && x.j.trip.history.length === 2 && /Booking changed/.test(mails[mails.length - 1].subject));
    x = await B(asha, 'bookings', {}); check('old stay is gone, new one keeps the code', !x.j.bookings.some((b) => b.guest === 'Mr. Karan Mehta' && b.check_in === D(200)) && x.j.bookings.some((b) => b.check_in === D(205) && b.booking_code === t1.code));
    x = await B(asha, 'book/cancel', {id: t1.id, reason: 'Trip postponed'});
    check('booker cancels with a reason and the guest is told', x.status === 200 && x.j.trip.status === 'Cancelled' && x.j.trip.cancel_reason === 'Trip postponed' && /Booking cancelled/.test(mails[mails.length - 1].subject) && mails[mails.length - 1].text.includes('Trip postponed'));
    x = await B(asha, 'bookings', {}); check('cancelled stay leaves the stay list', !x.j.bookings.some((b) => b.guest === 'Mr. Karan Mehta'));
    check('a cancelled booking cannot be changed', (await B(asha, 'book/update', {id: t1.id, property: 'Acme House', check_in: D(205), check_out: D(206), title: 'Mr.', name: 'Karan Mehta', grade: 'E1'})).status === 409);
    const m1 = mails.length; x = await B(asha, 'book/resend', {id: t1.id}); check('e-mail can be sent again', x.status === 200 && x.j.mail_status === 'sent' && mails.length === m1 + 1);
    x = await B(asha, 'trips', {}); check('trips list shows all bookings of the client', x.status === 200 && x.j.trips.length === 3 && x.j.trips.some((t) => t.status === 'Cancelled'));
    x = await B(admin, 'trips', {client_id: other}); check("other client's trips stay separate", x.status === 200 && x.j.trips.length === 0);
    check("booker cannot touch another client's trip", (await B(asha, 'book/cancel', {id: 99999})).status === 404);
    x = await B(admin, 'book', {client_id: acme, property: 'Acme House', check_in: D(210), check_out: D(211), title: 'Dr.', gender: 'Female', name: 'Neha Iyer', grade: 'E2', emp_code: 'EMP-77', wbs: 'WBS-123'});
    check('Zuna admin books on behalf and the free room is picked', x.status === 200 && x.j.trip.booked_by === 'boss@zuna.example' && ['A1', 'A2'].includes(x.j.trip.room));
    check('WBS ID and employee code are kept on the trip and the stay', x.j.trip.wbs === 'WBS-123' && (await B(asha, 'bookings', {})).j.bookings.some((b) => b.guest === 'Dr. Neha Iyer' && b.wbs === 'WBS-123' && b.emp_code === 'EMP-77'));
    await A('client', {id: acme, name: 'Acme', legal_name: 'Acme Industries Limited', grades: ['M1', 'M5', 'M6', 'E1', 'E2'], elig_male: 'M6-M8, E1-E8', elig_female: 'M5–M8, E1–E8'});
    check('admin saves eligibility by gender', (await A('state', {})).j.clients.find((c) => c.id === acme).elig_male === 'M6–M8, E1–E8');
    check('a male M5 guest is not eligible', (await B(asha, 'book', {property: 'Acme House', check_in: D(230), check_out: D(231), title: 'Mr.', name: 'Ajay Low', grade: 'M5'})).status === 400);
    check('a female M5 guest is eligible', (await B(asha, 'book', {property: 'Acme House', check_in: D(230), check_out: D(231), title: 'Ms.', name: 'Rina Low', grade: 'M5'})).status === 200);
    { // guest house check-in/out times and team email; room type ids survive an edit
      const st0 = (await A('state', {})).j.clients.find((c) => c.id === acme), g9 = st0.guesthouses.find((g) => g.property === 'Acme House'), ids0 = g9.room_types.map((t) => t.id).sort().join(',');
      await A('gh', {id: g9.id, client_id: acme, name: g9.property, city: g9.city, status: 'Live', address: g9.address, checkin_time: '12:00', checkout_time: '11:00', team_emails: 'frontdesk@acmehouse.example, bad',
        room_types: g9.room_types.map((t) => ({id: t.id, name: t.name, rooms: t.rooms, room_nos: t.room_nos, occupancy: t.occupancy, grades: t.grades})), contacts: g9.contacts, show: {}});
      const g10 = (await A('state', {})).j.clients.find((c) => c.id === acme).guesthouses.find((g) => g.property === 'Acme House');
      check('guest house keeps check-in/out times and the team email', g10.checkin_time === '12:00' && g10.checkout_time === '11:00' && g10.team_emails === 'frontdesk@acmehouse.example');
      check('editing a guest house keeps its room type ids', g10.room_types.map((t) => t.id).sort().join(',') === ids0);
      const m9 = mails.length; x = await B(asha, 'book', {property: 'Acme House', check_in: D(360), check_out: D(361), title: 'Mr.', name: 'Team Copy', grade: 'E1', email: 'team.copy@acme.example'});
      check('booking email copies the guest house team and shows the times', x.status === 200 && mails.length === m9 + 1 && mails[m9].cc.includes('frontdesk@acmehouse.example') && /from 12:00 PM/.test(mails[m9].text) && /by 11:00 AM/.test(mails[m9].text));
      const pg9 = await (await call('/', {cookie: asha})).text(); check('clients see the times but not the team email', pg9.includes('"checkin_time":"12:00"') && !pg9.includes('frontdesk@acmehouse.example'));
    }
    { // rates and blackout dates (Zuna admin only)
      const st = (await A('state', {})).j.clients.find((c) => c.id === acme), g0 = st.guesthouses.find((g) => g.property === 'Acme House');
      const suite = g0.room_types.find((t) => t.name === 'Suite').id, deluxe = g0.room_types.find((t) => t.name === 'Deluxe').id;
      check('client admin cannot set rates', (await call('/api/admin/rate', {method: 'POST', body: {gh_id: g0.id, from: D(300), to: D(330), fare: 5000}, cookie: meera})).status === 403);
      check('rate needs a fare or Nil', (await A('rate', {gh_id: g0.id, from: D(300), to: D(330)})).status === 400);
      check('client admin cannot set the service charge', (await call('/api/admin/svc', {method: 'POST', body: {client_id: acme, svc_fee: 1}, cookie: meera})).status === 403);
      await A('svc', {client_id: acme, svc_fee: 200});
      check('service charge saved per client', (await A('state', {})).j.clients.find((c) => c.id === acme).svc_fee === 200);
      await A('rate', {gh_id: g0.id, from: D(300), to: D(330), fare: 6000});
      await A('rate', {gh_id: g0.id, room_type_id: suite, from: D(300), to: D(330), fare: 8000});
      let q = (await A('quote', {gh_id: g0.id, room_type_id: deluxe, check_in: D(305), check_out: D(307)})).j.cost;
      check('fare below 7,500 taxed at 5%; client service charge once per booking with 18% GST', q.fare === 12000 && q.fare_tax === 600 && q.svc === 200 && q.svc_gst === 36 && q.total === 12836 && q.missing === 0);
      q = (await A('quote', {gh_id: g0.id, room: 'S1', check_in: D(305), check_out: D(307)})).j.cost;
      check('room type rate wins; 7,500 and above taxed at 18%', q.fare === 16000 && q.fare_tax === 2880 && q.svc === 200 && q.svc_gst === 36 && q.total === 19116);
      await A('rate', {gh_id: g0.id, from: D(320), to: D(325), nil: true});
      q = (await A('quote', {gh_id: g0.id, room_type_id: deluxe, check_in: D(321), check_out: D(323)})).j.cost;
      check('Nil fare: only the service charge and its GST', q.fare === 0 && q.fare_tax === 0 && q.svc === 200 && q.svc_gst === 36 && q.total === 236);
      x = await B(asha, 'book/quote', {property: 'Acme House', room: 'A1', check_in: D(321), check_out: D(323)});
      check('booker sees the charges while booking', x.status === 200 && x.j.cost.fare === 0 && x.j.cost.svc === 200 && x.j.cost.total === 236);
      x = await B(asha, 'book/quote', {property: 'Acme House', all: true, check_in: D(305), check_out: D(307)});
      check('charges for every room type in one request', x.j.costs[0].EP.Single.total === 12836 && x.j.costs[suite].EP.Single.total === 19116 && x.j.costs[deluxe].EP.Single.total === 12836);
      // rate plans: CP with single / double prices, saved for several plans at once
      check('an unknown plan is saved as EP', (await A('rate', {gh_id: g0.id, plans: ['XX'], from: D(300), to: D(330), fare: 3000})).status === 200);   // unknown plans fall back to EP
      check('double price cannot be below single', (await A('rate', {gh_id: g0.id, plans: ['CP'], from: D(300), to: D(330), fare: 3000, fare_double: 2000})).status === 400);
      x = await A('rate', {gh_id: g0.id, room_type_id: deluxe, plans: ['CP', 'MAP'], from: D(300), to: D(330), fare: 3000, fare_double: 4000, extra_bed: 800});
      check('one rate saved per chosen plan', x.status === 200 && (await A('state', {})).j.clients.find((c) => c.id === acme).rates.filter((r) => r.plan === 'CP' || r.plan === 'MAP').length === 2);
      q = (await A('quote', {gh_id: g0.id, room_type_id: deluxe, plan: 'CP', occupancy: 'Double', check_in: D(305), check_out: D(307)})).j.cost;
      check('double occupancy uses the double price of the plan', q.plan === 'CP' && q.occupancy === 'Double' && q.fare === 8000 && q.fare_tax === 400 && q.per_night === 4200);
      q = (await A('quote', {gh_id: g0.id, room_type_id: deluxe, plan: 'CP', check_in: D(305), check_out: D(307)})).j.cost;
      check('single occupancy uses the single price of the plan', q.fare === 6000 && q.occupancy === 'Single');
      x = await B(asha, 'book/quote', {property: 'Acme House', all: true, check_in: D(305), check_out: D(307)});
      check('booker sees each priced plan per room type', Object.keys(x.j.costs[deluxe]).join() === 'EP,CP,MAP' && Object.keys(x.j.costs[suite]).join() === 'EP' && x.j.costs[deluxe].MAP.Double.fare === 8000);
      const dRoom = String(g0.room_types.find((t2) => t2.id === deluxe).room_nos || '').split(/[,\s]+/)[0];
      x = await B(asha, 'book', {property: 'Acme House', check_in: D(306), check_out: D(308), room: dRoom, plan: 'AP', title: 'Ms.', name: 'Plan Test', grade: 'E1', send_mail: false});
      check('a plan not priced for the room is refused', x.status === 400 && /AP plan/.test(x.j.error));
      x = await B(asha, 'book', {property: 'Acme House', check_in: D(306), check_out: D(308), room: dRoom, plan: 'MAP', title: 'Ms.', name: 'Plan Test', grade: 'E1', send_mail: false});
      check('the chosen plan is saved on the booking', x.status === 200 && x.j.trip.plan === 'MAP' && /MAP/.test(x.j.trip.plan_label));
      x = await B(asha, 'book', {property: 'Acme House', check_in: D(310), check_out: D(311), room: dRoom, title: 'Ms.', name: 'Plan Test Two', grade: 'E1', send_mail: false});
      check('no plan chosen: the first priced plan is used', x.status === 200 && x.j.trip.plan === 'EP');
      // cancellation charges: guest house rule, room type rule wins, charge on cancel, Zuna can waive
      check('client admin cannot set a cancellation policy', (await call('/api/admin/cancel', {method: 'POST', body: {gh_id: g0.id, free_hours: 24, charge_type: 'nights', charge_value: 1}, cookie: meera})).status === 403);
      check('cancellation hours are checked', (await A('cancel', {gh_id: g0.id, free_hours: 9999, charge_type: 'nights', charge_value: 1})).status === 400);
      check('cancellation charge type is checked', (await A('cancel', {gh_id: g0.id, free_hours: 24, charge_type: 'x'})).status === 400);
      x = await A('cancel', {gh_id: g0.id, free_hours: 24, charge_type: 'nights', charge_value: 1});
      await A('cancel', {gh_id: g0.id, free_hours: 24, charge_type: 'nights', charge_value: 2});   // same scope again: updates, no second rule
      await A('cancel', {gh_id: g0.id, room_type_id: suite, free_hours: 48, charge_type: 'full'});
      let cs = (await A('state', {})).j.clients.find((c) => c.id === acme).cancels;
      check('one rule per guest house / room type', x.status === 200 && cs.length === 2 && cs.find((r) => !r.room_type_id).charge_value === 2);
      x = await B(asha, 'book/quote', {property: 'Acme House', all: true, check_in: D(305), check_out: D(307)});
      check('booker sees the policy per room type', /24 hours before check-in; after that 2 nights are charged/.test(x.j.cancel[deluxe].text) && /2 days before check-in; after that the full stay/.test(x.j.cancel[suite].text));
      x = await B(asha, 'book', {property: 'Acme House', check_in: D(316), check_out: D(318), room: dRoom, title: 'Ms.', name: 'Cancel Free', grade: 'E1', send_mail: false});
      check('booking carries its cancellation deadline', /^Free cancellation until \d+ \w+ \d{4}, 12:00 PM; after that 2 nights are charged\.$/.test(x.j.trip.cancel_policy));
      const tf = x.j.trip; x = await B(asha, 'book/cancel/preview', {id: tf.id});
      check('cancelling well before the deadline is free', x.status === 200 && x.j.late === false && x.j.charge === 0);
      x = await B(asha, 'book/cancel', {id: tf.id}); check('free cancellation is saved as no charge', x.j.trip.cancel_charge === 0 && /Free cancellation/.test(x.j.trip.cancel_basis));
      await A('cancel', {gh_id: g0.id, free_hours: 720, charge_type: 'nights', charge_value: 1});   // 30 days: anything booked within a month is already late
      await A('rate', {gh_id: g0.id, from: D(5), to: D(20), fare: 5000});
      x = await B(asha, 'book', {property: 'Acme House', check_in: D(10), check_out: D(12), room: dRoom, title: 'Ms.', name: 'Cancel Late', grade: 'E1', send_mail: false});
      const tl = x.j.trip; x = await B(asha, 'book/cancel/preview', {id: tl.id});
      check('late cancellation is charged one night with tax', x.j.late === true && x.j.charge === 5250);
      x = await B(asha, 'book/cancel', {id: tl.id, waive: true}); check('a client cannot waive the charge', x.j.trip.cancel_charge === 5250);
      x = await B(admin, 'book', {client_id: acme, property: 'Acme House', check_in: D(13), check_out: D(15), room: dRoom, title: 'Ms.', name: 'Cancel Waive', grade: 'E1', send_mail: false});
      x = await B(admin, 'book/cancel', {client_id: acme, id: x.j.trip.id, waive: true});
      check('Zuna can waive the charge, and it is recorded', x.j.trip.cancel_charge === 0 && /Waived by Zuna \(would have been ₹5,250\)/.test(x.j.trip.cancel_basis));
      x = await A('audit', {kind: 'bookings'}); check('cancellations with a waived charge are in the audit log', x.j.rows.some((r) => r.action === 'Cancelled a booking' && r.detail.waive === true));
      q = (await A('quote', {gh_id: g0.id, room_type_id: deluxe, check_in: D(329), check_out: D(333)})).j.cost;
      check('nights without a rate are counted as missing', q.nights === 4 && q.missing === 2);
      await A('block', {gh_id: g0.id, rooms: ['A1'], from: D(340), to: D(342), reason: 'Painting'});
      x = await B(asha, 'book/avail', {property: 'Acme House', check_in: D(341), check_out: D(343)});
      check('a blocked room shows as blocked', x.j.rooms.find((r) => r.room === 'A1').state === 'blocked' && x.j.rooms.find((r) => r.room === 'A2').state === 'free');
      check('a blocked room cannot be booked', (await B(asha, 'book', {property: 'Acme House', check_in: D(341), check_out: D(342), room: 'A1', title: 'Mr.', name: 'Block Test', grade: 'E1'})).status === 409);
      await A('block', {gh_id: g0.id, rooms: [], from: D(350), to: D(352), reason: 'Closed'});
      check('a whole-house block leaves no room to book', (await B(asha, 'book', {property: 'Acme House', check_in: D(350), check_out: D(351), title: 'Mr.', name: 'Block Test', grade: 'E1'})).status === 409);
      const st2 = (await A('state', {})).j.clients.find((c) => c.id === acme);
      check('admin state lists rates and blocks', st2.rates.length === 7 && st2.blocks.length === 2);
      await A('block', {gh_id: g0.id, id: st2.blocks[0].id, delete: true}); check('a block can be removed', (await A('state', {})).j.clients.find((c) => c.id === acme).blocks.length === 1);
      // bulk tools
      const stB = (await A('state', {})).j.clients.find((c) => c.id === acme), gB = stB.guesthouses.find((g) => g.property === 'Acme House'), dlx = gB.room_types.find((t2) => t2.name === 'Deluxe');
      check('client admin cannot use bulk update', (await call('/api/admin/bulk', {method: 'POST', body: {client_id: acme, kind: 'rate', items: [{gh_id: gB.id}], plans: ['CP'], from: D(400), to: D(410), fare: 1000}, cookie: meera})).status === 403);
      let xb = await A('bulk', {client_id: acme, kind: 'rate', items: [{gh_id: gB.id}, {gh_id: gB.id, room_type_id: dlx.id}, {gh_id: 99999}], plans: ['CP', 'AP'], from: D(400), to: D(410), fare: 2000, fare_double: 2500});
      let rB = (await A('state', {})).j.clients.find((c) => c.id === acme).rates.filter((r) => r.from === D(400));
      check('bulk rate: one per guest house / room type and plan, other clients refused', xb.status === 200 && xb.j.done === 2 && xb.j.failed.length === 1 && rB.length === 4 && rB.every((r) => r.fare === 2000 && r.fare_double === 2500));
      xb = await A('bulk', {client_id: acme, kind: 'rate', items: [{gh_id: gB.id}], plans: ['CP'], from: D(400), to: D(410)});
      check('bulk rate keeps the single-rate checks', xb.status === 400 && /single occupancy price/.test(xb.j.failed[0].error));
      xb = await A('bulk', {client_id: acme, kind: 'rate', op: 'extend', to: D(420), items: rB.map((r) => r.id)});
      check('selected rates can be extended together', xb.j.done === 4 && (await A('state', {})).j.clients.find((c) => c.id === acme).rates.filter((r) => r.from === D(400)).every((r) => r.to === D(420)));
      xb = await A('bulk', {client_id: acme, kind: 'block', items: [{gh_id: gB.id, room_type_id: dlx.id}], from: D(430), to: D(431), reason: 'Painting'});
      const bB = (await A('state', {})).j.clients.find((c) => c.id === acme).blocks.find((b2) => b2.from === D(430));
      check('bulk blackout for a room type blocks each of its rooms', xb.j.done === 1 && bB && bB.rooms.length > 0 && bB.rooms.every((r) => (gB.rooms_list || []).includes(r)) && bB.rooms.length < (gB.rooms_list || []).length);
      xb = await A('bulk', {client_id: acme, kind: 'cancel', items: [{gh_id: gB.id, room_type_id: dlx.id}], free_hours: 12, charge_type: 'percent', charge_value: 50});
      check('bulk cancellation policy saved', xb.j.done === 1 && (await A('state', {})).j.clients.find((c) => c.id === acme).cancels.some((r) => r.room_type_id === dlx.id && r.charge_type === 'percent' && r.charge_value === 50));
      xb = await A('bulk', {client_id: acme, kind: 'rate', op: 'delete', items: rB.map((r) => r.id)});
      check('selected rates can be deleted together', xb.j.done === 4 && !(await A('state', {})).j.clients.find((c) => c.id === acme).rates.some((r) => r.from === D(400)));
      check('bulk updates are in the audit log', (await A('audit', {kind: 'changes'})).j.rows.some((r) => r.action === 'Bulk update' && r.detail.op === 'delete'));
    }
    { // live hotel sync through the relay (relay and booking system simulated in-process)
      x = await A('client', {name: 'Sync Co'}); const sco = x.j.id;
      const now = new Date(), y0 = now.getUTCFullYear(), m0 = now.getUTCMonth(), fy = String((m0 + 1 >= 4 ? y0 : y0 - 1) % 100).padStart(2, '0');
      const day = (d) => new Date(Date.UTC(y0, m0, d)).toISOString().slice(0, 10);
      const RKEY = 'k'.repeat(48), b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const TOKEN = b64u({alg: 'HS256'}) + '.' + b64u({clientId: 7, corporateId: 9, exp: Math.floor(Date.now() / 1000) + 30 * 86400}) + '.sig';
      const bk = (id, status, extra = {}) => ({bookingId: id, billingEntity: 'Sync Co Ltd', hotelConfirmationNumber: 'HC-' + id, supplierConfirmationNumber: 'SUP-' + id, invoiceNumber: id, bookingCreator: 'Desk', travellerName: 'Guest ' + id, status,
        bookingDate: day(2) + 'T09:30:00Z', checkIn: day(20) + 'T00:00:00Z', checkOut: day(22) + 'T00:00:00Z', totalNumberOfNights: 2, propertyName: 'Hotel ' + id, category: 'Business', city: 'Pune', ratePerNight: 6500, totalAmount: 13000, totalAmountINR: 13000, currency: 'INR',
        totalCancellationCharges: null, employeeId: 'E' + id, wbs: 'WBS-1', travelRequestId: 'TR-' + id, ltiBaseLocation: 'Mumbai', grade: 'G5', ...extra});
      let MOCK = [bk(900001, 'Confirmed'), bk(900002, 'Cancelled', {totalCancellationCharges: 0}), bk(900003, 'Cancelled', {totalCancellationCharges: 1200}), bk(900004, 'Cancelled', {totalCancellationCharges: 0}), bk(900005, 'Planned')];
      let partnerDown = false, signedCalls = 0; const seen = [], SECRET = 'test-signing-secret-1234567890';
      const ok = (o, status = 200) => new Response(JSON.stringify({status, headers: {}, body_b64: Buffer.from(JSON.stringify(o)).toString('base64')}), {status: 200, headers: {'content-type': 'application/json'}});
      const prevFetch = globalThis.fetch;
      globalThis.fetch = async (u, o = {}) => { const s = String(u); if (!s.startsWith('https://relay.test/')) return prevFetch(u, o);
        const p = s.slice('https://relay.test'.length), key = (o.headers || {})['x-relay-key'];
        if (p === '/health') return new Response('{"ok":true}');
        if (key !== RKEY) return new Response('{"error":"Not allowed."}', {status: 401});
        if (p === '/ip') return new Response('{"ip":"174.138.123.123"}');
        const q = JSON.parse(o.body); seen.push(q); const url = new URL(q.url), body = q.body ? JSON.parse(q.body) : null;
        if (url.host !== 'api.partner.test') return new Response('{"error":"Host not allowed"}', {status: 403});
        if (partnerDown) return ok({status: 'failure', message: 'Access denied.'}, 403);
        const jwtOk = (t) => { const [hd, pl, sg] = String(t).split('.'); if (!sg) return false; const want = crypto.createHmac('sha256', SECRET).update(hd + '.' + pl).digest('base64url'); const c = JSON.parse(Buffer.from(pl, 'base64url'));
          return sg === want && c.clientId === 'C1' && c.corporateId === 'K9' && c.iss === 'https://vantiscorp.com' && c.aud === 'cbt-bff-api' && c.exp > Date.now() / 1000; };
        const bearer = String(q.headers.authorization || '').replace(/^Bearer /, ''); if (bearer !== TOKEN && !jwtOk(bearer)) return ok({status: 'failure', message: 'Invalid token.'}, 403);
        if (bearer !== TOKEN) signedCalls++;
        if (url.pathname === '/api/LtmReport/ltm_bookings') { const {startDate, endDate} = body.bookingDateRange, all = MOCK.filter((b) => b.bookingDate >= startDate && b.bookingDate <= endDate);
          return ok({status: 'success', totalCount: all.length, bookings: all.slice(body.pagination.offset, body.pagination.offset + 2)}); }   // two per page, to exercise paging
        if (url.pathname === '/api/LtmReport/ltm_bookings-transaction-report') return ok({status: 'success', totalBookings: MOCK.length, totalCancelledBookings: 3, currency: 'INR'});
        const vm = /ltm_booking-voucher-links\/(\d+)$/.exec(url.pathname);
        if (vm) return +vm[1] === 900001 ? ok({confirmationVoucherUrl: 'https://files.partner.test/V900001.pdf', reconfirmationVoucherUrl: null, reconfirmationVoucherUrls: []}) : ok({status: 'failure', errorCode: '1313', message: 'No hotel details found for booking id.'}, 404);
        return ok({status: 'failure'}, 500); };
      x = await A('sync/state', {client_id: sco}); check('live sync: starts unset', x.status === 200 && !x.j.sync.has_token && !x.j.sync.has_key && !x.j.sync.enabled);
      x = await A('sync/save', {client_id: sco, token: 'not-a-token'}); check('live sync: a non-token is refused', x.status === 400);
      x = await A('sync/save', {client_id: sco, api_url: 'http://evil.test'}); check('live sync: plain-http partner address refused', x.status === 400);
      x = await A('sync/save', {client_id: sco, relay_key: RKEY, api_url: 'https://api.partner.test/', relay_url: 'https://relay.test', months: 1});
      check('live sync: not live with only the key', x.status === 200 && x.j.sync.enabled === 0 && !x.j.synced);
      x = await A('sync/save', {client_id: sco, token: 'Bearer ' + TOKEN, skip_free_cxl: false});
      check('live sync: goes live as soon as key and token are saved', x.status === 200 && x.j.sync.enabled === 1 && x.j.synced && x.j.synced.ok, JSON.stringify(x.j.synced));
      x = await A('sync/save', {client_id: sco, skip_free_cxl: true});
      DB.raw.prepare("DELETE FROM transactions WHERE client_id = ?").run(sco); DB.raw.prepare("DELETE FROM tx_uploads WHERE client_id = ?").run(sco);
      check('live sync: settings saved; secrets never sent back', x.status === 200 && x.j.sync.has_token && x.j.sync.has_key && x.j.sync.token.client === 7 && !!x.j.sync.token.exp && !JSON.stringify(x.j).includes(RKEY) && !JSON.stringify(x.j).includes('.sig'));
      const au = DB.raw.prepare("SELECT detail FROM audit WHERE action = 'Changed the live hotel sync settings' ORDER BY id DESC LIMIT 1").get();
      check('live sync: audit log keeps neither token nor key', !!au && !String(au.detail).includes(RKEY) && !String(au.detail).includes('.sig'));
      x = await A('sync/test', {client_id: sco}); check('live sync: connection check passes all steps', x.status === 200 && x.j.steps.length === 3 && x.j.steps.every((s) => s.ok) && x.j.steps[1].detail === '174.138.123.123', JSON.stringify(x.j));
      // one booking already uploaded from a report: its billing figures must survive the sync
      const H2 = ['Invoice No', 'Booking Code', 'Guest Name', 'Booked Date', 'Check-In Date', 'Check-Out Date', 'Status', 'Net Amount Charged', 'Transaction Fee'];
      x = await A('tx/import', {client_id: sco, header: H2, rows: [['HB' + fy + '/900002', 'OLD-1', 'Guest 900002', day(2), day(20), day(22), 'Billed', 15340, 100]], filename: 'report.xlsx'});
      check('live sync: report upload before the sync', x.status === 200);
      x = await A('sync/run', {client_id: sco}); const rs = x.j.result || {};
      check('live sync: run pages through and imports', x.status === 200 && rs.fetched === 5 && rs.added === 2 && rs.changed === 1 && rs.skipped_cancelled === 1 && rs.skipped_other === 1, JSON.stringify(x.j));
      check('live sync: partner gets the token and a one-month booking range', seen.some((q) => q.headers.authorization === 'Bearer ' + TOKEN && /T23:59:59Z$/.test(JSON.parse(q.body || '{}').bookingDateRange?.endDate || '')));
      const row = (inv) => { const t = DB.raw.prepare('SELECT row, status FROM transactions WHERE client_id = ? AND code = ?').get(sco, inv); return t ? JSON.parse(t.row) : null; };
      const r1 = row('HB' + fy + '/900001'), r2 = row('HB' + fy + '/900002'), r3 = row('HB' + fy + '/900003');
      check('live sync: total split into tariff, hotel GST (5% slab), net and transaction fee', !!r1 && r1['Net Amount Charged'] === 12882 && r1['Total Tariff'] === 12268.57 && r1['GST Charges'] === 613.43 && r1['Transaction Fee'] === 100 && r1['Transaction Fee GST Charged'] === 18, JSON.stringify(r1));
      check('live sync: cancelled booking nets only its charge', !!r3 && r3['Net Amount Charged'] === 1200 && r3['GST Charges'] === 0);
      check('live sync: amounts checked against the uploaded report', rs.amt_checked === 0);
      check('live sync: new booking stored under the HB invoice with mapped fields', !!r1 && r1['Guest Name'] === 'Guest 900001' && r1['Booking Code'] === 'HC-900001' && r1['Check-In Date'] === day(20) && r1['Stay Days'] === 2 && r1['Emp Code'] === 'E900001' && r1['Booked Date'] === day(2));
      check('live sync: uploaded booking keeps its billing, gets the cancellation', !!r2 && r2.Status === 'Cancelled' && r2['Net Amount Charged'] === 15340 && r2['Booking Code'] === 'OLD-1' && r2['Property Name'] === 'Hotel 900002');
      check('live sync: cancellation with a charge is kept; free one and planned left out', !!r3 && r3['Cancellation Charges Total'] === 1200 && !row('HB' + fy + '/900004') && !row('HB' + fy + '/900005'));
      check('live sync: shows in upload history as Live sync', !!DB.raw.prepare("SELECT 1 FROM tx_uploads WHERE client_id = ? AND filename LIKE 'Live sync%' AND by_email = 'boss@zuna.example'").get(sco));
      x = await A('sync/run', {client_id: sco}); check('live sync: second run changes nothing', x.status === 200 && x.j.result.added === 0 && x.j.result.changed === 0 && x.j.sync.last_ok && !x.j.sync.last_error);
      x = await A('tx/remove', {client_id: sco, code: 'HB' + fy + '/900001'}); x = await A('sync/run', {client_id: sco});
      check('live sync: a booking removed by the team is not brought back', x.j.result.skipped_removed === 1 && !row('HB' + fy + '/900001'));
      x = await A('tx/restore', {client_id: sco, id: DB.raw.prepare("SELECT id FROM tx_removed WHERE client_id = ? ORDER BY id DESC LIMIT 1").get(sco).id});
      const V = async (code) => { const y = await call('/api/tx/voucher', {method: 'POST', body: {client_id: sco, code}, cookie: admin}); return {status: y.status, j: await y.json()}; };
      x = await call('/api/tx', {method: 'POST', body: {client_id: sco}, cookie: admin}); check('live sync: hotel bookings page knows vouchers are available', (await x.json()).live === true);
      x = await V('HB' + fy + '/900001'); check('live sync: voucher link fetched for a booking', x.status === 200 && x.j.confirmation === 'https://files.partner.test/V900001.pdf');
      x = await V('HB' + fy + '/900003'); check('live sync: partner 404 for a voucher is explained', x.status === 404);
      x = await V('HB' + fy + '/123'); check('live sync: voucher only for bookings in the portal', x.status === 404);
      x = await call('/api/tx/voucher', {method: 'POST', body: {client_id: sco, code: 'HB' + fy + '/900001'}, cookie: asha}); check('live sync: other client cannot fetch the voucher', x.status === 404 || x.status === 403);
      MOCK.push(bk(900006, 'Confirmed'), bk(900007, 'Confirmed', {totalNumberOfNights: 1, totalAmountINR: 10148}));
      await worker.scheduled({cron: '*/15 * * * *'}, env, {waitUntil: (p) => p}); await new Promise((r) => setTimeout(r, 50));
      check('live sync: the 15-minute trigger picks up a new booking', !!row('HB' + fy + '/900006'));
      { const r7 = row('HB' + fy + '/900007'); check('live sync: room above Rs 7,500 a night gets 18% GST', !!r7 && r7['Total Tariff'] === 8500 && r7['GST Charges'] === 1530, JSON.stringify(r7)); }
      x = await A('sync/save', {client_id: sco, gst_slab: false}); check('live sync: GST slab can be switched off', x.status === 200 && x.j.sync.gst_slab === 0);
      x = await A('sync/save', {client_id: sco, jwt_secret: SECRET, jwt_client: 'C1', jwt_corporate: 'K9'});
      check('live sync: signing secret saved, never sent back', x.status === 200 && x.j.sync.signing.has_secret && x.j.sync.signing.client === 'C1' && !JSON.stringify(x.j).includes(SECRET) && x.j.synced && x.j.synced.ok, JSON.stringify(x.j.synced));
      check('live sync: portal signs its own token the partner accepts', signedCalls > 0);
      check('live sync: audit log keeps no signing secret', !DB.raw.prepare("SELECT 1 FROM audit WHERE detail LIKE ?").get('%' + SECRET + '%'));
      partnerDown = true; x = await A('sync/run', {client_id: sco});
      check('live sync: an IP refusal is reported plainly and kept as last error', x.status === 502 && /allow-list/.test(x.j.error) && /allow-list/.test(x.j.sync.last_error) && !!x.j.sync.last_ok);
      globalThis.fetch = prevFetch;
    }
    { // audit log + backups (Zuna admin only)
      let x = await call('/api/login', {method: 'POST', body: {email: 'asha@acme.example', password: 'wrong-password-1'}});
      x = await A('audit', {kind: 'signin'});
      check('failed sign-in is in the audit log, without the password', x.status === 200 && x.j.rows.some((r) => r.action === 'Sign-in failed' && r.email === 'asha@acme.example') && !JSON.stringify(x.j.rows).includes('wrong-password-1'));
      x = await A('audit', {kind: 'bookings'});
      check('bookings are in the audit log with who and what', x.j.rows.some((r) => r.action === 'Booked a stay' && r.email === 'asha@acme.example' && r.role && /Acme House/.test(r.target)));
      x = await A('audit', {kind: 'rates'});
      check('rate changes are in the audit log', x.j.rows.some((r) => r.action === 'Saved a rate') && x.j.rows.some((r) => r.action === 'Changed the service charge'));
      x = await A('audit', {q: 'Plan Test'}); check('audit log can be searched', x.j.rows.length > 0 && x.j.rows.every((r) => JSON.stringify(r).includes('Plan Test')));
      const before = (await A('audit', {limit: 5000})).j.rows.length; await A('state', {}); await A('quote', {gh_id: 1, check_in: D(1), check_out: D(2)});
      check('reading screens is not logged', (await A('audit', {limit: 5000})).j.rows.length === before);
      check('client users cannot read the audit log', (await call('/api/admin/audit', {method: 'POST', body: {}, cookie: meera})).status === 403);
      const kv = new Map(); env.BACKUPS = {put: async (k, v, o) => kv.set(k, {v, m: o && o.metadata}), get: async (k) => (kv.get(k) || {}).v || null, delete: async (k) => kv.delete(k), list: async ({prefix}) => ({keys: [...kv].filter(([k]) => k.startsWith(prefix)).map(([k, x]) => ({name: k, metadata: x.m}))})};
      x = await A('backup', {}); check('back up now saves a compressed copy', x.status === 200 && x.j.backup.rows > 0 && x.j.backup.tables > 5);
      x = await A('backups', {}); check('backups are listed', x.j.ready && x.j.backups.length === 1 && x.j.backups[0].by === 'boss@zuna.example');
      const dl = await call('/api/admin/backup/download', {method: 'POST', body: {key: x.j.backups[0].key}, cookie: admin});
      const bk = JSON.parse(await new Response((await dl.blob()).stream().pipeThrough(new DecompressionStream('gzip'))).text());
      check('backup download has every table, but no sign-in sessions or reset codes', dl.status === 200 && bk.format === 'ltmgh-backup-1' && bk.tables.trips.length > 0 && bk.tables.gh_rates.length > 0 && !('sessions' in bk.tables) && !('resets' in bk.tables));
      check('a backup outside the backup folder cannot be downloaded', (await call('/api/admin/backup/download', {method: 'POST', body: {key: '../x'}, cookie: admin})).status === 404);
      kv.set('backup/old.json.gz', {v: new ArrayBuffer(1), m: {at: new Date(Date.now() - 40 * 864e5).toISOString()}}); await A('backup', {});
      check('backups older than 30 days are deleted', !kv.has('backup/old.json.gz') && [...kv.keys()].length === 2);
      delete env.BACKUPS;
    }
    await M('user/access', {email: 'asha@acme.example', book: false});
    check('switching Book rooms off blocks booking', (await B(asha, 'book', {property: 'Acme House', check_in: D(220), check_out: D(221), title: 'Mr.', name: 'X Y', grade: 'E1'})).status === 403); }
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
