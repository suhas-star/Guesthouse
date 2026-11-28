#!/bin/bash
# Zuna relay setup for a DigitalOcean droplet with a Reserved IP (Ubuntu 24.04). Run as root in the droplet console.
set -e
export DEBIAN_FRONTEND=noninteractive
META=http://169.254.169.254/metadata/v1
RIP=$(curl -s $META/reserved_ip/ipv4/ip_address || true)
[ -z "$RIP" ] && RIP=$(curl -s $META/floating_ip/ipv4/ip_address || true)
[ -z "$RIP" ] && { echo "No Reserved IP is assigned to this droplet. Assign one first."; exit 1; }
HOST=$(echo "$RIP" | tr . -).sslip.io
echo "== Reserved IP $RIP, address https://$HOST"

echo "== 1/5 packages"
apt-get update -qq
apt-get install -y -qq nodejs curl gnupg debian-keyring debian-archive-keyring apt-transport-https >/dev/null
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -qq && apt-get install -y -qq caddy >/dev/null

echo "== 2/5 outgoing traffic through the Reserved IP"
cat > /etc/systemd/system/zuna-route.service <<'UNIT'
[Unit]
Description=Send outgoing traffic through the DigitalOcean Reserved IP
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/bin/sh -c 'GW=$(curl -s http://169.254.169.254/metadata/v1/interfaces/public/0/anchor_ipv4/gateway); [ -n "$GW" ] && ip route replace default via $GW dev eth0'
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable --now zuna-route.service
sleep 2

echo "== 3/5 relay"
mkdir -p /opt/zuna-relay
cat > /opt/zuna-relay/relay.mjs <<'ZUNA_RELAY_EOF'
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
ZUNA_RELAY_EOF
if [ ! -f /opt/zuna-relay/env ]; then
  printf 'RELAY_KEY=%s\nALLOW_HOSTS=\nPORT=8080\n' "$(openssl rand -hex 32)" > /opt/zuna-relay/env
  chmod 600 /opt/zuna-relay/env
fi
cat > /etc/systemd/system/zuna-relay.service <<'UNIT'
[Unit]
Description=Zuna relay
After=network-online.target zuna-route.service
[Service]
EnvironmentFile=/opt/zuna-relay/env
ExecStart=/usr/bin/node /opt/zuna-relay/relay.mjs
Restart=always
DynamicUser=yes
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable --now zuna-relay.service

echo "== 4/5 HTTPS"
printf '%s {\n  reverse_proxy 127.0.0.1:8080\n}\n' "$HOST" > /etc/caddy/Caddyfile
systemctl restart caddy
sleep 8

echo "== 5/5 check"
OUT=$(curl -s https://api.ipify.org || true)
H=$(curl -s https://$HOST/health || true)
echo
echo "Outgoing IP seen by partners : $OUT  (should be $RIP)"
echo "Relay over HTTPS             : ${H:-not ready yet, wait a minute}"
echo "Relay address                : https://$HOST"
echo "Relay key (keep secret)      : $(grep RELAY_KEY /opt/zuna-relay/env | cut -d= -f2)"
[ "$OUT" = "$RIP" ] && echo "ALL GOOD" || echo "Outgoing IP differs: tell the Zuna tech team."
