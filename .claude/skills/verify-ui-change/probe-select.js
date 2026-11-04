(() => {
// An element's own words, without its <title>: textContent would add the tooltip.
const own = (el) => el ? [...el.childNodes].filter((n) => n.nodeName !== 'title').map((n) => n.textContent).join('') : null;
return JSON.stringify({
  building: document.getElementById('floor-rooms')?.classList.contains('building') ?? null,
  floor: (() => { try { return localStorage.getItem('orch.floor'); } catch { return null; } })(),
  rooms: [...document.querySelectorAll('#floor-rooms svg.room')].map((r) => ({
    ch: r.dataset.channel,
    collapsed: r.classList.contains('collapsed'),
    selecting: r.classList.contains('selecting'),
    h: Number(r.getAttribute('viewBox').split(' ')[3]),
    meta: r.querySelector('.roomMeta')?.textContent ?? null,
    control: own(r.querySelector('.roomSel')),
    bar: r.querySelector('.selBar') ? {
      all: r.querySelector('.selAll')?.getAttribute('aria-checked'),
      allText: own(r.querySelector('.selAll .selText')),
      count: [...r.querySelectorAll('.selBar > .selText')].map((t) => t.textContent).join(' '),
      chips: [...r.querySelectorAll('.selChip')].map((c) => `${c.dataset.act}:${c.querySelector('.selChipText')?.textContent}:${c.getAttribute('aria-disabled') === 'true' ? 'off' : 'on'}`),
      titles: Object.fromEntries([...r.querySelectorAll('.selChip')].map((c) => [c.dataset.act, c.querySelector('title')?.textContent])),
      sum: own(r.querySelector('.selSum')),
    } : null,
    desks: [...r.querySelectorAll('.desk')].map((d) => {
      const box = d.querySelector('.selBox');
      const tag = box?.querySelector('.selTag');
      return `${d.dataset.agent}${box ? (box.getAttribute('aria-checked') === 'true' ? '[x]' : '[ ]') : ''}${tag ? `<${own(tag)}${tag.classList.contains('bad') ? '!' : ''}>` : ''}`;
    }),
    tagTitles: Object.fromEntries([...r.querySelectorAll('.desk')].map((d) => [d.dataset.agent, d.querySelector('.selTag title')?.textContent ?? null]).filter(([, t]) => t)),
    bellsShown: [...r.querySelectorAll('.desk .bell')].filter((b) => getComputedStyle(b).display !== 'none').length,
    pills: [...r.querySelectorAll('.deskPill')].map((p) => p.dataset.agent),
    // Where the first checkbox sits against its bell, on screen.
    boxVsBell: (() => {
      const d = r.querySelector('.desk .selBox');
      const b = d?.closest('.desk')?.querySelector('.bell');
      if (!d || !b) return null;
      const x = d.getBoundingClientRect();
      const y = b.getBoundingClientRect();
      return { box: [Math.round(x.left), Math.round(x.top), Math.round(x.width), Math.round(x.height)], bell: [Math.round(y.left), Math.round(y.top), Math.round(y.width), Math.round(y.height)] };
    })(),
  })),
  panel: (() => {
    const p = document.getElementById('floor-panel');
    if (!p || !p.dataset.agent) return null;
    return { agent: p.dataset.agent, pending: [...p.querySelectorAll('#p-turns .t-pending')].map((n) => `${n.querySelector('.t-body')?.textContent} | ${n.querySelector('.t-when')?.textContent}${n.classList.contains('stale') ? ' | STALE' : ''}`), composer: document.getElementById('p-text')?.value ?? null };
  })(),
  card: !!document.getElementById('desk-pop'),
  errors: window.__errs ?? null,
  focused: document.activeElement?.dataset?.fk ?? document.activeElement?.dataset?.agent ?? document.activeElement?.tagName ?? null,
});
})()
