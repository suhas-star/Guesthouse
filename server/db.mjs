// SQLite store with the same small API the app uses on Cloudflare D1
// (prepare().bind().first()/all()/run() and batch()).
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS datasets (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, name TEXT, salt TEXT, hash TEXT, active INTEGER DEFAULT 1, failed INTEGER DEFAULT 0, locked_until TEXT, last_login TEXT);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, email TEXT, expires TEXT, created TEXT);
CREATE TABLE IF NOT EXISTS resets (email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires TEXT NOT NULL, tries INTEGER DEFAULT 0, created TEXT NOT NULL);
`;

export function openDb(file) {
  fs.mkdirSync(path.dirname(path.resolve(file)), {recursive: true});
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  const stmt = (q, args = []) => ({
    bind: (...a) => stmt(q, a),
    first: async () => db.prepare(q).get(...args) ?? null,
    all: async () => ({results: db.prepare(q).all(...args)}),
    run: async () => db.prepare(q).run(...args),
  });
  return {
    raw: db,
    prepare: (q) => stmt(q),
    batch: async (list) => {
      db.exec('BEGIN');
      try { const out = []; for (const s of list) out.push(await s.run()); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}
