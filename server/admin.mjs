// Admin tasks for the self-hosted SQLite database.
//
//   node server/admin.mjs load-data <bookings.csv> <properties.csv> <period.json>   load / replace the dashboard data
//   node server/admin.mjs apply-sql <file.sql>                                      e.g. users.sql from tools/make_users.py
//   node server/admin.mjs users                                                     list accounts
//   node server/admin.mjs disable <email>   |   enable <email>                      switch an account off / on
//   node server/admin.mjs status                                                    dataset dates and row counts
//
// Uses DB_PATH (default ./var/ltmgh.sqlite).
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openDb} from './db.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = openDb(process.env.DB_PATH || path.join(root, 'var', 'ltmgh.sqlite')).raw;
const [cmd, ...args] = process.argv.slice(2);

function parseCsv(text) {           // RFC 4180: quoted fields, "" escapes, CRLF or LF
  const rows = []; let row = [], f = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
    if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((x) => x !== ''));
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}
const today = () => new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Kolkata'}).format(new Date());
const put = db.prepare('INSERT OR REPLACE INTO datasets (id, json, updated_at) VALUES (?, ?, ?)');

switch (cmd) {
  case 'load-data': {
    const [b, p, per] = args;
    if (!b || !p || !per) throw new Error('usage: load-data <bookings.csv> <properties.csv> <period.json>');
    const bookings = parseCsv(fs.readFileSync(b, 'utf8')), properties = parseCsv(fs.readFileSync(p, 'utf8')), period = JSON.parse(fs.readFileSync(per, 'utf8'));
    for (const need of ['property', 'guest', 'check_in', 'check_out', 'status']) if (bookings[0] && !(need in bookings[0])) throw new Error('bookings.csv is missing column ' + need);
    db.exec('BEGIN');
    put.run('bookings', JSON.stringify(bookings), today()); put.run('properties', JSON.stringify(properties), today()); put.run('period', JSON.stringify(period), today());
    db.exec('COMMIT');
    console.log(`Loaded ${bookings.length} bookings, ${properties.length} properties, period ${JSON.stringify(period)}`);
    break;
  }
  case 'apply-sql': db.exec(fs.readFileSync(args[0], 'utf8')); console.log('Applied', args[0]); break;
  case 'users': console.table(db.prepare('SELECT email, name, active, failed, locked_until, last_login FROM users ORDER BY email').all()); break;
  case 'disable': case 'enable': {
    const r = db.prepare('UPDATE users SET active = ? WHERE email = ?').run(cmd === 'enable' ? 1 : 0, String(args[0] || '').toLowerCase());
    if (cmd === 'disable') db.prepare('DELETE FROM sessions WHERE email = ?').run(String(args[0] || '').toLowerCase());
    console.log(r.changes ? `${cmd}d ${args[0]}` : 'No such account'); break;
  }
  case 'status': console.table(db.prepare('SELECT id, updated_at, length(json) AS bytes FROM datasets').all()); break;
  default: console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 11).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}
