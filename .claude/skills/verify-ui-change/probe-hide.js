JSON.stringify({
  view: document.body.classList.contains('view-floor') ? 'floor' : 'board',
  chips: [...document.querySelectorAll('#floor-pick [data-floor]')].map((b) => b.dataset.floor + (b.classList.contains('on') ? '*' : '')),
  rooms: [...document.querySelectorAll('#floor-rooms svg.room')].map((r) => ({
    ch: r.dataset.channel,
    collapsed: r.classList.contains('collapsed'),
    h: Number(r.getAttribute('viewBox').split(' ')[3]),
    meta: r.querySelector('.roomMeta')?.textContent ?? null,
    desks: [...r.querySelectorAll('.desk')].map((d) => d.dataset.agent),
    plates: [...r.querySelectorAll('.plateRole')].map((t) => t.textContent),
    pills: [...r.querySelectorAll('.deskPill')].map((p) => {
      const rect = p.getBoundingClientRect();
      return { agent: p.dataset.agent, act: p.dataset.act, text: p.querySelector('.deskPillText')?.textContent, count: p.querySelector('.deskPillCountText')?.textContent ?? null, title: p.querySelector('title')?.textContent, top: Math.round(rect.top), left: Math.round(rect.left), w: Math.round(rect.width) };
    }),
    lastDeskBottom: (() => { const ds = [...r.querySelectorAll('.desk .deskHit')]; return ds.length ? Math.round(Math.max(...ds.map((d) => d.getBoundingClientRect().bottom))) : null; })(),
    bottom: Math.round(r.getBoundingClientRect().bottom),
  })),
  pop: (() => {
    const p = document.getElementById('desk-pop');
    if (!p) return null;
    return { head: p.querySelector('.dp-head strong')?.textContent, buttons: [...p.querySelectorAll('.dp-foot button')].map((b) => `${b.dataset.act}:${b.textContent}:${b.disabled ? 'disabled' : 'enabled'}`), window: [...p.querySelectorAll('.dp-row')].map((r) => r.textContent).find((t) => t.startsWith('window')) ?? null };
  })(),
  floorAway: [...document.querySelectorAll('#floor-away .min-pill')].map((p) => p.dataset.channel),
  totals: document.querySelector('#floor-totals')?.textContent ?? null,
  empty: document.querySelector('#floor-rooms .q-empty')?.textContent ?? null,
  focused: document.activeElement?.dataset?.agent ?? document.activeElement?.tagName ?? null,
})
