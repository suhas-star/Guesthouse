(function(){
  const RED = [0.008, 0.788, 0.533], INK = [0.071, 0, 0.353];
  const ascii = (t) => String(t == null ? '' : t).replace(/[–—]/g, '-').replace(/[·•]/g, '-').replace(/▲/g, '!').replace(/[^\x20-\x7e]/g, '');
  const u8 = (s) => new TextEncoder().encode(s);
  const xmlEsc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const stamp = () => REPORT_DATE;
  const slug = (t) => String(t).replace(/[^A-Za-z0-9]+/g, '');

  // --- tiny ZIP (stored) for xlsx ---
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const zip = (files) => {
    const parts = [], central = []; let off = 0;
    files.forEach((f) => {
      const name = u8(f.name), data = typeof f.data === 'string' ? u8(f.data) : f.data, crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, 0, true); h.setUint16(12, 33, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true);
      h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), name, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint16(10, 0, true); c.setUint16(12, 0, true); c.setUint16(14, 33, true); c.setUint32(16, crc, true);
      c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true);
      c.setUint32(42, off, true);
      central.push(new Uint8Array(c.buffer), name);
      off += 30 + name.length + data.length;
    });
    const cdSize = central.reduce((s, p) => s + p.length, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
    return new Blob([...parts, ...central, new Uint8Array(e.buffer)]);
  };

  // styles: 0 normal,1 header,2 title,3 cell,4 full(red),5 partial,6 upcoming,7 completed,8 declined,9 subtitle,10 cell bold
  const XLSX_STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<fonts count="6"><font><sz val="10"/><color rgb="FF12005A"/><name val="Segoe UI"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Segoe UI"/></font><font><b/><sz val="14"/><color rgb="FF12005A"/><name val="Segoe UI"/></font><font><sz val="10"/><color rgb="FF12005A"/><name val="Segoe UI"/></font><font><sz val="9"/><color rgb="FF666666"/><name val="Segoe UI"/></font><font><b/><sz val="10"/><color rgb="FF12005A"/><name val="Segoe UI"/></font></fonts>'
    + '<fills count="8"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FF12005A"/></patternFill></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FF02C988"/></patternFill></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFE3F9F1"/></patternFill></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFE3F4E6"/></patternFill></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFEFEFEF"/></patternFill></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFFDE2E1"/></patternFill></fill></fills>'
    + '<borders count="2"><border/><border><left style="thin"><color rgb="FFD9D9D9"/></left><right style="thin"><color rgb="FFD9D9D9"/></right><top style="thin"><color rgb="FFD9D9D9"/></top><bottom style="thin"><color rgb="FFD9D9D9"/></bottom></border></borders>'
    + '<cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="11">'
    + '<xf/>'
    + '<xf fontId="1" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1"><alignment vertical="center"/></xf>'
    + '<xf fontId="2" applyFont="1"/>'
    + '<xf borderId="1" applyBorder="1"><alignment vertical="top" wrapText="1"/></xf>'
    + '<xf fontId="3" fillId="3" borderId="1" applyFont="1" applyFill="1" applyBorder="1"><alignment vertical="top" wrapText="1"/></xf>'
    + '<xf fillId="4" borderId="1" applyFill="1" applyBorder="1"><alignment vertical="top" wrapText="1"/></xf>'
    + '<xf fillId="5" borderId="1" applyFill="1" applyBorder="1"><alignment vertical="top" wrapText="1"/></xf>'
    + '<xf fillId="6" borderId="1" applyFill="1" applyBorder="1"><alignment vertical="top" wrapText="1"/></xf>'
    + '<xf fillId="7" borderId="1" applyFill="1" applyBorder="1"><alignment vertical="top" wrapText="1"/></xf>'
    + '<xf fontId="4" applyFont="1"/>'
    + '<xf fontId="5" borderId="1" applyFont="1" applyBorder="1"/>'
    + '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

  const colName = (i) => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
  const xlsx = ({sheet, title, subtitle, legend, cols, rows}) => {
    // rows: [{cells:[...], style}] ; cols: [{label, width, num}]
    let r = 0; const out = [];
    const row = (cells) => { r++; out.push('<row r="' + r + '">' + cells.map((c, i) => {
      const ref = colName(i) + r, s = c.s ? ' s="' + c.s + '"' : '';
      return typeof c.v === 'number' ? '<c r="' + ref + '"' + s + '><v>' + c.v + '</v></c>'
        : '<c r="' + ref + '"' + s + ' t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(c.v) + '</t></is></c>';
    }).join('') + '</row>'); };
    row([{v: title, s: 2}]);
    row([{v: subtitle, s: 9}]);
    row(legend.map((l) => ({v: l[0], s: l[1]})));
    row([]);
    row(cols.map((c) => ({v: c.label, s: 1})));
    const headRow = r;
    rows.forEach((x) => row(x.cells.map((v, i) => ({v, s: (x.styles && x.styles[i]) || x.style}))));
    const last = colName(cols.length - 1);
    const sheetXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="' + headRow + '" topLeftCell="A' + (headRow + 1) + '" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
      + '<cols>' + cols.map((c, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + c.width + '" customWidth="1"/>').join('') + '</cols>'
      + '<sheetData>' + out.join('') + '</sheetData>'
      + '<autoFilter ref="A' + headRow + ':' + last + r + '"/>'
      + '<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>';
    const sname = xmlEsc(sheet.slice(0, 31));
    return zip([
      {name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'},
      {name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'},
      {name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="' + sname + '" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">\'' + sname + '\'!$A$' + headRow + ':$' + last + '$' + r + '</definedName></definedNames></workbook>'},
      {name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'},
      {name: 'xl/styles.xml', data: XLSX_STYLES},
      {name: 'xl/worksheets/sheet1.xml', data: sheetXml}
    ]);
  };

  // --- tiny PDF writer ---
  const logoJpeg = (img, bg) => {
    try {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext('2d'); g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0);
      const b64 = c.toDataURL('image/jpeg', 0.95).split(',')[1], bin = atob(b64), a = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
      return {w: c.width, h: c.height, data: a};
    } catch (e) { return null; }
  };
  const pdfStr = (t) => '(' + ascii(t).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)') + ')';
  const rgb = (c) => c.map((v) => v.toFixed(3)).join(' ');
  const textW = (t, size) => ascii(t).length * size * 0.5;
  const wrap = (t, width, size) => {
    const words = ascii(t).split(/\s+/).filter(Boolean), lines = []; let cur = '';
    words.forEach((w) => { const n = cur ? cur + ' ' + w : w; if (textW(n, size) > width && cur) { lines.push(cur); cur = w; } else cur = n; });
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  };
  const pdf = ({title, subtitle, legend, cols, rows}) => {
    const W = 842, H = 595, M = 32, FS = 8.5, LH = 11;
    const imgs = [];
    document.querySelectorAll('[data-logo]').forEach((im, i) => { const j = logoJpeg(im, '#ffffff'); if (j) imgs.push(j); });
    const pages = []; let ops = null, y = 0;
    const T = (x, yy, t, size, bold, color) => ops.push('BT /' + (bold ? 'F2' : 'F1') + ' ' + size + ' Tf ' + rgb(color) + ' rg ' + x.toFixed(1) + ' ' + yy.toFixed(1) + ' Td ' + pdfStr(t) + ' Tj ET');
    const R = (x, yy, w, h, color) => ops.push(rgb(color) + ' rg ' + x.toFixed(1) + ' ' + yy.toFixed(1) + ' ' + w.toFixed(1) + ' ' + h.toFixed(1) + ' re f');
    const L = (x1, y1, x2, y2, color, w) => ops.push(rgb(color) + ' RG ' + w + ' w ' + x1 + ' ' + y1.toFixed(1) + ' m ' + x2 + ' ' + y2.toFixed(1) + ' l S');
    const header = () => {
      R(0, H - 64, W, 64, INK); R(0, H - 3, W, 3, RED);
      T(M, H - 30, title, 15, true, [1, 1, 1]);
      T(M, H - 47, subtitle, 8.5, false, [0.68, 0.68, 0.68]);
      let x = W - M;
      imgs.slice().reverse().forEach((im, k) => {
        const h = 22, w = im.w * h / im.h; x -= w;
        R(x - 6, H - 47, w + 12, h + 8, [1, 1, 1]);
        ops.push('q ' + w.toFixed(1) + ' 0 0 ' + h + ' ' + x.toFixed(1) + ' ' + (H - 43) + ' cm /Im' + (imgs.length - 1 - k) + ' Do Q');
        x -= 18;
      });
      y = H - 82;
      let lx = M;
      legend.forEach(([label, fill, stroke]) => {
        R(lx, y - 1, 9, 9, fill); if (stroke) { ops.push('0.75 0.75 0.75 RG 0.5 w ' + lx + ' ' + (y - 1) + ' 9 9 re S'); }
        T(lx + 13, y, label, 8, false, [0.3, 0.3, 0.3]); lx += 13 + textW(label, 8) + 18;
      });
      y -= 14;
      let cx = M; R(M, y - 18, W - 2 * M, 18, INK);
      cols.forEach((c) => { T(c.num ? cx + c.width - 5 - textW(c.label, 8) : cx + 5, y - 12, c.label, 8, true, [1, 1, 1]); cx += c.width; });
      y -= 18;
    };
    const newPage = () => { ops = []; pages.push(ops); header(); };
    newPage();
    rows.forEach((r) => {
      const cellLines = r.cells.map((v, i) => wrap(v, cols[i].width - 10, FS));
      const n = Math.max(...cellLines.map((l) => l.length));
      const h = n * LH + 7;
      if (y - h < M + 20) newPage();
      if (r.fill) R(M, y - h, W - 2 * M, h, r.fill);
      let cx = M;
      cellLines.forEach((lines, i) => {
        const bold = r.bold && r.bold.includes(i);
        lines.forEach((ln, k) => {
          const tx = cols[i].num ? cx + cols[i].width - 5 - textW(ln, FS) : cx + 5;
          T(tx, y - 11 - k * LH, ln, FS, bold, r.color || [0.071, 0, 0.353]);
        });
        cx += cols[i].width;
      });
      L(M, y - h, W - M, y - h, [0.85, 0.85, 0.85], 0.5);
      y -= h;
    });
    const N = pages.length;
    pages.forEach((p, i) => { ops = p; T(M, 18, 'Confidential', 7.5, false, [0.5, 0.5, 0.5]); T(W - M - 50, 18, 'Page ' + (i + 1) + ' of ' + N, 7.5, false, [0.5, 0.5, 0.5]); });
    // assemble
    const chunks = [], offsets = []; let len = 0;
    const put = (x) => { const b = typeof x === 'string' ? u8(x) : x; chunks.push(b); len += b.length; };
    const obj = (n, body) => { offsets[n] = len; put(n + ' 0 obj\n'); body.forEach(put); put('\nendobj\n'); };
    put('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'.replace(/[\x80-\xff]/g, 'x'));
    const fontObj = 3, imgBase = 5, pageBase = imgBase + imgs.length;
    const kids = pages.map((_, i) => (pageBase + i * 2) + ' 0 R').join(' ');
    obj(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
    obj(2, ['<< /Type /Pages /Kids [' + kids + '] /Count ' + N + ' >>']);
    obj(3, ['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>']);
    obj(4, ['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>']);
    imgs.forEach((im, i) => obj(imgBase + i, ['<< /Type /XObject /Subtype /Image /Width ' + im.w + ' /Height ' + im.h + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + im.data.length + ' >>\nstream\n', im.data, '\nendstream']));
    const xo = imgs.map((_, i) => '/Im' + i + ' ' + (imgBase + i) + ' 0 R').join(' ');
    pages.forEach((p, i) => {
      const pn = pageBase + i * 2, cn = pn + 1, stream = p.join('\n');
      obj(pn, ['<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + W + ' ' + H + '] /Resources << /Font << /F1 ' + fontObj + ' 0 R /F2 4 0 R >> /XObject << ' + xo + ' >> >> /Contents ' + cn + ' 0 R >>']);
      obj(cn, ['<< /Length ' + u8(stream).length + ' >>\nstream\n', stream, '\nendstream']);
    });
    const total = pageBase + N * 2, xref = len;
    let x = 'xref\n0 ' + total + '\n0000000000 65535 f \n';
    for (let i = 1; i < total; i++) x += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    put(x + 'trailer\n<< /Size ' + total + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF');
    return new Blob(chunks);
  };


  const L = window.__ltm;
  const periodText = () => L.fShort(L.period.from) + ' - ' + L.fLong(L.period.to);
  const nightlyReport = () => {
    const p = L.P(), list = L.nightsAll();
    const rows = list.map((d) => {
      const full = d.total && d.booked >= d.total, part = d.booked && !full;
      return {cells: [L.fDay(d.night), d.total, d.booked, d.vacant, Math.round(d.occ * 100) + '%', d.guests.map((g) => g.guest + ' (' + g.grade + ')').join(', ') || '-', d.declined.map((g) => g.guest).join(', ')],
        xstyle: full ? 4 : part ? 5 : 3, fill: full ? RED : part ? [0.890, 0.976, 0.945] : null, color: full ? [0.071, 0, 0.353] : null};
    });
    return {p, rows, title: 'Night-wise Availability - ' + p.property,
      subtitle: p.property + ', ' + p.city + '  |  ' + p.rooms + ' rooms  |  ' + periodText() + '  |  Updated ' + L.fLong(stamp()),
      cols: [{label: 'Night', width: 90, x: 16}, {label: 'Inventory', width: 60, num: 1, x: 11}, {label: 'Occupied', width: 60, num: 1, x: 11}, {label: 'Vacant', width: 55, num: 1, x: 10}, {label: 'Occupancy', width: 65, num: 1, x: 12}, {label: 'Guests in house (grade)', width: 300, x: 60}, {label: 'Declined by property', width: 148, x: 30}],
      legendPdf: [['Fully occupied', RED], ['Partly occupied', [0.890, 0.976, 0.945]], ['All rooms vacant', [1, 1, 1], true]],
      legendX: [['Fully occupied', 4], ['Partly occupied', 5], ['All rooms vacant', 3]]};
  };
  const registerReport = () => {
    const p = L.P();
    const order = {'In house': 0, Upcoming: 1, Completed: 2, 'Not accommodated': 3};
    const list = L.myB().filter(L.inRange).sort((a, b) => order[L.stateOf(a)] - order[L.stateOf(b)] || a.check_in.localeCompare(b.check_in));
    const rows = list.map((d) => {
      const l = L.stateOf(d);
      const warn = d._clash && d._clash.length ? 'MIXED GENDER sharing with ' + d._clash.map((o) => o.guest).join(', ') + ' - not allowed' : '';
      return {cells: [d.guest, d.grade, d._g || '', (d._occ || '') + (d._mates && d._mates.length ? ' (with ' + d._mates.map((o) => o.guest).join(', ') + ')' : ''), d.base, L.fShort(d.check_in), L.fShort(d.check_out), Number(d.nights) || d.nights, d.room, l, d.concur_tr, [warn, d.note || ''].filter(Boolean).join('. ')],
        xstyle: l === 'Upcoming' || l === 'In house' ? 6 : l === 'Completed' ? 7 : 8,
        fill: l === 'Upcoming' || l === 'In house' ? [0.890, 0.957, 0.902] : l === 'Completed' ? [0.937, 0.937, 0.937] : [0.992, 0.886, 0.882], bold: [0, 9]};
    });
    return {p, rows, title: 'Booking Register - ' + p.property,
      subtitle: p.property + ', ' + p.city + '  |  ' + L.rangeText() + '  |  Updated ' + L.fLong(stamp()),
      cols: [{label: 'Guest', width: 125, x: 30}, {label: 'Grade', width: 38, x: 8}, {label: 'Gender', width: 48, x: 9}, {label: 'Occupancy', width: 80, x: 30}, {label: 'Base location', width: 62, x: 14}, {label: 'Check-in', width: 52, x: 12}, {label: 'Check-out', width: 54, x: 12}, {label: 'Nights', width: 38, num: 1, x: 8}, {label: 'Room', width: 58, x: 14}, {label: 'Status', width: 82, x: 18}, {label: 'Concur TR', width: 50, x: 11}, {label: 'Remarks', width: 91, x: 50}],
      legendPdf: [['Upcoming / in house', [0.890, 0.957, 0.902]], ['Completed', [0.937, 0.937, 0.937]], ['Not accommodated', [0.992, 0.886, 0.882]]],
      legendX: [['Upcoming / in house', 6], ['Completed', 7], ['Not accommodated', 8]]};
  };
  const build = (kind, fmt) => {
    const rep = kind === 'nightly' ? nightlyReport() : registerReport();
    const base = 'LTM_' + slug(rep.p.property) + '_' + (kind === 'nightly' ? 'NightwiseAvailability' : 'BookingRegister') + '_' + stamp();
    if (fmt === 'pdf') return {filename: base + '.pdf', data: pdf({title: rep.title, subtitle: rep.subtitle, legend: rep.legendPdf, cols: rep.cols, rows: rep.rows.map((r) => ({...r, cells: r.cells.map(String)}))})};
    return {filename: base + '.xlsx', data: xlsx({sheet: kind === 'nightly' ? 'Night-wise availability' : 'Booking register', title: rep.title, subtitle: rep.subtitle,
      legend: rep.legendX, cols: rep.cols.map((c) => ({label: c.label, width: c.x})), rows: rep.rows.map((r) => ({cells: r.cells, style: r.xstyle}))})};
  };
  document.querySelectorAll('[data-dl]').forEach((btn) => btn.addEventListener('click', () => {
    const [kind, fmt] = btn.dataset.dl.split('-');
    try {
      const f = build(kind, fmt);
      const url = URL.createObjectURL(f.data), a = document.createElement('a');
      a.href = url; a.download = f.filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      L.toast('Downloading ' + f.filename);
    } catch (e) { console.error(e); L.toast('Could not create the file'); }
  }));

  // ---------- GH Report (LTM format) ----------
  // Layout follows LTM's sheet: title, one column per room bed, one row per night, bed and room occupancy blocks, totals, master guest details.
  const DMY = (d) => d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4);
  const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const WEEK_STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<numFmts count="1"><numFmt numFmtId="164" formatCode="0.00"/></numFmts>'
    + '<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="18"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font><font><b/><sz val="12"/><name val="Calibri"/></font></fonts>'
    + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders>'
    + '<cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="7">'
    + '<xf/>'                                                                                              // 0 normal
    + '<xf fontId="1" applyFont="1" applyAlignment="1"><alignment horizontal="center"/></xf>'                 // 1 title
    + '<xf fontId="2" applyFont="1" applyAlignment="1"><alignment horizontal="center"/></xf>'                 // 2 group header
    + '<xf fontId="3" applyFont="1" applyAlignment="1"><alignment horizontal="center" wrapText="1"/></xf>'    // 3 column header / total label
    + '<xf numFmtId="164" applyNumberFormat="1"/>'                                                         // 4 0.00
    + '<xf applyAlignment="1"><alignment horizontal="left"/></xf>'                                          // 5 left
    + '<xf numFmtId="1" applyNumberFormat="1"/>'                                                            // 6 whole number
    + '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  const sheetZip = (sheet, cells, merges, widths) => {
    const byRow = new Map(); cells.forEach((c) => { if (!byRow.has(c.r)) byRow.set(c.r, []); byRow.get(c.r).push(c); });
    const rowsXml = [...byRow.keys()].sort((a, b) => a - b).map((r) => '<row r="' + r + '">' + byRow.get(r).sort((a, b) => a.c - b.c).map((c) => {
      const ref = colName(c.c) + r, st = c.s ? ' s="' + c.s + '"' : '';
      return typeof c.v === 'number' ? '<c r="' + ref + '"' + st + '><v>' + c.v + '</v></c>' : '<c r="' + ref + '"' + st + ' t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(c.v) + '</t></is></c>';
    }).join('') + '</row>').join('');
    const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<sheetViews><sheetView workbookViewId="0"><pane xSplit="2" ySplit="3" topLeftCell="C4" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>'
      + '<cols>' + widths.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join('') + '</cols>'
      + '<sheetData>' + rowsXml + '</sheetData>'
      + (merges.length ? '<mergeCells count="' + merges.length + '">' + merges.map((m) => '<mergeCell ref="' + m + '"/>').join('') + '</mergeCells>' : '')
      + '<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>';
    const sname = xmlEsc(sheet.slice(0, 31));
    return zip([
      {name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'},
      {name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'},
      {name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="' + sname + '" sheetId="1" r:id="rId1"/></sheets></workbook>'},
      {name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'},
      {name: 'xl/styles.xml', data: WEEK_STYLES},
      {name: 'xl/worksheets/sheet1.xml', data: xml}]);
  };
  const weeklyReport = (from, to, p = L.P()) => {
    const {roomNames, grid, placed} = L.rackGrid(p);
    const nights = []; for (let n = from; n <= to; n = L.addDays(n, 1)) nights.push(n);
    const who = (ri, n) => (grid[ri] && grid[ri][n]) || [];
    // beds per room: one, or as many guests as ever shared that room in these nights
    const beds = roomNames.map((_, ri) => Math.max(1, ...nights.map((n) => who(ri, n).length)));
    const totalBeds = beds.reduce((a, b) => a + b, 0), D = nights.length;
    const client = L.client || {}, circle = client.legal_name || client.name || 'LTM Limited';
    const title = (client.name ? client.name + ' ' : '') + p.property + (p.city ? '-' + p.city : '') + ' - ' + (from === to ? DMY(from) : DMY(from) + ' to ' + DMY(to));
    const short = (r) => { const m = /-(\w+)$/.exec(r); return m ? m[1] : r; };
    const name = (b) => L.cleanName(b.guest) + (placed.has(b) ? ' *' : '');
    const cells = [], merges = [], put = (r, c, v, s) => cells.push({r, c, v, s});
    const C0 = 2, totalCol = C0 + totalBeds, bedOcc = totalCol + 3, roomOcc = bedOcc + 3, master = roomOcc + 5;
    put(1, C0, title, 1); merges.push(colName(C0) + '1:' + colName(totalCol + 1) + '1');
    put(3, 0, 'Stay for the night of', 3); put(3, 1, 'Day of the week', 3);
    let c = C0; roomNames.forEach((rn, ri) => { put(2, c, 'Room - ' + short(rn), 2); if (beds[ri] > 1) merges.push(colName(c) + '2:' + colName(c + beds[ri] - 1) + '2'); for (let k = 0; k < beds[ri]; k++) put(3, c + k, 'Bed-' + (k + 1), 3); c += beds[ri]; });
    put(3, totalCol, 'Total Occupancy', 3);
    put(2, bedOcc, 'Total Bed Occupancy', 2); merges.push(colName(bedOcc) + '2:' + colName(bedOcc + 2) + '2');
    put(2, roomOcc, 'Total Room Occupancy', 2); merges.push(colName(roomOcc) + '2:' + colName(roomOcc + 2) + '2');
    put(2, master, 'Master Guest Details', 2); merges.push(colName(master) + '2:' + colName(master + 3) + '2');
    ['Beds Occupied', 'Beds Vacant', 'Occupancy %'].forEach((t, k) => put(3, bedOcc + k, t, 3));
    ['Rooms Occupied', 'Rooms Vacant', 'Occupancy %'].forEach((t, k) => put(3, roomOcc + k, t, 3));
    ['Guest Name', 'Guest Circle Name', 'Band', 'Consolidated Room Nights'].forEach((t, k) => put(3, master + k, t, 3));
    const bedNights = new Array(totalBeds).fill(0); let sumBeds = 0, sumRooms = 0; const guests = new Map();
    nights.forEach((n, i) => { const r = 4 + i, d = new Date(n + 'T00:00:00Z');
      put(r, 0, DMY(n)); put(r, 1, WD[d.getUTCDay()]);
      let col = C0, bOcc = 0, rOcc = 0;
      roomNames.forEach((_, ri) => { const g = who(ri, n); if (g.length) rOcc++;
        for (let k = 0; k < beds[ri]; k++) { const b = g[k]; put(r, col + k, b ? name(b) : ''); if (b) { bOcc++; bedNights[col + k - C0]++;
          const key = L.cleanName(b.guest).toLowerCase(); const e = guests.get(key) || {name: L.cleanName(b.guest), band: b.grade && b.grade !== 'Not stated' ? b.grade : '', nights: 0}; e.nights++; guests.set(key, e); } }
        col += beds[ri]; });
      sumBeds += bOcc; sumRooms += rOcc;
      put(r, bedOcc, bOcc); put(r, bedOcc + 1, totalBeds - bOcc); put(r, bedOcc + 2, totalBeds ? Math.round(bOcc / totalBeds * 10000) / 100 : 0, 4);
      put(r, roomOcc, rOcc); put(r, roomOcc + 1, roomNames.length - rOcc); put(r, roomOcc + 2, roomNames.length ? Math.round(rOcc / roomNames.length * 10000) / 100 : 0, 4);
    });
    const tr = 4 + D;
    put(tr, 1, 'Actual occupancy', 3); put(tr + 1, 1, 'No. of days', 3); put(tr + 2, 1, '% occupancy', 3);
    bedNights.forEach((v, k) => { put(tr, C0 + k, v, 6); put(tr + 1, C0 + k, D, 6); put(tr + 2, C0 + k, D ? Math.round(v / D * 10000) / 100 : 0, 4); });
    const occAll = bedNights.reduce((a, b) => a + b, 0);
    put(tr, totalCol, occAll, 4); put(tr + 1, totalCol, totalBeds * D, 4); put(tr + 2, totalCol, totalBeds * D ? Math.round(occAll / (totalBeds * D) * 10000) / 100 : 0, 4);
    put(tr, bedOcc, sumBeds); put(tr, bedOcc + 1, totalBeds * D - sumBeds); put(tr, bedOcc + 2, totalBeds * D ? Math.round(sumBeds / (totalBeds * D) * 10000) / 100 : 0, 4);
    put(tr, roomOcc, sumRooms); put(tr, roomOcc + 1, roomNames.length * D - sumRooms); put(tr, roomOcc + 2, roomNames.length * D ? Math.round(sumRooms / (roomNames.length * D) * 10000) / 100 : 0, 4);
    [...guests.values()].sort((a, b) => a.name.localeCompare(b.name)).forEach((g, k) => { put(4 + k, master, g.name); put(4 + k, master + 1, circle); put(4 + k, master + 2, g.band); put(4 + k, master + 3, g.nights, 5); });
    if (placed.size && [...placed].some((b) => b.check_in <= to && b.check_out > from)) put(tr + 4, 0, '* Room not yet confirmed by the guest house; shown in the first free room.');
    const widths = []; for (let k = 0; k <= master + 3; k++) widths.push(k === 0 ? 21 : k === 1 ? 18 : (k >= C0 && k < totalCol) ? 20 : k === totalCol ? 16 : k === bedOcc || k === roomOcc ? 20 : k === master ? 20 : k === master + 1 ? 20 : k === master + 3 ? 25 : 13);
    const fileTitle = title.replace(/\//g, '_').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_+/g, '_');
    return {filename: fileTitle + '.xlsx', data: sheetZip('Sheet', cells, merges, widths)};
  };
  const dl = (f) => { const url = URL.createObjectURL(f.data), a = document.createElement('a'); a.href = url; a.download = f.filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000); L.toast('Downloading ' + f.filename); };
  L.weeklyReport = weeklyReport;
  // one guest house -> Excel; all guest houses -> zip folder of the individual Excel files
  const ghReport = async (from, to, which, kind) => {
    if (which !== '*') return weeklyReport(from, to, L.props.find((x) => x.property === which) || L.P());
    const files = []; for (const p of L.props.filter((x) => +x.rooms > 0)) { const r = weeklyReport(from, to, p); files.push({name: r.filename, data: new Uint8Array(await r.data.arrayBuffer())}); }
    const name = (L.ghReportName() + (kind && kind !== 'Custom dates' ? ' - ' + kind : '') + ' - ' + (from === to ? DMY(from) : DMY(from) + ' to ' + DMY(to))).replace(/\//g, '_').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_+/g, '_');
    return {filename: name + '.zip', data: zip(files)};
  };
  document.querySelectorAll('[data-weekly]').forEach((btn) => btn.addEventListener('click', () => L.openWeekly(async (from, to, which, kind) => { try { dl(await ghReport(from, to, which, kind)); } catch (e) { console.error(e); L.toast('Could not create the report'); } })));
})();