#!/usr/bin/env python3
"""Create or reset login accounts for the ltmgh portal.

Input : a CSV with columns  email,name   (email can also be a plain user ID, e.g. "ltm.admin")
Output (in the folder given by --out, default ./accounts_out — keep it out of git):
  users.sql          Cloudflare: paste into D1 console (or `wrangler d1 execute <db> --remote --file users.sql`)
                     Self-hosted: `npm run admin -- apply-sql users.sql`
  credentials.csv    email,name,password  -> share with each person privately, then delete
  users.json         same accounts as JSON (salt + hash only), for scripted setups

Re-running for an existing email RESETS that person's password and unlocks the account.
Hashing matches worker_src.js: PBKDF2-SHA256, 10,000 iterations, 16-byte hex salt, 32-byte hex hash.
"""
import argparse, csv, hashlib, json, os, secrets

ITER = 10000
ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"  # no 0/O/1/l/I

def make_password():
    # e.g. Kq7m-Xw3P-tR9a : 12 random chars in 3 groups, always has upper, lower, digit
    while True:
        raw = "".join(secrets.choice(ALPHA) for _ in range(12))
        if any(c.isupper() for c in raw) and any(c.islower() for c in raw) and any(c.isdigit() for c in raw):
            return "-".join(raw[i:i + 4] for i in range(0, 12, 4))

def hash_pw(pw, salt_hex):
    return hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt_hex), ITER).hex()

def q(s):
    return "'" + str(s).replace("'", "''") + "'"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv", help="CSV with columns email,name")
    ap.add_argument("--out", default="accounts_out")
    a = ap.parse_args()
    rows = [r for r in csv.DictReader(open(a.csv, encoding="utf-8-sig")) if (r.get("email") or "").strip()]
    os.makedirs(a.out, exist_ok=True)
    sql, creds, js, seen = [], [], [], set()
    for r in rows:
        email = r["email"].strip().lower()[:200]   # worker lower-cases what people type
        name = (r.get("name") or "").strip() or email
        if email in seen:
            raise SystemExit(f"Duplicate email/ID in CSV: {email}")
        seen.add(email)
        pw = (r.get("password") or "").strip() or make_password()
        salt = secrets.token_hex(16)
        h = hash_pw(pw, salt)
        sql.append(
            f"INSERT INTO users (email, name, salt, hash, active, failed, locked_until) VALUES ({q(email)}, {q(name)}, {q(salt)}, {q(h)}, 1, 0, NULL) "
            f"ON CONFLICT(email) DO UPDATE SET name = excluded.name, salt = excluded.salt, hash = excluded.hash, active = 1, failed = 0, locked_until = NULL;")
        creds.append({"email": email, "name": name, "password": pw})
        js.append({"email": email, "name": name, "salt": salt, "hash": h})
    open(os.path.join(a.out, "users.sql"), "w").write("\n".join(sql) + "\n")
    with open(os.path.join(a.out, "credentials.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["email", "name", "password"]); w.writeheader(); w.writerows(creds)
    json.dump(js, open(os.path.join(a.out, "users.json"), "w"), indent=1)
    print(f"{len(rows)} account(s) -> {a.out}/users.sql, credentials.csv, users.json")

if __name__ == "__main__":
    main()
