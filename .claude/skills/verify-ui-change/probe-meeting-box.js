(() => {
// What the floor draws of a meeting: every room's desks with where each
// stands, and every meeting box with its frame and its two placards.
// Rects are the window's, so a desk "inside its box" is read the way an
// eye reads it; `at` is the desk's place in the drawing's own units, which
// is what "back where it was" compares. An SVG rect's box is its fill and
// leaves the stroke out (SKILL.md, "measuring the container").
const own = (el) => (el ? [...el.childNodes].filter((n) => n.nodeName !== 'title').map((n) => n.textContent).join('') : null);
const R = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
const at = (el) => { const m = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(el?.getAttribute('transform') ?? ''); return m ? [Number(m[1]), Number(m[2])] : null; };
const tab = (g) => {
  if (!g) return null;
  const rect = g.querySelector('.meetTabBox');
  const cs = getComputedStyle(rect);
  return {
    text: own(g.querySelector('.meetTabText')), plate: R(rect), words: R(g.querySelector('.meetTabText')),
    title: g.querySelector('title')?.textContent ?? null, fill: cs.fill, ink: getComputedStyle(g.querySelector('.meetTabText')).fill,
    role: g.getAttribute('role'), tabindex: g.getAttribute('tabindex'), disabled: g.getAttribute('aria-disabled'),
    act: g.dataset.act ?? null, meeting: g.dataset.meeting ?? null, focused: document.activeElement === g,
    cursor: getComputedStyle(g).cursor,
  };
};
return JSON.stringify({
  building: document.getElementById('floor-rooms')?.classList.contains('building') ?? null,
  floor: (() => { try { return localStorage.getItem('orch.floor'); } catch { return null; } })(),
  totals: document.getElementById('floor-totals')?.textContent ?? null,
  rooms: [...document.querySelectorAll('#floor-rooms svg.room')].map((r) => {
    const vb = r.viewBox.baseVal;
    const track = r.querySelector('.deskTrack');
    const kids = track ? [...track.children] : [];
    return {
      ch: r.dataset.channel,
      collapsed: r.classList.contains('collapsed'),
      selecting: r.classList.contains('selecting'),
      viewBox: [vb.width, vb.height],
      rect: R(r),
      scale: r.getBoundingClientRect().width / vb.width,
      meta: r.querySelector('.roomMeta')?.textContent ?? null,
      wall: R(r.querySelector('.roomWall')),
      band: R(r.querySelector('.selBand, .missBand')),
      track: at(track) ?? [0, 0],
      arrows: [...r.querySelectorAll('.deskArrow')].map((a) => `${a.dataset.scroll}${a.classList.contains('spent') ? ':spent' : ''}`),
      desks: [...r.querySelectorAll('.desk')].map((d) => ({ agent: d.dataset.agent, at: at(d), hit: R(d.querySelector('.deskHit')) })),
      boxes: [...r.querySelectorAll('.meetBox')].map((g) => {
        const f = g.querySelector('.meetFrame');
        const cs = getComputedStyle(f);
        return {
          key: g.dataset.meeting, frame: R(f),
          stroke: cs.stroke, strokeWidth: cs.strokeWidth, vector: cs.vectorEffect, fill: cs.fill,
          // In the track, and drawn before every desk: under its desks, and
          // scrolled with them on a collapsed storey.
          inTrack: g.parentElement === track,
          underDesks: kids.indexOf(g) >= 0 && kids.indexOf(g) < kids.findIndex((k) => k.classList.contains('desk')),
          label: tab(g.querySelector('.meetLabel')), end: tab(g.querySelector('.meetEnd')),
        };
      }),
    };
  }),
});
})()
