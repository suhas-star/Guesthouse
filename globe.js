(() => {
  const cv = document.getElementById('globe'); if (!cv) return;
  const ctx = cv.getContext('2d');
  const D = window.__DOTS || [];
  const P = []; for (let i = 0; i < D.length; i += 2) P.push([D[i] / 10 * Math.PI / 180, D[i + 1] / 10 * Math.PI / 180]);
  const CITIES = [[78.49,17.39],[77.59,12.97],[72.88,19.08],[77.21,28.61],[80.27,13.08],[88.36,22.57],[55.27,25.2],[51.53,25.29],[103.82,1.35],[114.17,22.32],[139.69,35.69],[126.98,37.57],[121.47,31.23],[151.21,-33.87],[144.96,-37.81],[174.76,-36.85],[106.85,-6.21],[100.5,13.75],[-0.13,51.51],[2.35,48.86],[8.68,50.11],[4.9,52.37],[-3.7,40.42],[12.5,41.9],[37.62,55.75],[31.24,30.04],[36.82,-1.29],[28.05,-26.2],[3.38,6.52],[-74.0,40.71],[-79.38,43.65],[-87.63,41.88],[-122.42,37.77],[-118.24,34.05],[-99.13,19.43],[-46.63,-23.55],[-58.38,-34.6],[-70.67,-33.45],[-77.04,-12.05],[-43.17,-22.9]].map(([lo, la]) => [lo * Math.PI / 180, la * Math.PI / 180]);
  const live = []; let nextSpawn = 0;
  const rad = (d) => d * Math.PI / 180;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let W = 0, H = 0, R = 0, cx = 0, cy = 0, dpr = 1;
  const size = () => { const r = cv.getBoundingClientRect(); dpr = Math.min(2, window.devicePixelRatio || 1); W = r.width; H = r.height; cv.width = W * dpr; cv.height = H * dpr; const ds = cv.dataset; R = (ds.rbase === 'w' ? W : Math.min(W, H)) * (+ds.r || 0.44); cx = W * (ds.cx ? +ds.cx : 0.5); cy = ds.top ? H * +ds.top + R : H * (ds.cy ? +ds.cy : 0.5); };
  size(); addEventListener('resize', size);
  let lon0 = rad(80), lat0 = rad(cv.dataset.lat ? +cv.dataset.lat : 18), drag = null, userOff = 0, t0 = performance.now(), intro = 0;
  const proj = (lon, lat, lift = 1) => {
    const cl = Math.cos(lat), x = cl * Math.sin(lon - lon0), y = Math.sin(lat), z = cl * Math.cos(lon - lon0);
    const y2 = y * Math.cos(lat0) - z * Math.sin(lat0), z2 = y * Math.sin(lat0) + z * Math.cos(lat0);
    return [cx + x * R * lift, cy - y2 * R * lift, z2];
  };
  const slerp = (a, b, t) => {
    const v = (l, p) => [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
    const A = v(a[0], a[1]), B = v(b[0], b[1]); const d = Math.acos(Math.max(-1, Math.min(1, A[0]*B[0]+A[1]*B[1]+A[2]*B[2]))) || 1e-6;
    const s1 = Math.sin((1 - t) * d) / Math.sin(d), s2 = Math.sin(t * d) / Math.sin(d);
    const x = s1*A[0]+s2*B[0], y = s1*A[1]+s2*B[1], z = s1*A[2]+s2*B[2];
    return [Math.atan2(y, x), Math.atan2(z, Math.hypot(x, y))];
  };
  cv.addEventListener('pointerdown', (e) => { drag = {x: e.clientX, off: userOff}; cv.setPointerCapture(e.pointerId); cv.style.cursor = 'grabbing'; });
  cv.addEventListener('pointermove', (e) => { if (drag) userOff = drag.off + (e.clientX - drag.x) / R; });
  const up = () => { drag = null; cv.style.cursor = 'grab'; }; cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  const frame = (now) => {
    const t = (now - t0) / 1000; intro = Math.min(1, t / 1.6); const ease = 1 - Math.pow(1 - intro, 3);
    if (!drag) userOff *= 0.985;
    lon0 = rad(80) + (reduce ? 0 : -(t * 2 * Math.PI / 60)) - userOff - (1 - ease) * rad(70);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    // atmosphere
    let g = ctx.createRadialGradient(cx, cy, R * 0.85, cx, cy, R * 1.25); g.addColorStop(0, 'rgba(2,201,136,.20)'); g.addColorStop(1, 'rgba(2,201,136,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R * 1.25, 0, 7); ctx.fill();
    g = ctx.createRadialGradient(cx - R * .35, cy - R * .4, R * .1, cx, cy, R); g.addColorStop(0, '#2a1680'); g.addColorStop(1, '#0d0047');
    ctx.globalAlpha = ease; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(2,201,136,.35)'; ctx.lineWidth = 1; ctx.stroke();
    // graticule
    ctx.strokeStyle = 'rgba(255,255,255,.05)';
    for (let la = -60; la <= 60; la += 30) { ctx.beginPath(); let f = true; for (let lo = -180; lo <= 180; lo += 4) { const [x, y, z] = proj(rad(lo), rad(la)); if (z < 0) { f = true; continue; } f ? ctx.moveTo(x, y) : ctx.lineTo(x, y); f = false; } ctx.stroke(); }
    // land dots
    const dot = 1.7 * Math.min(1.35, Math.max(1, R / 300));
    for (const [lo, la] of P) { const [x, y, z] = proj(lo, la); if (z <= 0) continue;
            ctx.fillStyle = 'rgba(141,120,214,' + (0.22 + 0.55 * z) + ')';
      ctx.beginPath(); ctx.arc(x, y, dot * 0.55 * (0.6 + 0.4 * z), 0, 7); ctx.fill(); }
    ctx.globalAlpha = 1;
    // arcs between cities
    if (t > 1 && t > nextSpawn && live.length < 14) {
      const vis = CITIES.filter((c) => proj(c[0], c[1])[2] > 0.25);
      if (vis.length > 1) { const A = vis[Math.random() * vis.length | 0]; let B = CITIES[Math.random() * CITIES.length | 0]; if (B !== A) live.push({A, B, s: t, d: 2.2 + Math.random() * 1.6}); }
      nextSpawn = t + 0.18 + Math.random() * 0.25;
    }
    for (let i = live.length - 1; i >= 0; i--) {
      const L = live[i], k = (t - L.s) / L.d; if (k >= 1.45) { live.splice(i, 1); continue; }
      const head = Math.min(1, k), tail = Math.max(0, k - 0.45);
      const dist = Math.acos(Math.max(-1, Math.min(1, Math.sin(L.A[1]) * Math.sin(L.B[1]) + Math.cos(L.A[1]) * Math.cos(L.B[1]) * Math.cos(L.A[0] - L.B[0]))));
      const lift = (0.05 + 0.22 * dist / Math.PI) * (cv.dataset.lift ? +cv.dataset.lift : 1);
      ctx.beginPath(); let first = true, vis = false, hx = 0, hy = 0, hz = -1;
      for (let s2 = tail; s2 <= head + 1e-6; s2 += 0.02) { const u = Math.min(s2, head); const p = slerp(L.A, L.B, u); const [x, y, z] = proj(p[0], p[1], 1 + lift * Math.sin(Math.PI * u)); if (z < 0 && (x - cx) ** 2 + (y - cy) ** 2 < R * R) { first = true; continue; } vis = true; first ? ctx.moveTo(x, y) : ctx.lineTo(x, y); first = false; hx = x; hy = y; hz = z; }
      const fade = k > 1 ? Math.max(0, 1 - (k - 1) / 0.45) : 1;
      if (vis) { ctx.strokeStyle = 'rgba(2,201,136,' + (0.85 * fade) + ')'; ctx.lineWidth = 1.6; ctx.lineCap = 'round'; ctx.stroke(); }
      if (k < 1 && hz > 0) { ctx.fillStyle = '#4fd9aa'; ctx.beginPath(); ctx.arc(hx, hy, 2.2, 0, 7); ctx.fill(); }
      if (k >= 1 && k < 1.45) { const [x, y, z] = proj(L.B[0], L.B[1]); if (z > 0) { const ph = (k - 1) / 0.45; ctx.strokeStyle = 'rgba(2,201,136,' + (1 - ph) * 0.9 + ')'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, 2 + ph * 12, 0, 7); ctx.stroke(); } }
    }
    // city points
    for (const c of CITIES) { const [x, y, z] = proj(c[0], c[1]); if (z < 0.05) continue; ctx.fillStyle = 'rgba(2,201,136,' + (0.4 + 0.6 * z) + ')'; ctx.beginPath(); ctx.arc(x, y, 2.4, 0, 7); ctx.fill(); }
    if (!reduce || t < 2) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
})();
