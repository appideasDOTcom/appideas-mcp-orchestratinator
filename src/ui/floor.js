/* The floor — one room per channel, one desk per agent.
 *
 * A second view of the same server, for the people who have to operate this
 * system without having built it. The board answers "what is the state"; this
 * answers "who is stuck, and what do I do about it", which is the question that
 * was previously being answered by holding several chat windows and a dashboard
 * in one head at once.
 *
 * Deliberately its own file with its own poll loop rather than a mode inside
 * app.js: the board's render replaces its whole subtree on every tick, which is
 * fine for cards and fatal for a room you are meant to watch things move across.
 *
 * Two rules the drawing follows, because the metaphor can lie in ways a table
 * cannot:
 *   - Motion means an event really happened. Envelopes fly on real message rows,
 *     never on a timer, and never to make the room look busy.
 *   - A desk never claims to know more than the server does. "Waiting" appears
 *     only where Claude Code said it was waiting; a quiet desk is drawn quiet,
 *     not guessed at.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const SVG = 'http://www.w3.org/2000/svg';

  const POLL_MS = 2000;
  const COLS = 3;
  const PAD = 28;
  const HEAD_H = 52;   // clears a two-line bubble hanging above the first row
  const DESK_W = 168;
  const DESK_H = 150;
  const GAP = 30;
  /** How far a desk draws below its origin: desk slab, then nameplate. */
  const DESK_BELOW = 126;
  /* Bubble sizing. These three numbers are related and have to stay that way:
     a character budget picked independently of the box width is how you get a
     sentence painted straight across the desk next door. Everything is derived
     from BUBBLE_W and the font size the stylesheet uses. */
  const BUBBLE_W = 158;          // hard ceiling, a shade under DESK_W + GAP
  const CHAR_W = 5.4;            // ≈ average advance at the 10.5px bubble font
  const BUBBLE_LINES = 2;
  const PER_LINE = Math.floor((BUBBLE_W - 16) / CHAR_W);

  /** How long a sent message may sit unrecorded before it says so. */
  const SENDING_GRACE_MS = 30_000;

  const ui = {
    on: false,
    open: null,          // { channel, agent } whose chat panel is showing
    turns: [],
    sending: [],         // messages accepted but not yet seen in the conversation
    sinceTurn: 0,
    lastActivityId: 0,
    primed: false,       // first activity poll only records the high-water mark
    roomsSig: null,      // last drawn room signature, so a tick that changes nothing redraws nothing
    pickSig: null,
    floorFilter: null,   // a channel name, or null for every floor stacked
    panelFor: null,      // which desk the panel skeleton was built for
    renderedTurn: 0,     // highest turn id already in the panel
    stick: true,         // auto-scroll follows only while the reader is at the bottom
    stream: null,        // EventSource for the open desk, if the browser has one
    partial: '',         // the reply being streamed to the open desk right now
    filterWas: null,     // the session the panel was last scoped to
    timer: null,
  };

  let floor = { channels: [], queue: [], totals: {}, cast: [] };

  /* ---------- small helpers ---------- */

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const clip = (s, n) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
  };

  function ago(iso) {
    if (!iso) return '';
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    return `${Math.round(s / 3600)}h`;
  }

  /**
   * Break a line into at most `max` lines of `per` characters, on word breaks
   * where one exists. Returns the lines, with an ellipsis on the last if there
   * was more — a bubble that silently drops the rest of a sentence reads as if
   * that was all the agent said.
   */
  function wrap(text, per, max) {
    const words = String(text ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    const lines = [];
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (next.length <= per) { line = next; continue; }
      if (line) lines.push(line);
      // A single word longer than the line gets cut rather than widening the box.
      line = w.length > per ? `${w.slice(0, per - 1)}…` : w;
      if (lines.length === max) break;
    }
    if (line && lines.length < max) lines.push(line);
    const used = lines.join(' ').replace(/…$/, '').length;
    if (used < words.join(' ').length && lines.length) {
      const last = lines[lines.length - 1];
      lines[lines.length - 1] = last.length >= per ? `${last.slice(0, per - 1)}…` : `${last}…`;
    }
    return lines;
  }

  function el(tag, attrs = {}, children = []) {
    const n = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== null && v !== undefined) n.setAttribute(k, String(v));
    }
    for (const c of [].concat(children)) if (c) n.appendChild(c);
    return n;
  }

  /** A desk's state, in the one word the room is drawn from. */
  function deskState(d) {
    if (!d.live) return 'away';
    if (d.session?.awaiting_kind) return 'needs-you';
    if (d.hosted?.state === 'working' || d.last_turn?.role === 'tool') return 'working';
    return 'here';
  }

  /* ---------- drawing ---------- */

  function roomGeometry(n) {
    const cols = Math.min(COLS, Math.max(1, n));
    const rows = Math.max(1, Math.ceil(n / cols));
    return {
      cols,
      rows,
      w: PAD * 2 + cols * DESK_W + (cols - 1) * GAP,
      // The last row contributes only what it draws below the desk origin (the
      // nameplate), not a whole cell — a full DESK_H there leaves every room
      // ending in a band of empty carpet that reads as "somebody is missing".
      h: PAD * 2 + HEAD_H + (rows - 1) * (DESK_H + GAP) + DESK_BELOW,
    };
  }

  function deskXY(i, geo) {
    const col = i % geo.cols;
    const row = Math.floor(i / geo.cols);
    return {
      x: PAD + col * (DESK_W + GAP),
      y: PAD + HEAD_H + row * (DESK_H + GAP),
    };
  }

  /** A person: head, shoulders, and a chair back. Drawn rather than sprited so
   *  there is no asset licence anywhere in this repo and no build step to add. */
  function person(state, seat) {
    const g = el('g', { class: `person ${state}`, 'data-seat': seat });
    g.appendChild(el('ellipse', { cx: 0, cy: 46, rx: 26, ry: 6, class: 'shadow' }));
    g.appendChild(el('path', { d: 'M -20 44 q 0 -26 20 -26 q 20 0 20 26 z', class: 'body' }));
    g.appendChild(el('circle', { cx: 0, cy: 4, r: 12, class: 'head' }));
    return g;
  }

  function desk(d, i, geo, channel) {
    const { x, y } = deskXY(i, geo);
    const state = deskState(d);
    const g = el('g', {
      class: `desk ${state}${d.reporting || d.hosted ? '' : ' not-reporting'}${d.hosted ? ' hosted' : ''}`,
      transform: `translate(${x} ${y})`,
      'data-channel': channel,
      'data-agent': d.agent,
      tabindex: '0',
      role: 'button',
      'aria-label': `${d.persona} (${d.agent}) — ${state.replace('-', ' ')}`,
    });

    // An invisible pad covering the whole cell, first so everything else draws
    // over it. Without this only the painted shapes are clickable and the gaps
    // between the person, the desk and the nameplate fall through to the floor
    // behind — so a click aimed squarely at somebody's desk does nothing, which
    // is the kind of failure people quietly decide is their own fault.
    g.appendChild(el('rect', {
      x: 0, y: -46, width: DESK_W, height: DESK_H, class: 'deskHit',
    }));

    // Order matters and is the whole illusion: the person is drawn first so the
    // desk occludes them from the chest down, which is what "sitting at a desk"
    // looks like. Drawn the other way round they float in front of the monitor.
    const p = person(state, d.seat);
    p.setAttribute('transform', 'translate(66 22)');
    g.appendChild(p);

    g.appendChild(el('rect', { x: 20, y: 62, width: 128, height: 30, rx: 5, class: 'deskTop' }));

    // The monitor sits on the desk beside them and lights up only when something
    // is really running — it is the one piece of furniture carrying state.
    g.appendChild(el('rect', { x: 100, y: 36, width: 42, height: 28, rx: 3, class: 'monitor' }));
    g.appendChild(el('rect', { x: 103, y: 39, width: 36, height: 20, rx: 2, class: 'screen' }));

    // Nameplate. The persona leads because that is what people will say out
    // loud; the real agent name follows because that is what the .mcp.json says
    // and someone will eventually need to match the two up.
    const plate = el('g', { class: 'plate', transform: 'translate(84 104)' });
    plate.appendChild(el('text', { x: 0, y: 0, class: 'plateName', 'text-anchor': 'middle' }));
    plate.lastChild.textContent = d.persona;
    plate.appendChild(el('text', { x: 0, y: 15, class: 'plateRole', 'text-anchor': 'middle' }));
    // A desk the board knows but no window has ever reported from says so on
    // its nameplate — it is the difference between "stepped away" and "never
    // installed the plugin", and only one of those is something to go fix.
    plate.lastChild.textContent = d.hosted
      ? `${d.agent} · ${d.hosted.live ? 'ready' : 'host offline'}`
      : d.reporting ? d.agent : `${d.agent} · not reporting`;
    g.appendChild(plate);

    // What this desk is doing — the collapsed tool call, or the start of the last
    // thing said. Wrapped to a box that cannot reach the desk next door.
    if (d.last_turn) {
      const lines = wrap(
        d.last_turn.role === 'tool' ? (d.last_turn.text ?? d.last_turn.tool_name) : d.last_turn.text,
        PER_LINE,
        BUBBLE_LINES
      );
      if (lines.length) {
        const w = Math.min(BUBBLE_W, Math.max(48, Math.max(...lines.map((l) => l.length)) * CHAR_W + 16));
        const h = lines.length * 13 + 8;
        const b = el('g', { class: 'bubble', transform: `translate(84 ${-h - 4})` });
        b.appendChild(el('rect', { x: -w / 2, y: 0, width: w, height: h, rx: 8, class: 'bubbleBox' }));
        b.appendChild(el('path', { d: `M -4 ${h - 1} l 4 7 l 4 -7 z`, class: 'bubbleBox' }));
        lines.forEach((line, li) => {
          const t = el('text', { x: 0, y: 17 + li * 13, class: 'bubbleText', 'text-anchor': 'middle' });
          t.textContent = line;
          b.appendChild(t);
        });
        g.appendChild(b);
      }
    }

    // The one thing that must never be missed.
    if (state === 'needs-you') {
      const badge = el('g', { class: 'needs', transform: 'translate(126 12)' });
      badge.appendChild(el('circle', { cx: 0, cy: 0, r: 11, class: 'needsDot' }));
      const t = el('text', { x: 0, y: 4, 'text-anchor': 'middle', class: 'needsMark' });
      t.textContent = '!';
      badge.appendChild(t);
      g.appendChild(badge);
    }

    return g;
  }

  function room(c) {
    const geo = roomGeometry(c.desks.length);
    const svg = el('svg', {
      class: 'room',
      viewBox: `0 0 ${geo.w} ${geo.h}`,
      preserveAspectRatio: 'xMidYMin meet',
      'data-channel': c.channel,
      // Rooms fill the width they are given, but only up to a point. A two-desk
      // channel stretched across a wide monitor turns furniture into billboards
      // and makes the same desk look different from room to room, which is
      // exactly the recognisability the floor is trading on.
      style: `max-width:${Math.round(geo.w * 1.25)}px`,
    });

    svg.appendChild(el('rect', { x: 0, y: 0, width: geo.w, height: geo.h, rx: 12, class: 'roomFloor' }));
    svg.appendChild(el('rect', { x: 0, y: 0, width: geo.w, height: HEAD_H + 8, rx: 12, class: 'roomWall' }));

    const label = el('text', { x: PAD - 6, y: 23, class: 'roomName' });
    label.textContent = c.channel;
    svg.appendChild(label);

    const meta = el('text', { x: geo.w - PAD + 6, y: 23, class: 'roomMeta', 'text-anchor': 'end' });
    meta.textContent = `${c.live}/${c.desks.length} here${c.awaiting ? ` · ${c.awaiting} need you` : ''}`;
    svg.appendChild(meta);

    // Envelopes are appended to this layer so they sit above the furniture and
    // can be removed without touching anything that was drawn from data.
    const mail = el('g', { class: 'mailLayer' });

    c.desks.forEach((d, i) => svg.appendChild(desk(d, i, geo, c.channel)));
    svg.appendChild(mail);
    return svg;
  }

  /* ---------- envelopes ---------- */

  /**
   * Fly an envelope between two desks in a room.
   *
   * Driven only by rows that appeared in the activity feed since the last poll,
   * so a moving envelope always means a message was really sent. A broadcast has
   * no single recipient, so it fans out to every other desk — which is what a
   * broadcast is, and drawing it as one arrow to nowhere would misrepresent it.
   */
  function flyEnvelope(channel, fromAgent, toAgent) {
    const svg = document.querySelector(`#floor-rooms svg.room[data-channel="${CSS.escape(channel)}"]`);
    if (!svg) return;
    const c = floor.channels.find((x) => x.channel === channel);
    if (!c) return;
    const geo = roomGeometry(c.desks.length);
    const idx = (a) => c.desks.findIndex((d) => d.agent === a);
    const from = idx(fromAgent);
    if (from < 0) return;

    const targets = toAgent
      ? [idx(toAgent)].filter((i) => i >= 0)
      : c.desks.map((_, i) => i).filter((i) => i !== from);
    if (!targets.length) return;

    const layer = svg.querySelector('.mailLayer');
    const a = deskXY(from, geo);
    for (const t of targets) {
      const b = deskXY(t, geo);
      const path = `M ${a.x + 84} ${a.y + 20} Q ${(a.x + b.x) / 2 + 84} ${Math.min(a.y, b.y) - 24} ${b.x + 84} ${b.y + 20}`;
      const g = el('g', { class: 'envelope' });
      g.appendChild(el('rect', { x: -8, y: -6, width: 16, height: 12, rx: 2, class: 'envBody' }));
      g.appendChild(el('path', { d: 'M -8 -6 l 8 7 l 8 -7', class: 'envFlap' }));
      const motion = el('animateMotion', { dur: '1.15s', path, fill: 'freeze', repeatCount: '1' });
      g.appendChild(motion);
      layer.appendChild(g);
      // SMIL cleans up nothing on its own; the node has to go or a busy channel
      // slowly fills its room with parked envelopes.
      setTimeout(() => g.remove(), 1400);
    }
  }

  /* ---------- the operator queue ---------- */

  function queueHtml() {
    if (!floor.queue.length) {
      return '<div class="q-empty">Nobody is waiting on you.</div>';
    }
    return floor.queue
      .map((q) => {
        const mins = q.waiting_seconds ?? 0;
        const urgent = mins > 120 ? ' urgent' : '';
        return `
          <div class="q-row${urgent}" data-channel="${esc(q.channel)}" data-agent="${esc(q.agent)}">
            <div class="q-who">
              <span class="q-name">${esc(q.persona)}</span>
              <span class="q-agent mono">${esc(q.channel)}/${esc(q.agent)}</span>
            </div>
            <div class="q-why">
              <span class="q-kind ${esc(q.kind)}">${esc(q.kind.replace(/_/g, ' '))}</span>
              ${q.message ? `<span class="q-msg">${esc(clip(q.message, 110))}</span>` : ''}
            </div>
            <div class="q-where">
              <span class="q-win mono" title="${esc(q.cwd ?? '')}">${esc(q.window ?? '—')}</span>
              <span class="q-age mono">${esc(ago(q.since))}</span>
            </div>
            ${q.hosted && q.request_id ? `
              <button class="btn primary" data-act="permit" data-request="${esc(q.request_id)}" data-channel="${esc(q.channel)}" data-agent="${esc(q.agent)}">Approve</button>
              <button class="btn danger" data-act="refuse" data-request="${esc(q.request_id)}" data-channel="${esc(q.channel)}" data-agent="${esc(q.agent)}">Deny</button>`
              : q.held === 'editor' ? `<span class="q-elsewhere">answer this in your editor</span>` : ''}
            <button class="btn q-open" data-act="open" data-channel="${esc(q.channel)}" data-agent="${esc(q.agent)}">open</button>
          </div>`;
      })
      .join('');
  }

  /* ---------- the chat panel ---------- */

  function turnNode(t) {
    const div = document.createElement('div');
    div.dataset.id = t.id;
    if (t.role === 'tool') {
      div.className = 't t-tool';
      div.innerHTML = `<span class="t-dot"></span><span class="t-text mono">${esc(t.text ?? t.tool_name)}</span>`;
      return div;
    }
    const who = t.role === 'user' ? 'you' : t.role === 'assistant' ? 'agent' : t.role;
    div.className = `t t-${esc(t.role)}`;
    div.innerHTML = `
      <div class="t-who">${esc(who)}<span class="t-when mono" data-at="${esc(t.created_at)}">${esc(ago(t.created_at))}</span></div>
      <div class="t-body">${esc(t.text ?? '')}</div>`;
    return div;
  }

  /**
   * Build the panel's skeleton once per desk. Everything a tick touches after
   * this is a slot inside it, which is the whole fix for two bugs that looked
   * unrelated: a textarea rebuilt every two seconds loses what you were typing,
   * and a scroll box rebuilt every two seconds forgets where you had scrolled.
   * Neither node is ever created twice for the same desk.
   */
  function panelShell(wrap, channel, agent) {
    wrap.innerHTML = `
      <div class="p-head">
        <div class="p-id">
          <button class="p-persona" data-act="rename" title="Rename this desk — everyone sees the same cast"></button>
          <span class="mono muted">${esc(channel)}/${esc(agent)}</span>
        </div>
        <button class="btn" data-act="close-panel" title="Close">✕</button>
      </div>
      <div class="p-meta mono muted"></div>
      <div class="p-alert-slot"></div>
      <div class="p-turns" id="p-turns"></div>
      <div class="p-compose">
        <textarea id="p-text" class="input" rows="3"></textarea>
        <div class="p-actions">
          <span class="muted p-hint"></span>
          <button class="btn" data-act="stop" title="Stop the current turn">stop</button>
          <button class="btn" data-act="handback" title="Open this conversation in VS Code">Open in VS Code</button>
          <button class="btn primary" data-act="send">Send</button>
        </div>
      </div>`;
    ui.stick = true;
    ui.renderedTurn = 0;
    const box = $('p-turns');
    // Auto-scroll follows the conversation only while you are at the bottom.
    // Scroll up to read and it lets go; scroll back down to the bottom and it
    // takes over again. The threshold is a few pixels rather than zero so a
    // box one subpixel short of the bottom after a font loads still counts.
    box.addEventListener('scroll', () => {
      ui.stick = box.scrollHeight - box.scrollTop - box.clientHeight < 12;
    });
  }

  function renderPanel() {
    const wrap = $('floor-panel');
    if (!ui.open) {
      wrap.classList.add('hidden');
      wrap.innerHTML = '';
      ui.panelFor = null;
      closeStream();
      return;
    }
    const { channel, agent } = ui.open;
    const c = floor.channels.find((x) => x.channel === channel);
    const d = c?.desks.find((x) => x.agent === agent);
    if (!d) {
      wrap.classList.add('hidden');
      return;
    }
    const forKey = `${channel}|${agent}`;
    if (ui.panelFor !== forKey) {
      panelShell(wrap, channel, agent);
      ui.panelFor = forKey;
    }
    wrap.classList.remove('hidden');

    const s = d.session ?? {};
    const h = d.hosted;
    // Whether this desk can be typed into at all. There is no longer a case
    // for "somebody else has it": a message goes to the repo's Claude Code
    // window, and if there isn't one open the host opens one. The only thing
    // that can stop it is the host on that machine not running.
    // A conversation is one process. When an editor has it, the floor can show
    // it and can move it, but cannot type into it — a different thing from a
    // desk that is offline, and it needs to read that way.
    const held = h?.held === 'editor';
    const canChat = !!h?.live && !held;
    const presence = h
      ? (h.live ? `on ${h.host}${h.state === 'working' ? ' · working' : ''}` : `host ${h.host} offline`)
      : d.live ? 'live' : d.reporting ? 'away' : 'not reporting';
    wrap.querySelector('.p-persona').textContent = d.persona;
    wrap.querySelector('.p-meta').textContent =
      `${s.window ?? h?.window ?? 'no window seen'}${s.git_branch ? ` · ${s.git_branch}` : ''}${s.model ? ` · ${s.model}` : ''}` +
      ` · ${presence} · ${d.turns} turn${d.turns === 1 ? '' : 's'}`;

    // The alert is rebuilt only when what it says changes; its age ticks in
    // place. On a hosted desk a permission prompt carries its answer buttons:
    // this is the human-in-the-middle, the same decision the window would have
    // asked for, answered from here.
    const alertSlot = wrap.querySelector('.p-alert-slot');
    const req = canChat ? d.permission : null;
    const alertSig = s.awaiting_kind ? `${s.awaiting_kind}|${s.awaiting_message ?? ''}|${s.awaiting_since ?? ''}|${req?.request_id ?? ''}` : '';
    if (alertSlot.dataset.sig !== alertSig) {
      alertSlot.dataset.sig = alertSig;
      alertSlot.innerHTML = s.awaiting_kind
        ? `<div class="p-alert${req ? ' p-alert-ask' : ''}">
             <div><b>${esc(s.awaiting_kind.replace(/_/g, ' '))}</b> — ${esc(clip(req?.summary ?? s.awaiting_message, 200))} <span class="mono t-when" data-at="${esc(s.awaiting_since)}"></span></div>
             ${req ? `<div class="p-decide">
               <button class="btn primary" data-act="permit" data-request="${esc(req.request_id)}">Approve</button>
               <button class="btn danger" data-act="refuse" data-request="${esc(req.request_id)}">Deny</button>
             </div>` : ''}
           </div>`
        : '';
    }

    $('p-text').placeholder = canChat
      ? `Message ${d.persona}…`
      : held
      ? `${d.persona}’s conversation is open in your editor…`
      : `${d.persona}’s machine isn’t reachable right now…`;
    wrap.querySelector('[data-act="send"]').disabled = !canChat;
    wrap.querySelector('[data-act="stop"]').classList.toggle('hidden', !(canChat && h.state === 'working'));
    wrap.querySelector('[data-act="handback"]').classList.toggle('hidden', !h?.live);
    wrap.querySelector('.p-compose').classList.toggle('held', held);
    // The hint says exactly what will happen, because a Send button that
    // sometimes can't is worse than one that says why.
    wrap.querySelector('.p-hint').innerHTML = held
      ? `Open in your editor${h.held_pid ? ` (pid ${h.held_pid})` : ''}. Close it there, or move it back with the button — one app holds a conversation at a time.`
      : canChat
      ? `A turn in <b class="mono">${esc(h.window ?? agent)}</b> on ${esc(h.host)}. Enter sends, Shift+Enter for a new line.`
      : h
        ? `The host for this desk (${esc(h.host)}) is offline, so nothing sent here can reach it. Start it on that machine and this works again.`
        : `No host on this board is running that repo, so there is nowhere to send this yet.`;

    // Turns are appended, never re-rendered. A row already on screen stays
    // exactly where it is, which is what makes reading upward possible. The
    // reply-in-progress is one extra node at the bottom, updated in place.
    const box = $('p-turns');
    let partialNode = box.querySelector('.t-partial');
    if (!ui.turns.length && !ui.partial) {
      if (!box.querySelector('.q-empty')) {
        box.innerHTML = `<div class="q-empty">${canChat
          ? `Say something to ${esc(d.persona)}.`
          : d.reporting
            ? 'No conversation captured yet.'
            : 'This window isn’t reporting. Install the <b>orchestratinator-floor</b> plugin on its machine and restart the session — its conversation appears here as it runs.'}</div>`;
      }
    } else {
      box.querySelector('.q-empty')?.remove();
      const fresh = ui.turns.filter((t) => t.id > ui.renderedTurn);
      for (const t of fresh) box.insertBefore(turnNode(t), partialNode);
      if (fresh.length) ui.renderedTurn = Math.max(...fresh.map((t) => t.id));
    }
    // Anything sent but not yet in the conversation, shown as itself rather
    // than as a turn: it is not one until the window says so.
    for (const stale of box.querySelectorAll('.t-pending')) stale.remove();
    for (const p of ui.sending) {
      const node = document.createElement('div');
      node.className = 't t-user t-pending';
      // A message stops claiming to be on its way once it plainly is not.
      // Nothing here can prove it failed — only that it has not been recorded —
      // so it says that, rather than spinning forever or vanishing.
      const stale = Date.now() - (p.at ?? 0) > SENDING_GRACE_MS;
      node.classList.toggle('stale', stale);
      node.innerHTML = `<div class="t-who">you<span class="t-when mono">${stale ? 'not recorded — send again' : 'sending…'}</span></div>` +
        ' <div class="t-body"></div>';
      node.querySelector('.t-body').textContent = p.text;
      box.insertBefore(node, partialNode);
    }

    if (ui.partial) {
      if (!partialNode) {
        partialNode = document.createElement('div');
        partialNode.className = 't t-assistant t-partial';
        partialNode.innerHTML = '<div class="t-who">agent<span class="t-when mono">typing…</span></div><div class="t-body"></div>';
        box.appendChild(partialNode);
      }
      partialNode.querySelector('.t-body').textContent = ui.partial;
    } else if (partialNode) {
      partialNode.remove();
    }
    for (const w of wrap.querySelectorAll('.t-when[data-at]')) w.textContent = ago(w.dataset.at);
    if (ui.stick) box.scrollTop = box.scrollHeight;
  }

  async function loadTurns(reset) {
    if (!ui.open) return;
    if (reset) {
      ui.turns = [];
    ui.sending = [];
      ui.sinceTurn = 0;
    }
    const { channel, agent } = ui.open;
    // A hosted desk shows the hosted session — the one you can talk to — even
    // if a window in the same repo is reporting turns of its own to this desk.
    const sess = sessionFilter();
    const url = `./api/floor/turns?channel=${encodeURIComponent(channel)}&agent=${encodeURIComponent(agent)}&since=${ui.sinceTurn}` +
      (sess ? `&session=${encodeURIComponent(sess)}` : '');
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    if (!r.ok) return;
    const d = await r.json();
    if (!ui.open || ui.open.channel !== channel || ui.open.agent !== agent) return;
    if (d.rows.length) {
      const known = new Set(ui.turns.map((x) => x.id));
      ui.turns = ui.turns.concat(d.rows.filter((x) => !known.has(x.id))).slice(-300);
      ui.sinceTurn = Math.max(ui.sinceTurn, ...d.rows.map((x) => x.id));
      settle(d.rows);
    }
    if (typeof d.partial === 'string' && !ui.stream) ui.partial = d.partial;
  }

  /**
   * Forget a pending message once the window has actually recorded it.
   *
   * Matching on the text is exactly right here: the turn that comes back is
   * the window saying "this is in the conversation", and that is the only
   * thing that should retire the "sending" state.
   */
  const squash = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
  function settle(rows) {
    if (!ui.sending.length) return;
    const arrived = rows.filter((r) => r.role === 'user').map((r) => squash(r.text));
    if (rows.some((r) => r.role === 'error')) return void (ui.sending = []);
    if (!arrived.length) return;
    ui.sending = ui.sending.filter((p) => !arrived.some((a) => a.includes(squash(p.text))));
  }

  /** The session the open desk's panel is scoped to, or null for all of them. */
  function sessionFilter() {
    if (!ui.open) return null;
    const d = floor.channels.find((c) => c.channel === ui.open.channel)?.desks.find((x) => x.agent === ui.open.agent);
    return d?.hosted?.session_id ?? null;
  }

  /* ---------- live updates for the open desk ---------- */

  /**
   * Server-sent events for the desk whose panel is open: turns as they land,
   * the reply as it streams, prompts as they open and close. The two-second
   * poll keeps running underneath, so if a proxy chokes on the stream the
   * panel is merely slower, never wrong.
   */
  function openStream(channel, agent) {
    closeStream();
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource(`./api/floor/stream?channel=${encodeURIComponent(channel)}&agent=${encodeURIComponent(agent)}`);
    es.onmessage = (m) => {
      if (!ui.open || ui.open.channel !== channel || ui.open.agent !== agent) return;
      let ev;
      try { ev = JSON.parse(m.data); } catch { return; }
      if (ev.type === 'turn' && ev.turn && ev.turn.id > ui.sinceTurn) {
        const sess = sessionFilter();
        // Another session on this desk is not this conversation. A hosted
        // session's id is only known once it has announced itself, so a turn
        // with no session on either side is let through rather than lost.
        // Settle first. A turn filtered out of this panel still proves the
        // message was recorded, and a "sending" bubble that never clears is a
        // worse lie than one shown a moment early.
        settle([ev.turn]);
        if (sess && ev.turn.session_id && ev.turn.session_id !== sess) { renderPanel(); return; }
        ui.turns = ui.turns.concat([ev.turn]).slice(-300);
        ui.sinceTurn = ev.turn.id;
        if (ev.turn.role === 'assistant') ui.partial = '';
        renderPanel();
      } else if (ev.type === 'partial') {
        ui.partial = ev.text ?? '';
        renderPanel();
      } else if (ev.type === 'permission' || ev.type === 'state' || ev.type === 'session') {
        // Both change what the desk and the queue say; the cheapest correct
        // thing is to fetch the floor again rather than mirror the logic here.
        tick();
      }
    };
    ui.stream = es;
  }

  function closeStream() {
    if (ui.stream) { try { ui.stream.close(); } catch { /* already closed */ } }
    ui.stream = null;
    ui.partial = '';
  }

  /* ---------- render ---------- */

  function render() {
    const rooms = $('floor-rooms');
    // Rooms are rebuilt only when something they depict actually changed. The
    // board does the same thing for the same reason, and here it matters more:
    // this subtree is redrawn every two seconds, and replacing it unconditionally
    // drops keyboard focus, cancels :hover, and detaches the very node somebody
    // is in the middle of clicking. It would also delete envelopes mid-flight.
    // The floor picker. A floor is a channel, so this is how you walk from one
    // room to another; "all floors" is the stacked view. Only offered once there
    // are two, because a picker with one choice is furniture.
    const names = floor.channels.map((c) => c.channel);
    if (ui.floorFilter && !names.includes(ui.floorFilter)) ui.floorFilter = null;
    const pickSig = JSON.stringify([names, ui.floorFilter]);
    if (pickSig !== ui.pickSig) {
      ui.pickSig = pickSig;
      $('floor-pick').innerHTML = names.length < 2 ? '' : [
        `<button class="chip${ui.floorFilter ? '' : ' on'}" data-floor="">all floors</button>`,
        ...names.map((n) => `<button class="chip${ui.floorFilter === n ? ' on' : ''}" data-floor="${esc(n)}">${esc(n)}</button>`),
      ].join('');
    }
    const shown = ui.floorFilter ? floor.channels.filter((c) => c.channel === ui.floorFilter) : floor.channels;

    const sig = JSON.stringify([ui.floorFilter, shown]);
    if (sig !== ui.roomsSig) {
      ui.roomsSig = sig;
      if (!shown.length) {
        rooms.innerHTML =
          '<div class="q-empty">No desks yet. An agent gets a seat the moment it appears on the board or its window posts a hook event.</div>';
      } else {
        rooms.replaceChildren(...shown.map(room));
      }
    }
    $('floor-queue').innerHTML = queueHtml();
    const t = floor.totals ?? {};
    $('floor-totals').textContent =
      `${t.channels ?? 0} floor${t.channels === 1 ? '' : 's'} · ${t.desks ?? 0} desk${t.desks === 1 ? '' : 's'} · ${t.live ?? 0} here · ${t.awaiting ?? 0} need you`;
    renderPanel();
  }

  /* ---------- polling ---------- */

  async function tick() {
    if (!ui.on) return;
    try {
      const r = await fetch('./api/floor', { headers: { accept: 'application/json' } });
      if (r.ok) floor = await r.json();
    } catch { /* the board's own dot already reports the connection */ }

    // Envelopes come from the activity feed, which is the same source the log
    // panel reads — one shared definition of "a message happened".
    try {
      const r = await fetch('./api/activity?limit=40', { headers: { accept: 'application/json' } });
      if (r.ok) {
        const rows = (await r.json()).rows.filter((x) => x.kind === 'message');
        const highest = rows.reduce((m, x) => Math.max(m, x.ref_id), 0);
        if (ui.primed) {
          for (const row of rows.filter((x) => x.ref_id > ui.lastActivityId).reverse()) {
            flyEnvelope(row.channel, row.actor, row.target);
          }
        }
        ui.primed = true;
        ui.lastActivityId = Math.max(ui.lastActivityId, highest);
      }
    } catch { /* as above */ }

    if (ui.open) {
      // The conversation the panel is scoped to can change under it — a hosted
      // session announces its real id on its first turn — and when it does the
      // turns on screen are the wrong set. Start the panel over from that
      // session rather than appending to a list filed under the old key.
      const filter = sessionFilter();
      if (filter !== ui.filterWas) {
        ui.filterWas = filter;
        ui.turns = [];
    ui.sending = [];
        ui.sinceTurn = 0;
        ui.renderedTurn = 0;
        $('p-turns')?.replaceChildren();
        await loadTurns(true);
      } else {
        await loadTurns(false);
      }
    }
    render();
  }

  function start() {
    if (ui.timer) return;
    tick();
    ui.timer = setInterval(tick, POLL_MS);
  }

  function stop() {
    clearInterval(ui.timer);
    ui.timer = null;
  }

  /* ---------- events ---------- */

  function openDesk(channel, agent) {
    ui.open = { channel, agent };
    ui.turns = [];
    ui.sending = [];
    ui.sinceTurn = 0;
    ui.partial = '';
    ui.filterWas = sessionFilter();
    loadTurns(true).then(() => { render(); openStream(channel, agent); });
  }

  document.addEventListener('click', async (e) => {
    const deskEl = e.target.closest?.('svg.room .desk');
    if (deskEl && ui.on) {
      openDesk(deskEl.dataset.channel, deskEl.dataset.agent);
      return;
    }

    const pick = e.target.closest?.('#floor-pick [data-floor]');
    if (pick && ui.on) {
      ui.floorFilter = pick.dataset.floor || null;
      try { localStorage.setItem('orch.floor', ui.floorFilter ?? ''); } catch { /* not worth failing over */ }
      render();
      return;
    }

    const act = e.target.closest?.('[data-act]');
    if (!act || !ui.on) return;

    if (act.dataset.act === 'open') {
      openDesk(act.dataset.channel, act.dataset.agent);
    } else if (act.dataset.act === 'close-panel') {
      ui.open = null;
      render();
    } else if (act.dataset.act === 'send') {
      await sendChat();
    } else if (act.dataset.act === 'permit' || act.dataset.act === 'refuse') {
      // From the panel the desk is ui.open; from the queue the row names it.
      if (act.dataset.channel && act.dataset.agent && !ui.open) ui.open = { channel: act.dataset.channel, agent: act.dataset.agent };
      else if (act.dataset.channel && act.dataset.agent) ui.open = { channel: act.dataset.channel, agent: act.dataset.agent };
      // Hold the buttons while it is in flight. Clicking again cannot help,
      // and a prompt that looks unresponsive invites exactly that.
      const pair = act.parentElement?.querySelectorAll('[data-act="permit"],[data-act="refuse"]') ?? [act];
      for (const b of pair) b.disabled = true;
      try {
        await decide(act.dataset.request, act.dataset.act === 'permit' ? 'allow' : 'deny');
      } finally {
        for (const b of pair) b.disabled = false;
      }
    } else if (act.dataset.act === 'stop') {
      await interruptDesk();
    } else if (act.dataset.act === 'handback') {
      await handBack(act);
    } else if (act.dataset.act === 'rename' && ui.open) {
      const next = prompt('Who sits here?', act.textContent.trim());
      if (!next || !next.trim()) return;
      await fetch('./api/floor/persona', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...ui.open, persona: next.trim() }),
      });
      tick();
    }
  });


  /** A short note on the send button, then back to normal. */
  function flash(btn, text, ms = 2600) {
    if (!btn) return;
    const was = btn.dataset.label ?? btn.textContent;
    btn.dataset.label = was;
    btn.textContent = text;
    setTimeout(() => { btn.textContent = was; }, ms);
  }

  /**
   * Send: a user turn in the hosted session. The server refuses, with the
   * reason, if nothing is there to receive it — and the reason is shown, not a
   * generic failure, because "the host is offline" is something the person can
   * act on and "failed" is not.
   */
  async function sendChat() {
    const text = $('p-text')?.value ?? '';
    const btn = document.querySelector('#floor-panel [data-act="send"]');
    if (!text.trim() || !btn || !ui.open || btn.disabled) return;
    btn.disabled = true;
    try {
      const r = await fetch('./api/floor/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...ui.open, text }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? `send failed (${r.status})`);
      // Accepted by the board is not the same as in the conversation, so it
      // shows as sending until the window itself reports it.
      ui.sending = ui.sending.concat([{ text, at: Date.now() }]);
      $('p-text').value = '';
      ui.stick = true;
      renderPanel();
      await tick();
    } catch (err) {
      flash(btn, String(err.message).slice(0, 60));
    } finally {
      btn.disabled = false;
      $('p-text')?.focus();
    }
  }

  async function decide(requestId, decision) {
    if (!ui.open || !requestId) return;
    const r = await fetch('./api/floor/permission', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...ui.open, request_id: requestId, decision }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      alert(body.error ?? `That didn't work (${r.status}).`);
    }
    tick();
  }

  /**
   * Move the open desk's conversation into the editor.
   *
   * The host closes its own window before opening it there, so the
   * conversation is never live in two places. Nothing is sent — this is a
   * change of seat, not a message.
   */
  async function handBack(btn) {
    if (!ui.open) return;
    btn.disabled = true;
    try {
      const r = await fetch('./api/floor/handback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(ui.open),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        flash(btn, String(body.error ?? `couldn't move it (${r.status})`).slice(0, 60));
      }
    } finally {
      btn.disabled = false;
      tick();
    }
  }

  async function interruptDesk() {
    if (!ui.open) return;
    await fetch('./api/floor/interrupt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ui.open),
    });
    tick();
  }

  document.addEventListener('keydown', (e) => {
    if (!ui.on) return;
    // Enter sends; Shift+Enter is a newline, the way every chat box works.
    if (e.target?.id === 'p-text' && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChat();
      return;
    }
    if (e.key === 'Escape' && ui.open) {
      ui.open = null;
      render();
    }
    const deskEl = document.activeElement?.closest?.('svg.room .desk');
    if (deskEl && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      openDesk(deskEl.dataset.channel, deskEl.dataset.agent);
    }
  });

  /* ---------- view switch ---------- */

  function setView(view) {
    ui.on = view === 'floor';
    document.body.classList.toggle('view-floor', ui.on);
    for (const b of document.querySelectorAll('#view-switch .chip')) {
      b.classList.toggle('on', b.dataset.view === view);
    }
    try { localStorage.setItem('orch.view', view); } catch { /* not worth failing over */ }
    if (ui.on) start(); else stop();
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('#view-switch .chip');
    if (b) setView(b.dataset.view);
  });

  try { ui.floorFilter = localStorage.getItem('orch.floor') || null; } catch { /* default: all floors */ }
  let initial = 'board';
  try { initial = localStorage.getItem('orch.view') === 'floor' ? 'floor' : 'board'; } catch { /* default */ }
  setView(initial);
})();
