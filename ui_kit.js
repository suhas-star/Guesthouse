/* Zuna UI kit: branded dropdowns (for every <select> and type-ahead field) and default artwork. */
const ZUI = (() => {
  const st = document.createElement('style');
  st.textContent = `
.zd-hide{position:absolute!important;width:1px!important;height:1px!important;opacity:0!important;pointer-events:none!important;overflow:hidden}
.zd-btn{display:flex;align-items:center;gap:.5rem;text-align:left;cursor:pointer}
.zd-btn:disabled{cursor:not-allowed;opacity:.6}
.zd-val{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zd-ph{color:#9a94bd;font-weight:400}
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
.zd-hl{font-weight:700;color:#019b69;background:none}
.zd-ck{width:16px;height:16px;color:#02C988;opacity:0;flex-shrink:0}
.zd-ph-opt{color:#9a94bd}
.zd-group{padding:.55rem .65rem .25rem;font-size:.6875rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#9a94bd}
.zd-empty{padding:.75rem;font-size:.8125rem;color:#7a74a3;text-align:center}
.zd-spin{display:inline-block;width:12px;height:12px;margin-right:6px;vertical-align:-2px;border-radius:50%;border:2px solid #cdc5ec;border-top-color:#02C988;animation:zdSpin .7s linear infinite}
@keyframes zdSpin{to{transform:rotate(360deg)}}
.zd-cwrap{position:relative}.zd-cwrap>input{padding-right:2.25rem}
.zd-cwrap>.zd-chev{position:absolute;right:.75rem;top:50%;margin-top:-8px;cursor:pointer}
@media (prefers-reduced-motion:reduce){.zd-panel{animation:none}}`;
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
      const o = el('div', 'zd-opt' + (it.muted ? ' zd-ph-opt' : '')); o.setAttribute('role', 'option'); o.dataset.k = k; o.setAttribute('aria-selected', it.selected ? 'true' : 'false');
      const tx = el('div', 'zd-tx'); tx.appendChild(hl(String(it.label), c.q)); if (it.sub) tx.appendChild(el('div', 'zd-sub', it.sub)); o.appendChild(tx); o.appendChild(svgIcon('zd-ck', 'M20 6 9 17l-5-5'));
      o.onmousemove = () => { if (c.act !== k) setAct(c, k); }; o.onclick = () => pick(c, it); c.panel.appendChild(o); });
    if (c.act >= 0) setAct(c, c.act); };
  const pick = (c, it) => { const f = c.onPick; close(); f(it); };
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
    const items = () => [...s.options].map((o, k) => ({value: o.value, label: o.textContent, selected: k === IDX.get.call(s), muted: o.value === '' && !!o.dataset.placeholder, group: o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label : ''}));
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
  const ghArt = enc(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="-160 0 800 300" preserveAspectRatio="xMidYMid slice">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2d1888"/><stop offset="1" stop-color="#12005A"/></linearGradient>
<radialGradient id="g" cx=".74" cy=".24" r=".55"><stop offset="0" stop-color="#02C988" stop-opacity=".38"/><stop offset="1" stop-color="#02C988" stop-opacity="0"/></radialGradient>
<linearGradient id="b" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#eeeaf9"/></linearGradient></defs>
<rect x="-160" width="800" height="300" fill="url(#s)"/><rect x="-160" width="800" height="300" fill="url(#g)"/>
<g fill="#fff" opacity=".45"><circle cx="-120" cy="40" r="1.2"/><circle cx="-60" cy="70" r="1"/><circle cx="520" cy="50" r="1.3"/><circle cx="600" cy="30" r="1"/></g>
<g fill="#33208f"><rect x="-156" y="176" width="52" height="124" rx="3"/><rect x="-98" y="140" width="38" height="160" rx="3"/><rect x="-54" y="196" width="48" height="104" rx="3"/><rect x="488" y="160" width="46" height="140" rx="3"/><rect x="540" y="126" width="40" height="174" rx="3"/><rect x="586" y="186" width="52" height="114" rx="3"/></g>
<g fill="#4c38a6" opacity=".85">${win(-148, 188, 3, 5, 9, 7, 15, 20, [6])}${win(-90, 152, 2, 7, 10, 8, 16, 20, [9])}${win(496, 172, 2, 6, 10, 8, 18, 20, [2])}${win(548, 138, 2, 8, 10, 8, 16, 20, [5, 11])}</g>
<g fill="#02C988"><circle cx="-30" cy="270" r="18"/><circle cx="520" cy="272" r="18"/></g>
<g fill="#fff" opacity=".5"><circle cx="58" cy="44" r="1.4"/><circle cx="132" cy="28" r="1"/><circle cx="210" cy="52" r="1.2"/><circle cx="420" cy="36" r="1"/><circle cx="452" cy="88" r="1.3"/><circle cx="96" cy="96" r="1"/></g>
<circle cx="356" cy="72" r="20" fill="#02C988"/><circle cx="364" cy="66" r="20" fill="#2a1784" opacity=".55"/>
<g fill="#3a2696"><rect x="0" y="150" width="56" height="150" rx="3"/><rect x="62" y="118" width="40" height="182" rx="3"/><rect x="384" y="132" width="42" height="168" rx="3"/><rect x="432" y="104" width="48" height="196" rx="3"/></g>
<g fill="#4c38a6" opacity=".9">${win(8, 162, 3, 6, 10, 8, 16, 20, [4, 9])}${win(70, 130, 2, 8, 10, 8, 16, 20, [3])}${win(392, 144, 2, 7, 10, 8, 16, 20, [8])}${win(440, 116, 2, 9, 12, 8, 18, 20, [1, 12])}</g>
<rect x="112" y="186" width="44" height="114" rx="3" fill="#e2ddf5"/><rect x="324" y="176" width="44" height="124" rx="3" fill="#e2ddf5"/>
${win(120, 198, 2, 4, 10, 10, 18, 24, [5])}${win(332, 188, 2, 4, 10, 10, 18, 24, [2])}
<rect x="156" y="84" width="168" height="216" rx="6" fill="url(#b)"/><rect x="148" y="74" width="184" height="16" rx="5" fill="#cdc5ec"/>
<rect x="216" y="56" width="48" height="22" rx="4" fill="#12005A"/><rect x="226" y="62" width="28" height="10" rx="2" fill="#02C988"/>
${win(174, 104, 4, 5, 22, 18, 36, 30, [2, 5, 11, 14, 16])}
<rect x="214" y="250" width="52" height="50" rx="6" fill="#12005A"/><rect x="238" y="250" width="4" height="50" fill="#2d1888"/><rect x="204" y="242" width="72" height="10" rx="5" fill="#02C988"/>
<g fill="#02C988"><circle cx="96" cy="262" r="22"/><circle cx="76" cy="276" r="16"/><circle cx="392" cy="260" r="24"/><circle cx="414" cy="278" r="16"/></g>
<g fill="#019b69"><circle cx="104" cy="270" r="12"/><circle cx="384" cy="270" r="13"/></g>
<rect x="-160" y="292" width="800" height="8" fill="#0b003a"/></svg>`);
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
  return {show, close, key, isOpen, select, auto, noFill, chevron, art};
})();
