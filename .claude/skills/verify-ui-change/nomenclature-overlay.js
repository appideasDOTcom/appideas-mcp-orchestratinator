/*
 * Draw the nomenclature overlay onto the live floor, then report what it found.
 *
 * Every anchor is measured off the real element's own rect — nothing here knows
 * the floor's geometry constants, so a change to DESK_W or PLATE_Y moves the
 * label with the part instead of leaving it pointing at carpet.
 *
 * It throws on a part it cannot find. A label silently missing from a reference
 * image is worse than no image: the reader learns a name for nothing.
 */
(() => {
  const doc = document;

  /* ---------- dark, the way the page itself does it ----------
     Headless Chrome reports prefers-color-scheme: light, and the media query is
     the only switch this page has. Rather than approximate the dark palette, the
     product's own dark block is copied out of the loaded stylesheet and applied
     unconditionally — same declarations, same values, no second copy to drift.

     Read through the CSSOM rather than re-fetching styles.css: the shot script
     stubs window.fetch before this runs (so a poll cannot rebuild the room out
     from under a measured rect), and a fetch here would hang for ever behind
     that stub. The rules are already parsed and in the page; ask the page. */
  const darkRules = [];
  for (const sheet of doc.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }   // a cross-origin sheet, if one ever appears
    for (const rule of rules) {
      if (rule.type === CSSRule.MEDIA_RULE && /prefers-color-scheme:\s*dark/.test(rule.conditionText ?? '')) {
        for (const inner of rule.cssRules) darkRules.push(inner.cssText);
      }
    }
  }
  if (!darkRules.length) throw new Error('no prefers-color-scheme: dark rules — did the theme mechanism change?');
  const dark = doc.createElement('style');
  dark.textContent = darkRules.join('\n');
  doc.head.appendChild(dark);

  /* ---------- what to label ---------- */

  const D = (a) => `.desk[data-agent="${a}"]`;
  const APP = D('app-developer'), QA = D('qa-engineer'), DES = D('designer');

  const PARTS = [
    { n: 1,  name: 'cell',          code: '.desk',        sel: QA,                    kind: 'box', at: 'bl', color: '#4c8dff' },
    { n: 2,  name: 'bubble',        code: '.bubble',      sel: `${APP} .bubble`,      kind: 'box', at: 'tl', color: '#f2b134' },
    { n: 3,  name: 'person',        code: '.person',      sel: `${APP} .person`,      kind: 'dot', at: 'l',  color: '#46c46b' },
    { n: 4,  name: 'monitor',       code: '.monitor',     sel: `${APP} .monitor`,     kind: 'dot', at: 'r',  color: '#f2679b' },
    { n: 5,  name: 'desk',          code: 'svg.face',     sel: `${APP} svg.face`,     kind: 'box', at: 'bl', color: '#35c8d8' },
    { n: 6,  name: 'sign',          code: '.blind .card', sel: `${APP} .blind .card`, kind: 'dot', at: 'br',  color: '#f2803c' },
    { n: 7,  name: 'nameplate',     code: '.plate',       sel: `${QA} .plate`,        kind: 'box', at: 'br', color: '#b98cf5' },
    { n: 8,  name: 'tray',          code: '.pill',        sel: `${QA} .pill`,         kind: 'all', at: 'b',  color: '#4fd6a8' },
    { n: 9,  name: 'badge',         code: '.needs',       sel: `${DES} .needs`,       kind: 'dot', at: 'tr', color: '#ef5350' },
    { n: 10, name: 'bell',          code: '.bell',        sel: `${QA} .bell`,         kind: 'dot', at: 'l',  color: '#ffd166' },
    { n: 11, name: 'thought trail', code: '.thought',     sel: `${APP} .thought`,     kind: 'dot', at: 'l',  color: '#8fb8ff' },
    { n: 12, name: 'room',          code: 'svg.room',     sel: 'svg.room',            kind: 'faint', at: 'tl', color: '#c0c8d2' },
  ];

  const sx = window.scrollX, sy = window.scrollY;
  const pageRect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + sx, y: r.top + sy, w: r.width, h: r.height, r: r.right + sx, b: r.bottom + sy };
  };
  const union = (list) => {
    const x = Math.min(...list.map((r) => r.x)), y = Math.min(...list.map((r) => r.y));
    const r = Math.max(...list.map((q) => q.r)), b = Math.max(...list.map((q) => q.b));
    return { x, y, w: r - x, h: b - y, r, b };
  };

  const layer = doc.createElement('div');
  layer.id = 'nomen-layer';
  Object.assign(layer.style, {
    position: 'absolute', left: '0', top: '0',
    width: `${doc.documentElement.scrollWidth}px`, height: `${doc.documentElement.scrollHeight}px`,
    pointerEvents: 'none', zIndex: '9999',
  });
  doc.body.appendChild(layer);

  const add = (styles, text = '') => {
    const d = doc.createElement('div');
    Object.assign(d.style, { position: 'absolute', boxSizing: 'border-box' }, styles);
    if (text) d.textContent = text;
    layer.appendChild(d);
    return d;
  };

  const found = [];
  for (const p of PARTS) {
    const els = [...doc.querySelectorAll(p.sel)];
    if (!els.length) throw new Error(`part ${p.n} (${p.name}) matched nothing: ${p.sel}`);
    const rect = p.kind === 'all' ? union(els.map(pageRect)) : pageRect(els[0]);
    if (!rect.w || !rect.h) throw new Error(`part ${p.n} (${p.name}) has no size — is it display:none?`);

    // The outline. `faint` is the room: a box that big has to stay out of the
    // way of everything drawn inside it.
    const pad = p.kind === 'faint' ? 6 : 4;
    add({
      left: `${rect.x - pad}px`, top: `${rect.y - pad}px`,
      width: `${rect.w + pad * 2}px`, height: `${rect.h + pad * 2}px`,
      border: `${p.kind === 'faint' ? 1 : 2}px ${p.kind === 'dot' ? 'dashed' : 'solid'} ${p.color}`,
      borderRadius: '5px',
      opacity: p.kind === 'faint' ? '0.5' : p.kind === 'dot' ? '0.75' : '1',
    });

    // Where the number sits, relative to the part it names.
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2, off = 13;
    const spot = {
      tl: [rect.x - off, rect.y - off], tr: [rect.r + off, rect.y - off],
      bl: [rect.x - off, rect.b + off], br: [rect.r + off, rect.b + off],
      l: [rect.x - off - 4, cy], r: [rect.r + off + 4, cy],
      t: [cx, rect.y - off - 4], b: [cx, rect.b + off + 4],
      c: [cx, cy],
    }[p.at];

    add({
      left: `${spot[0] - 11}px`, top: `${spot[1] - 11}px`, width: '22px', height: '22px',
      borderRadius: '50%', background: p.color, color: '#0f1215',
      font: '700 12px/22px ui-monospace, SFMono-Regular, Menlo, monospace',
      textAlign: 'center', boxShadow: '0 0 0 2px rgba(15,18,21,.85)',
    }, String(p.n));

    found.push({ n: p.n, name: p.name, w: Math.round(rect.w), h: Math.round(rect.h) });
  }

  /* ---------- the legend ---------- */

  const room = pageRect(doc.querySelector('svg.room'));
  const card = add({
    left: `${room.r + 46}px`, top: `${room.y - 6}px`, width: '340px',
    padding: '16px 18px', borderRadius: '10px',
    background: 'var(--surface)', border: '1px solid var(--border)',
    font: '13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace', color: 'var(--text)',
  });

  const head = doc.createElement('div');
  Object.assign(head.style, {
    display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
    borderBottom: '1px solid var(--border)', paddingBottom: '9px', marginBottom: '11px',
    letterSpacing: '.06em',
  });
  head.innerHTML = '<b style="font-size:12px">WHAT WE CALL THE PARTS</b>'
    + '<span style="color:var(--muted);font-size:11px">code selector</span>';
  card.appendChild(head);

  for (const p of PARTS) {
    const row = doc.createElement('div');
    Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '9px', margin: '0 0 5px' });
    row.innerHTML =
      `<span style="flex:0 0 18px;height:18px;border-radius:50%;background:${p.color};color:#0f1215;`
      + `font:700 11px/18px ui-monospace,Menlo,monospace;text-align:center">${p.n}</span>`
      + `<b style="flex:1">${p.name}</b>`
      + `<span style="color:var(--muted)">${p.code}</span>`;
    card.appendChild(row);
  }

  const note = doc.createElement('div');
  Object.assign(note.style, {
    marginTop: '13px', paddingTop: '11px', borderTop: '1px solid var(--border)',
    color: 'var(--muted)', fontSize: '12px', lineHeight: '1.55',
  });
  note.innerHTML =
    'the <b>room</b> is one channel · the <b>floor</b> is all rooms<br>'
    + 'the <b>tray</b> holds three kinds of pill: ✉ unread · ☰ assigned · ☑ claimed<br>'
    + 'note: the code calls the whole <b>cell</b> <span style="color:var(--text)">.desk</span>';
  card.appendChild(note);

  /* ---------- what to crop to ----------
     The page is wider and taller than the picture wants to be, and `shot` takes
     a selector rather than a rectangle — so the rectangle is given to it as an
     element. Full width from the left edge, because the top bar carries the
     version and cropping into it would cut "orchestratinator v0.9.3" in half;
     bottom to whichever of the room and the legend reaches lower. */
  const legend = pageRect(card);
  // Full page width, not "as far as the legend reaches": the top bar's controls
  // sit further right than the legend does, and cropping to the legend sliced
  // "auto-refresh" in half — a reference image that looks like a broken capture.
  const frame = add({
    left: '0px', top: '0px',
    width: `${doc.documentElement.scrollWidth}px`,
    height: `${Math.round(Math.max(room.b, legend.b) + 26)}px`,
    pointerEvents: 'none',
  });
  frame.id = 'nomen-frame';

  return JSON.stringify({
    found,
    frame: { w: Math.round(legend.r + 26), h: Math.round(Math.max(room.b, legend.b) + 26) },
    pageWidth: doc.documentElement.scrollWidth,
    legendFits: legend.r + 26 <= doc.documentElement.scrollWidth,
    parts: found.length,
  }, null, 1);
})()
