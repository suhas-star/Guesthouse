/* Zuna UI kit: branded dropdowns (for every <select> and type-ahead field) and default artwork. */
const ZUI = (() => {
  const st = document.createElement('style');
  st.textContent = `
.zd-hide{position:absolute!important;width:1px!important;height:1px!important;opacity:0!important;pointer-events:none!important;overflow:hidden}
.zd-btn{display:flex;align-items:center;gap:.5rem;text-align:left;cursor:pointer}
.zd-btn:disabled{cursor:not-allowed;opacity:.6}
.zd-val{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zd-ph{color:#716b9b;font-weight:400}
.zd-chev{width:16px;height:16px;flex-shrink:0;color:#8a83b3;transition:transform .18s ease}
[aria-expanded=true]>.zd-chev,[aria-expanded=true]+.zd-chev{transform:rotate(180deg);color:#02C988}
.zd-panel{position:fixed;z-index:1000;max-height:288px;max-width:min(520px,calc(100vw - 16px));overflow:auto;padding:6px;border-radius:14px;background:#fff;
  box-shadow:0 0 0 1px #e6e2f6,0 18px 40px -12px rgba(18,0,90,.28),0 4px 12px -4px rgba(18,0,90,.12);animation:zdIn .14s ease-out;
  font-family:inherit;scrollbar-width:thin;scrollbar-color:#cdc5ec transparent}
@keyframes zdIn{from{opacity:0;transform:translateY(-4px) scale(.985)}to{opacity:1;transform:none}}
.zd-opt{display:flex;align-items:center;gap:.6rem;padding:.5rem .65rem;border-radius:10px;font-size:.875rem;line-height:1.25rem;color:#12005A;cursor:pointer}
.zd-opt[data-act]{background:#ecfbf5}
.zd-opt[aria-selected=true]{font-weight:600}
.zd-opt[aria-selected=true] .zd-ck{opacity:1}
.zd-tx{flex:1;min-width:0}
.zd-sub{font-size:.75rem;color:#7a74a3;font-weight:400;margin-top:1px}
.zd-hl{font-weight:700;color:#00744f;background:none}
.zd-ck{width:16px;height:16px;color:#02C988;opacity:0;flex-shrink:0}
.zd-ph-opt{color:#716b9b}
.zd-opt.zd-dis{opacity:.5;cursor:not-allowed}
.zd-opt.zd-dis[data-act]{background:#f4f2fb}
.zd-group{padding:.55rem .65rem .25rem;font-size:.6875rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#716b9b}
.zd-empty{padding:.75rem;font-size:.8125rem;color:#7a74a3;text-align:center}
.zd-spin{display:inline-block;width:12px;height:12px;margin-right:6px;vertical-align:-2px;border-radius:50%;border:2px solid #cdc5ec;border-top-color:#02C988;animation:zdSpin .7s linear infinite}
@keyframes zdSpin{to{transform:rotate(360deg)}}
.zd-cwrap{position:relative}.zd-cwrap>input{padding-right:2.25rem}
.zd-cwrap>.zd-chev{position:absolute;right:.75rem;top:50%;margin-top:-8px;cursor:pointer}
@media (prefers-reduced-motion:reduce){.zd-panel{animation:none}}
html.dark .zd-panel{background:#150c45;box-shadow:0 0 0 1px #2a2066,0 18px 40px -12px rgba(0,0,0,.6)}
html.dark .zd-opt{color:#eeeaff}html.dark .zd-opt[data-act]{background:#241866}html.dark .zd-sub,html.dark .zd-group,html.dark .zd-empty{color:#b3aadf}html.dark .zd-ph{color:#8f86c4}html.dark .zd-hl{color:#4fd9aa}
html.dark .zc-card{background:#150c45;color:#eeeaff;box-shadow:0 30px 70px -20px rgba(0,0,0,.7),0 0 0 1px #2a2066}html.dark .zc-m{color:#b3aadf}html.dark .zc-foot{background:#110a3a;border-color:#2a2066}
html.dark .zc-cancel{background:#150c45;color:#eeeaff;box-shadow:inset 0 0 0 1px #2a2066}html.dark .zc-cancel:hover{background:#241866}html.dark .zc-ok.primary,html.dark .zc-ok.warn{background:#2d1a9e}
html.dark .zc-list{background:rgba(245,158,11,.13);color:#fcd34d;box-shadow:inset 0 0 0 1px rgba(245,158,11,.35)}
.zc-ov{position:fixed;inset:0;z-index:2000;display:grid;place-items:center;padding:16px;background:rgba(18,0,90,.42);backdrop-filter:blur(3px);animation:zcFade .15s ease-out}
.zc-card{width:100%;max-width:440px;background:#fff;border-radius:20px;box-shadow:0 30px 70px -20px rgba(18,0,90,.5),0 0 0 1px rgba(18,0,90,.06);overflow:hidden;animation:zcPop .18s cubic-bezier(.2,.8,.2,1);font-family:inherit;color:#12005A}
.zc-body{display:flex;gap:16px;padding:24px 24px 20px}
.zc-ic{flex-shrink:0;width:44px;height:44px;border-radius:14px;display:grid;place-items:center}
.zc-ic svg{width:22px;height:22px}
.zc-ic.primary{background:#e6faf3;color:#019b69}.zc-ic.danger{background:#fff1f2;color:#e11d48}.zc-ic.warn{background:#fffbeb;color:#d97706}
.zc-t{margin:2px 0 6px;font-size:17px;font-weight:700;line-height:1.3}
.zc-m{margin:0;font-size:14px;line-height:1.55;color:#5d5887}
.zc-m+.zc-m{margin-top:6px}
.zc-list{margin:10px 0 0;padding:10px 12px;border-radius:12px;background:#fffbeb;box-shadow:inset 0 0 0 1px #fde68a;font-size:13px;line-height:1.5;color:#92400e;list-style:none}
.zc-list li+li{margin-top:6px}
.zc-foot{display:flex;justify-content:flex-end;gap:8px;padding:14px 20px;background:#f8f7fd;border-top:1px solid #eeeaf9}
.zc-b{height:38px;padding:0 16px;border-radius:11px;font-size:14px;font-weight:600;cursor:pointer;border:0;transition:background .15s,box-shadow .15s,transform .05s}
.zc-b:active{transform:translateY(1px)}
.zc-b:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(2,201,136,.45)}
.zc-cancel{background:#fff;color:#12005A;box-shadow:inset 0 0 0 1px #e1dcf4}.zc-cancel:hover{background:#f4f2fc}
.zc-ok.primary{background:#12005A;color:#fff}.zc-ok.primary:hover{background:#24127a}
.zc-ok.danger{background:#e11d48;color:#fff}.zc-ok.danger:hover{background:#be123c}
.zc-ok.warn{background:#12005A;color:#fff}.zc-ok.warn:hover{background:#24127a}
@keyframes zcFade{from{opacity:0}to{opacity:1}}@keyframes zcPop{from{opacity:0;transform:translateY(8px) scale(.97)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.zc-ov,.zc-card{animation:none}}`;
  document.head.appendChild(st);
  const NS = 'http://www.w3.org/2000/svg';
  const svgIcon = (cls, d) => { const s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2.5'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('class', cls); s.setAttribute('aria-hidden', 'true'); const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.appendChild(p); return s; };
  const chevron = () => svgIcon('zd-chev', 'm6 9 6 6 6-6');
  const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
  const hl = (label, q) => { const f = document.createDocumentFragment(); const i = q ? label.toLowerCase().indexOf(q.toLowerCase()) : -1;
    if (i < 0) { f.appendChild(document.createTextNode(label)); return f; }
    f.append(label.slice(0, i), el('b', 'zd-hl', label.slice(i, i + q.length)), label.slice(i + q.length)); return f; };

  // ---- one floating list at a time ----
  let cur = null;
  const close = () => { if (!cur) return; const c = cur; cur = null; c.panel.remove(); c.anchor.setAttribute('aria-expanded', 'false'); };
  const place = (c) => { const r = c.anchor.getBoundingClientRect(), p = c.panel;
    if (r.bottom < 0 || r.top > innerHeight) { close(); return; }
    p.style.minWidth = r.width + 'px'; p.style.left = Math.max(8, Math.min(r.left, innerWidth - p.offsetWidth - 8)) + 'px';
    const below = innerHeight - r.bottom - 12;
    if (p.offsetHeight > below && r.top > below) { p.style.top = ''; p.style.bottom = (innerHeight - r.top + 6) + 'px'; } else { p.style.bottom = ''; p.style.top = (r.bottom + 6) + 'px'; } };
  document.addEventListener('mousedown', (e) => { if (cur && !cur.panel.contains(e.target) && !cur.anchor.contains(e.target)) close(); }, true);
  document.addEventListener('scroll', (e) => { if (cur && !cur.panel.contains(e.target)) place(cur); }, true);
  addEventListener('resize', close);
  const setAct = (c, k) => { c.act = k; [...c.panel.querySelectorAll('.zd-opt')].forEach((o) => { if (+o.dataset.k === k) { o.dataset.act = ''; const t = o.offsetTop, b = t + o.offsetHeight; if (t < c.panel.scrollTop) c.panel.scrollTop = t - 6; else if (b > c.panel.scrollTop + c.panel.clientHeight) c.panel.scrollTop = b - c.panel.clientHeight + 6; } else delete o.dataset.act; }); };
  const draw = (c) => { c.panel.replaceChildren();
    if (!c.items.length) { const m = el('div', 'zd-empty'); if (c.loading) m.appendChild(el('span', 'zd-spin')); m.appendChild(document.createTextNode(c.empty || 'No matches')); c.panel.appendChild(m); return; }
    let g;
    c.items.forEach((it, k) => { if (it.group && it.group !== g) { g = it.group; c.panel.appendChild(el('div', 'zd-group', g)); }
      const o = el('div', 'zd-opt' + (it.muted ? ' zd-ph-opt' : '') + (it.disabled ? ' zd-dis' : '')); if (it.disabled) o.setAttribute('aria-disabled', 'true'); o.setAttribute('role', 'option'); o.dataset.k = k; o.setAttribute('aria-selected', it.selected ? 'true' : 'false');
      const tx = el('div', 'zd-tx'); tx.appendChild(hl(String(it.label), c.q)); if (it.sub) tx.appendChild(el('div', 'zd-sub', it.sub)); o.appendChild(tx); o.appendChild(svgIcon('zd-ck', 'M20 6 9 17l-5-5'));
      o.onmousemove = () => { if (c.act !== k) setAct(c, k); }; o.onclick = () => pick(c, it); c.panel.appendChild(o); });
    if (c.act >= 0) setAct(c, c.act); };
  const pick = (c, it) => { if (it.disabled) return; const f = c.onPick; close(); f(it); };
  function show(anchor, items, o = {}) {
    let c = cur && cur.anchor === anchor ? cur : null;
    if (!c) { close(); const panel = el('div', 'zd-panel'); panel.setAttribute('role', 'listbox'); panel.addEventListener('mousedown', (e) => e.preventDefault()); document.body.appendChild(panel); c = cur = {anchor, panel}; anchor.setAttribute('aria-expanded', 'true'); }
    Object.assign(c, {items, onPick: o.onPick, q: o.q || '', empty: o.empty, loading: o.loading});
    c.act = o.active != null ? o.active : items.findIndex((i) => i.selected); draw(c); place(c); return c; }
  const isOpen = (anchor) => !!cur && cur.anchor === anchor;
  // keyboard for the open list; returns true when the key was used
  function key(e, anchor) { if (!isOpen(anchor)) return false; const c = cur, n = c.items.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (n) setAct(c, c.act < 0 ? (e.key === 'ArrowDown' ? 0 : n - 1) : (c.act + (e.key === 'ArrowDown' ? 1 : n - 1)) % n); return true; }
    if (e.key === 'Home' || e.key === 'End') { if (n) { e.preventDefault(); setAct(c, e.key === 'Home' ? 0 : n - 1); return true; } return false; }
    if (e.key === 'Enter') { if (c.act >= 0 && c.items[c.act]) { e.preventDefault(); pick(c, c.items[c.act]); return true; } close(); return false; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return true; }
    if (e.key === 'Tab') { close(); return false; }
    return false; }

  // ---- native <select> -> branded button + list (the select stays the source of truth) ----
  const VAL = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value'), IDX = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
  function select(s) { if (s._zd || !s.parentNode) return;
    const b = el('button', (s.className || '') + ' zd-btn'); b.type = 'button'; b.setAttribute('aria-haspopup', 'listbox'); b.setAttribute('aria-expanded', 'false');
    if (s.getAttribute('aria-label')) b.setAttribute('aria-label', s.getAttribute('aria-label'));
    const lab = el('span', 'zd-val'); b.append(lab, chevron()); s.after(b); s.classList.add('zd-hide'); s.tabIndex = -1; s.setAttribute('aria-hidden', 'true'); s._zd = b;
    const sync = () => { const o = s.options[IDX.get.call(s)]; lab.textContent = o ? o.textContent : ''; lab.classList.toggle('zd-ph', !!o && o.value === '' && !!o.dataset.placeholder); b.disabled = s.disabled; };
    Object.defineProperty(s, 'value', {configurable: true, get() { return VAL.get.call(s); }, set(v) { VAL.set.call(s, v); sync(); }});
    Object.defineProperty(s, 'selectedIndex', {configurable: true, get() { return IDX.get.call(s); }, set(v) { IDX.set.call(s, v); sync(); }});
    s.addEventListener('change', sync); new MutationObserver(sync).observe(s, {childList: true, subtree: true, characterData: true, attributes: true});
    const items = () => [...s.options].map((o, k) => ({value: o.value, label: o.textContent, selected: k === IDX.get.call(s), disabled: o.disabled, muted: o.value === '' && !!o.dataset.placeholder, group: o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label : ''}));
    const open = () => show(b, items(), {onPick: (it) => { if (VAL.get.call(s) !== it.value) { s.value = it.value; s.dispatchEvent(new Event('change', {bubbles: true})); s.dispatchEvent(new Event('input', {bubbles: true})); } b.focus(); }});
    b.onclick = () => isOpen(b) ? close() : open();
    let typed = '', tt;
    b.onkeydown = (e) => { if (key(e, b)) return;
      if (!isOpen(b) && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); open(); return; }
      if (e.key.length === 1 && /\S/.test(e.key)) { typed += e.key.toLowerCase(); clearTimeout(tt); tt = setTimeout(() => typed = '', 700); if (!isOpen(b)) open(); const k = cur.items.findIndex((i) => i.label.toLowerCase().startsWith(typed)); if (k >= 0) setAct(cur, k); } };
    sync(); }
  // enhance every select now and later (forms are built dynamically)
  function auto(root) { root.querySelectorAll('select').forEach(select); new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => { if (n.nodeType !== 1) return; if (n.tagName === 'SELECT') select(n); else n.querySelectorAll && n.querySelectorAll('select').forEach(select); }))).observe(root, {childList: true, subtree: true}); }

  // stop the browser offering previously typed text over our lists
  const noFill = (i) => { i.setAttribute('autocomplete', 'off'); i.setAttribute('autocorrect', 'off'); i.setAttribute('spellcheck', 'false'); i.name = 'z' + Math.random().toString(36).slice(2, 10); i.setAttribute('data-lpignore', 'true'); i.setAttribute('data-1p-ignore', ''); i.setAttribute('data-form-type', 'other'); };

  // ---- default artwork ----
  const enc = (s) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
  const win = (x0, y0, cols, rows, w, hh, gx, gy, lit) => { let o = ''; for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) o += `<rect x="${x0 + c * gx}" y="${y0 + r * gy}" width="${w}" height="${hh}" rx="2" fill="${lit.includes(r * cols + c) ? '#02C988' : '#d9d3f2'}"/>`; return o; };
  const lines = (n, f) => Array.from({length: n}, (_, k) => f(k)).join('');
  const ghArt = enc(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="-160 0 800 300" preserveAspectRatio="xMidYMid slice">
<defs>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#12005A"/><stop offset=".55" stop-color="#3a2795"/><stop offset="1" stop-color="#9c90da"/></linearGradient>
<radialGradient id="hz" cx=".5" cy="1" r=".6"><stop offset="0" stop-color="#02C988" stop-opacity=".28"/><stop offset="1" stop-color="#02C988" stop-opacity="0"/></radialGradient>
<linearGradient id="gl" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f3f1fd"/><stop offset=".45" stop-color="#b9b0e8"/><stop offset="1" stop-color="#4a37a8"/></linearGradient>
<linearGradient id="gl2" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#cfc8f1"/><stop offset="1" stop-color="#2f1d8c"/></linearGradient>
<linearGradient id="gl3" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d9d3f5"/><stop offset="1" stop-color="#3b2898"/></linearGradient>
<linearGradient id="lobby" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e6fff5"/><stop offset="1" stop-color="#7fe8c3"/></linearGradient>
<linearGradient id="pl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a1784"/><stop offset="1" stop-color="#12005A"/></linearGradient>
<radialGradient id="glow" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#b8f5df" stop-opacity=".9"/><stop offset="1" stop-color="#02C988" stop-opacity="0"/></radialGradient>
<clipPath id="ct"><rect x="160" y="34" width="160" height="206"/></clipPath>
</defs>
<rect x="-160" width="800" height="300" fill="url(#sky)"/><rect x="-160" width="800" height="300" fill="url(#hz)"/>
<g fill="#fff"><circle cx="-110" cy="30" r="1.1" opacity=".7"/><circle cx="-30" cy="58" r=".9" opacity=".5"/><circle cx="60" cy="22" r="1.2" opacity=".6"/><circle cx="410" cy="26" r="1" opacity=".6"/><circle cx="520" cy="54" r="1.2" opacity=".7"/><circle cx="600" cy="20" r=".9" opacity=".5"/></g>
<g fill="#2a1784" opacity=".55"><rect x="-150" y="150" width="50" height="150"/><rect x="-92" y="118" width="36" height="182"/><rect x="-48" y="168" width="58" height="132"/><rect x="470" y="140" width="44" height="160"/><rect x="520" y="104" width="34" height="196"/><rect x="560" y="160" width="70" height="140"/></g>
<g fill="#cfc8f1" opacity=".35">${lines(6, (k) => `<rect x="-86" y="${130 + k * 22}" width="24" height="3"/>`)}${lines(7, (k) => `<rect x="526" y="${118 + k * 22}" width="22" height="3"/>`)}</g>
<rect x="84" y="96" width="84" height="150" fill="url(#gl2)"/><g fill="#fff" opacity=".4"><rect x="98" y="123" width="14" height="15"/><rect x="126" y="153" width="14" height="15"/><rect x="140" y="108" width="14" height="15"/><rect x="112" y="198" width="14" height="15"/></g><g stroke="#fff" stroke-opacity=".22">${lines(9, (k) => `<line x1="84" x2="168" y1="${108 + k * 15}" y2="${108 + k * 15}"/>`)}${lines(5, (k) => `<line x1="${98 + k * 14}" x2="${98 + k * 14}" y1="96" y2="246"/>`)}</g>
<rect x="312" y="118" width="88" height="128" fill="url(#gl3)"/><g fill="#fff" opacity=".4"><rect x="326" y="145" width="14" height="15"/><rect x="354" y="175" width="14" height="15"/><rect x="368" y="130" width="14" height="15"/><rect x="340" y="205" width="14" height="15"/></g><g stroke="#fff" stroke-opacity=".22">${lines(8, (k) => `<line x1="312" x2="400" y1="${130 + k * 15}" y2="${130 + k * 15}"/>`)}${lines(5, (k) => `<line x1="${326 + k * 14}" x2="${326 + k * 14}" y1="118" y2="246"/>`)}</g>
<rect x="160" y="34" width="160" height="206" fill="url(#gl)"/>
<g clip-path="url(#ct)">
<g stroke="#12005A" stroke-opacity=".18">${lines(8, (k) => `<line x1="${180 + k * 20}" x2="${180 + k * 20}" y1="34" y2="240"/>`)}</g>
<g stroke="#fff" stroke-opacity=".45">${lines(13, (k) => `<line x1="160" x2="320" y1="${50 + k * 15}" y2="${50 + k * 15}"/>`)}</g>
<g fill="#fff" opacity=".55">${[[180,50],[260,50],[200,80],[300,80],[160,110],[240,110],[280,125],[180,155],[220,170],[300,170],[260,200],[160,215],[240,215]].map(([x, y]) => `<rect x="${x}" y="${y}" width="20" height="15"/>`).join('')}</g>
<g fill="#02C988" opacity=".32"><rect x="180" y="95" width="40" height="15"/><rect x="240" y="140" width="60" height="15"/><rect x="200" y="185" width="20" height="15"/><rect x="280" y="65" width="20" height="15"/></g>
<polygon points="160,120 240,34 290,34 160,176" fill="#fff" opacity=".22"/><polygon points="160,196 320,60 320,84 160,224" fill="#fff" opacity=".12"/>
</g>
<rect x="156" y="26" width="168" height="10" fill="#12005A"/><rect x="156" y="35" width="168" height="2" fill="#02C988"/>
<rect x="232" y="12" width="16" height="16" fill="#12005A"/><circle cx="240" cy="10" r="2.4" fill="#02C988"/>
<rect x="40" y="236" width="400" height="56" fill="#f6f4fd"/><rect x="40" y="236" width="400" height="4" fill="#d9d3f2"/>
<rect x="56" y="248" width="120" height="30" rx="2" fill="url(#lobby)" opacity=".9"/><rect x="304" y="248" width="120" height="30" rx="2" fill="url(#lobby)" opacity=".9"/>
<g stroke="#f6f4fd" stroke-width="3">${lines(5, (k) => `<line x1="${80 + k * 24}" x2="${80 + k * 24}" y1="248" y2="278"/><line x1="${328 + k * 24}" x2="${328 + k * 24}" y1="248" y2="278"/>`)}</g>
<rect x="206" y="252" width="68" height="40" fill="url(#lobby)"/><rect x="238" y="252" width="4" height="40" fill="#f6f4fd"/>
<path d="M188 240h104l8 12H180z" fill="#12005A"/><rect x="180" y="251" width="120" height="2" fill="#02C988"/>
<g fill="#02C988"><rect x="191" y="253" width="2" height="39" opacity=".0"/></g>
<ellipse cx="240" cy="270" rx="90" ry="34" fill="url(#glow)" opacity=".55"/>
<g>${[120, 360].map((x) => `<rect x="${x - 1.5}" y="250" width="3" height="42" fill="#12005A"/><rect x="${x - 6}" y="244" width="12" height="7" rx="2" fill="#12005A"/><circle cx="${x}" cy="252" r="12" fill="url(#glow)"/><rect x="${x - 4}" y="250" width="8" height="2" fill="#b8f5df"/>`).join('')}</g>
<g><rect x="186" y="276" width="12" height="16" fill="#cfc8f1"/><circle cx="192" cy="270" r="9" fill="#02C988"/><rect x="282" y="276" width="12" height="16" fill="#cfc8f1"/><circle cx="288" cy="270" r="9" fill="#02C988"/></g>
<g fill="#02C988"><circle cx="20" cy="274" r="16"/><circle cx="4" cy="282" r="12"/><circle cx="460" cy="274" r="16"/><circle cx="476" cy="282" r="12"/></g>
<rect x="-160" y="292" width="800" height="8" fill="url(#pl)"/>
</svg>`);
  const roomArt = enc(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 300" preserveAspectRatio="xMidYMid slice">
<defs><linearGradient id="w" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6f4fd"/><stop offset="1" stop-color="#ece8f9"/></linearGradient>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d4f7ea"/><stop offset="1" stop-color="#f1fcf7"/></linearGradient></defs>
<rect width="480" height="300" fill="url(#w)"/><rect y="232" width="480" height="68" fill="#e1dcf4"/><rect y="232" width="480" height="4" fill="#d3cced"/>
<rect x="44" y="52" width="104" height="112" rx="8" fill="#cdc5ec"/><rect x="52" y="60" width="88" height="96" rx="4" fill="url(#sky)"/><circle cx="116" cy="88" r="10" fill="#02C988" opacity=".55"/><rect x="94" y="60" width="4" height="96" fill="#cdc5ec"/><rect x="52" y="106" width="88" height="4" fill="#cdc5ec"/>
<rect x="210" y="48" width="140" height="64" rx="6" fill="#fff" stroke="#d9d3f2" stroke-width="4"/><path d="M222 100l28-28 22 20 16-12 34 20z" fill="#02C988" opacity=".55"/><circle cx="326" cy="68" r="7" fill="#12005A" opacity=".25"/>
<rect x="190" y="122" width="210" height="88" rx="16" fill="#12005A"/><rect x="200" y="132" width="190" height="20" rx="8" fill="#2d1888"/>
<rect x="216" y="160" width="72" height="34" rx="12" fill="#fff"/><rect x="302" y="160" width="72" height="34" rx="12" fill="#fff"/>
<rect x="176" y="186" width="238" height="38" rx="10" fill="#fff"/><rect x="176" y="198" width="238" height="40" rx="10" fill="#02C988"/><rect x="176" y="198" width="238" height="9" rx="4" fill="#25d79c"/>
<rect x="186" y="236" width="10" height="16" rx="3" fill="#12005A"/><rect x="394" y="236" width="10" height="16" rx="3" fill="#12005A"/>
<rect x="74" y="196" width="76" height="52" rx="8" fill="#12005A"/><rect x="82" y="214" width="60" height="4" rx="2" fill="#2d1888"/><circle cx="112" cy="232" r="3" fill="#02C988"/>
<rect x="108" y="158" width="6" height="38" fill="#7a6fb4"/><path d="M90 160h42l-8-30h-26z" fill="#02C988"/><ellipse cx="111" cy="196" rx="14" ry="4" fill="#2d1888"/>
<rect x="430" y="150" width="14" height="82" rx="7" fill="#cdc5ec"/><circle cx="437" cy="140" r="22" fill="#02C988" opacity=".8"/><circle cx="426" cy="124" r="14" fill="#25d79c"/></svg>`);
  // image with fallback art; `kind` = 'gh' | 'room'
  const art = {gh: ghArt, room: roomArt};
  // branded confirmation dialog: await ZUI.confirm({title, message, items, ok, tone: 'primary' | 'danger' | 'warn'})
  const ICON = {primary: 'M9 12l2 2 4-4M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', danger: 'M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', warn: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'};
  function confirm(o) { return new Promise((res) => {
    const tone = o.tone || 'primary', prev = document.activeElement;
    const ov = el('div', 'zc-ov'); ov.setAttribute('role', 'alertdialog'); ov.setAttribute('aria-modal', 'true');
    const card = el('div', 'zc-card'), body = el('div', 'zc-body'), ic = el('div', 'zc-ic ' + tone); ic.appendChild(svgIcon('', o.icon || ICON[tone])); ic.firstChild.setAttribute('stroke-width', '2');
    const tx = el('div'); const t = el('p', 'zc-t', o.title || 'Are you sure?'); t.id = 'zc-t' + Date.now(); ov.setAttribute('aria-labelledby', t.id); tx.appendChild(t);
    [].concat(o.message || []).forEach((m) => tx.appendChild(el('p', 'zc-m', m)));
    if (o.items && o.items.length) { const ul = el('ul', 'zc-list'); o.items.forEach((m) => ul.appendChild(el('li', null, '⚠ ' + m))); tx.appendChild(ul); }
    body.append(ic, tx); const foot = el('div', 'zc-foot');
    const no = el('button', 'zc-b zc-cancel', o.cancel || 'Cancel'), yes = el('button', 'zc-b zc-ok ' + tone, o.ok || 'Confirm'); no.type = yes.type = 'button'; foot.append(no, yes);
    card.append(body, foot); ov.appendChild(card); document.body.appendChild(ov);
    const done = (v) => { document.removeEventListener('keydown', kd, true); ov.remove(); if (prev && prev.focus) prev.focus(); res(v); };
    const kd = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); } else if (e.key === 'Tab') { e.preventDefault(); (document.activeElement === yes ? no : yes).focus(); } };
    document.addEventListener('keydown', kd, true); no.onclick = () => done(false); yes.onclick = () => done(true); ov.onmousedown = (e) => { if (e.target === ov) done(false); };
    (tone === 'danger' ? no : yes).focus(); }); }
  // pointer hints: a hand on anything clickable that isn't a real button or link (and make it keyboard-usable)
  const NATIVE = /^(A|BUTTON|INPUT|SELECT|TEXTAREA|LABEL|SUMMARY|OPTION)$/;
  const mark = (n) => { if (n.nodeType !== 1 || n._zc || typeof n.onclick !== 'function' || NATIVE.test(n.tagName)) return;
    if (n.classList.contains('fixed') || n.getAttribute('role') === 'option' || n.closest('.zd-panel, .zc-ov')) return;
    n._zc = 1; n.classList.add('z-click');
    if (!n.hasAttribute('tabindex')) { n.tabIndex = 0; if (!/^(TR|TD|LI)$/.test(n.tagName)) n.setAttribute('role', 'button');
      n.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === n) { e.preventDefault(); n.click(); } }); } };
  const scan = (n) => { if (n.nodeType !== 1) return; mark(n); n.querySelectorAll('*').forEach(mark); };
  function clickables(root) { scan(root); new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach(scan))).observe(root, {childList: true, subtree: true}); }
  // busy pointer while something is saving / loading
  let busyN = 0; const busy = async (p) => { busyN++; document.documentElement.classList.add('z-busy'); try { return await p; } finally { if (--busyN <= 0) { busyN = 0; document.documentElement.classList.remove('z-busy'); } } };
  // optional dark theme, remembered per browser
  const theme = {get: () => document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    set: (t) => { document.documentElement.classList.toggle('dark', t === 'dark'); try { localStorage.setItem('zp.theme', t); } catch (e) {} document.dispatchEvent(new CustomEvent('zthemechange', {detail: t})); } };
  return {show, close, key, isOpen, select, auto, noFill, chevron, art, confirm, clickables, busy, theme};
})();
