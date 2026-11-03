// What the chat panel shows for its chat controls: meta line, the model and effort selects, the asked-for note, the slash menu, the last rows (with the compaction summary open/closed). Read with page.probe().
(() => {
  const p = document.querySelector('#floor-panel');
  const sel = (q) => p.querySelector(q);
  const rows = [...p.querySelectorAll('#p-turns > .t')].slice(-14).map((t) => ({
    cls: t.className, text: (t.querySelector('.t-text')?.textContent ?? t.querySelector('.t-body')?.textContent ?? t.textContent).replace(/\s+/g, ' ').trim().slice(0, 90),
    open: t.querySelector('details') ? t.querySelector('details').open : null,
    when: t.querySelector('.t-when')?.textContent ?? null,
  }));
  return JSON.stringify({
    agent: p.dataset.agent, meta: sel('.p-meta')?.textContent,
    model: { value: sel('[data-act="set-model"]')?.value, options: [...(sel('[data-act="set-model"]')?.options ?? [])].map((o) => o.value), disabled: sel('[data-act="set-model"]')?.disabled },
    effort: { value: sel('[data-act="set-effort"]')?.value, disabled: sel('[data-act="set-effort"]')?.disabled },
    asked: { text: sel('.p-asked')?.textContent, hidden: sel('.p-asked')?.classList.contains('hidden') },
    slashHidden: sel('.p-slash')?.classList.contains('hidden'), slashRows: [...p.querySelectorAll('.p-slash-row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()),
    textarea: sel('#p-text')?.value,
    bubble: document.querySelector(`.desk[data-agent="${CSS.escape(p.dataset.agent)}"] .bubbleText`)?.textContent ?? null,
    rows,
  }, null, 1);
})()
