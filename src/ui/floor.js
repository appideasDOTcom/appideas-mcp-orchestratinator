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
  /* The header band behind the channel name and the stat line under it. HEAD_H,
     which is what actually pushes the desks down, is derived from this further
     down — it has to clear a speech bubble as well as the band. */
  const HEAD_BAND = 60;
  const DESK_W = 168;
  const GAP = 30;
  /* One width for every floor: a full row of desks, whatever the room holds.
     ROOM_MAX_W is that same width on screen — the 1.25 was the ceiling a room
     was allowed to stretch to, and pinning it makes every floor render the size
     a full one always did rather than shrinking them all to fit the narrowest. */
  const ROOM_W = PAD * 2 + COLS * DESK_W + (COLS - 1) * GAP;   // 620
  const ROOM_MAX_W = Math.round(ROOM_W * 1.25);                // 775
  /* Bubble sizing. These three numbers are related and have to stay that way:
     a character budget picked independently of the box width is how you get a
     sentence painted straight across the desk next door. Everything is derived
     from BUBBLE_W and the font size the stylesheet uses. */
  const BUBBLE_W = 158;          // hard ceiling, a shade under DESK_W + GAP
  const CHAR_W = 5.4;            // ≈ average advance at the 10.5px bubble font
  const BUBBLE_LINES = 2;
  const BUBBLE_LINE = 13;        // line box, a shade over the 10.5px font
  /* Box edge to the text, and the same figure top and bottom. It was not: the
     height was `lines * 13 + 8` against a first baseline of 17, which works out
     to about 7 above the text and well under 1 below it, so every bubble sat
     high in its own box. Both margins now come from this one number. */
  const BUBBLE_PAD = 8;
  const BUBBLE_LIFT = 4;         // bubble's bottom edge to the desk origin
  /* The text's own box at the bubble font, as the browser reports it: ascent
     above the baseline, descent below, both constant per line whatever the words
     are. Measured, not assumed — the first attempt derived the baseline from
     half the leading plus a guessed ascent and produced 7.2 above the text
     against 9.0 below, which is the same lopsidedness BUBBLE_PAD exists to fix.
     With these, both margins are BUBBLE_PAD by arithmetic rather than by luck. */
  const BUBBLE_ASCENT = 10.4;
  const BUBBLE_DESCENT = 2.4;
  /** How tall a bubble holding n lines is: the text's box, plus BUBBLE_PAD both sides. */
  function bubbleHeight(n) {
    return BUBBLE_PAD * 2 + BUBBLE_ASCENT + BUBBLE_DESCENT + (n - 1) * BUBBLE_LINE;
  }
  const PER_LINE = Math.floor((BUBBLE_W - 16) / CHAR_W);

  /* The desk front is the sign, and the tray of counts sits under the plate.

     The counter carries one thing: what this agent last said it was doing. It
     turns when that changes and at no other time — a bus blind rolls when the
     route changes, not on a clock.

     That is the whole point, and it was worth rebuilding to get: motion here
     MEANS something. An earlier version cycled through three cards every few
     seconds, which looked alive and told you nothing — every desk was always
     moving, so a desk that had just changed looked exactly like one that had
     not. Now a blind that turns is a status that changed, catchable from
     across the room, and a still floor is a floor where nothing has happened.
     It also leaves the `!` badge as the only other thing that moves, which is
     the one thing that must never be missed.

     Everything else the board shows about an agent — presence, last action,
     the counts, when a status stops being believable — lives in the popover
     off the nameplate, because it is reference material rather than news.

     Putting the sign on the counter rather than in a panel below the nameplate
     costs no height at all: the slab was already drawn there, and it grows
     downward, so it occludes no more of the person than before. */
  const SIGN_LINE = 12;
  const SIGN_LINES = 3;
  // The desk is a frame around the sign, and the frame is the same thickness on
  // all four sides. An even border is most of what makes a panel read as a sign
  // mounted on something rather than as text lying on a slab — uneven margins
  // read as an accident of layout, which is exactly what they were.
  const FRAME = 7;
  const SIGN_PAD = 6;                       // sign edge to the words
  const FACE_W = 150;
  const FACE_X = (DESK_W - FACE_W) / 2;
  const FACE_Y = 62;
  const SIGN_W = FACE_W - FRAME * 2;
  const SIGN_H = SIGN_LINES * SIGN_LINE + SIGN_PAD * 2;
  const FACE_H = SIGN_H + FRAME * 2;
  const SIGN_CHARS = Math.floor((SIGN_W - SIGN_PAD * 2) / CHAR_W);

  // The stitch: the seam between two messages on one blind. Real roller blinds
  // are a loop of fabric joined at a seam, and the seam is what you actually
  // catch out of the corner of your eye — the words are too small to register
  // at that distance, a thick bar sweeping past is not.
  const BAR_H = 6;
  const CARD_STEP = SIGN_H + BAR_H;

  const PLATE_Y = FACE_Y + FACE_H + 14;     // nameplate, below the counter
  const PILL_H = 17;
  const PILL_Y = PLATE_Y + 23;
  // How long a just-changed sign keeps the old card on the strip. Covers the
  // CSS transition with margin, so a room rebuilt mid-turn still shows the
  // roll rather than snapping to the new card.
  const ROLL_SETTLE_MS = 900;

  /** How far a desk draws below its origin: counter, nameplate, pill tray. */
  const DESK_BELOW = PILL_Y + PILL_H + 4;

  // Row pitch has to clear both what a desk draws below its origin and the
  // bubble the next row down hangs above its own, or a second-row desk with two
  // lines of speech lands on the tray of the desk above it.
  //
  // Derived rather than a constant because it stopped being safe as a constant:
  // it was 150 when a desk drew 126 below the origin, and the sign moving onto
  // the counter pushed that past 150 without anything on screen saying so — the
  // second row simply had no bubble on the day. Tie it to the two numbers it
  // actually depends on and it cannot drift again.
  const BUBBLE_ABOVE = bubbleHeight(BUBBLE_LINES) + BUBBLE_LIFT;
  const DESK_H = DESK_BELOW + BUBBLE_ABOVE - GAP + 8;

  /* How far the first row of desks sits below the top of the room.
     Derived for exactly the reason DESK_H above is. It was a hand-picked 52,
     commented "clears a two-line bubble hanging above the first row" — and it
     did, until the header grew a second line for the board's stat line and the
     bubble was back inside the band with nothing on screen saying the constant
     had stopped being true. Tied to the band and the bubble, it cannot drift
     again: whatever the header comes to hold, the desks move to clear it. */
  const HEAD_AIR = 6;                    // band to bubble, so they never just touch
  const HEAD_H = HEAD_BAND + HEAD_AIR + BUBBLE_ABOVE - PAD;

  /* The desk's monitor.
     ---------------------
     36 x 20 units of glass, which is about 45 x 25 CSS pixels — far too small to
     read, and meant to be. Commands used to be the bubble's job, where they were
     legible and mostly noise: an operator does not need to read `Bash: grep -rn
     ...` off a desk when the chat panel behind it has the whole thing. What they
     do want from across the room is to see that something is happening. So the
     commands moved here, where being illegible is the point.

     Every number below is screen-local — the glass is a nested <svg>, so (0,0)
     is its top-left corner and anything past its edges is clipped away. */
  const SCREEN_X = 103;
  const SCREEN_Y = 39;
  const SCREEN_W = 36;
  const SCREEN_H = 20;
  const SCREEN_LINES = 4;
  const SCREEN_PAD = 1.4;
  const SCREEN_LINE = (SCREEN_H - SCREEN_PAD * 2) / SCREEN_LINES;
  const SCREEN_ASCENT = 3.1;     // baseline inside a line box at the screen font
  /* How much of a command gets typed. About 16 characters fit across the glass,
     so the tail of this runs off the right edge and is clipped — which is what a
     terminal actually looks like, and is why the budget is bigger than the glass
     rather than trimmed to it. */
  const SCREEN_CHARS = 22;
  const SCREEN_TICK_MS = 45;     // one character per tick: ~1s to type a line

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
    // What each desk's sign last said, kept outside the DOM because the DOM is
    // rebuilt wholesale and would otherwise forget the previous message — and
    // the previous message is the only thing that makes a turn possible.
    sign: new Map(),
    details: null,       // { channel, agent } whose nameplate popover is open
    // How far each storey is scrolled, in whole desks, keyed by channel.
    // Outside the DOM because rooms are rebuilt wholesale — the scroll
    // position has to outlive the nodes that were showing it.
    scroll: {},
    // What each desk's monitor is part-way through typing, keyed by desk. Kept
    // out of the DOM for the same reason `sign` is: rooms are rebuilt wholesale
    // on every poll that changes anything, and a half-typed line living in a
    // text node would be thrown away several times a second.
    screens: new Map(),
    typer: null,         // the interval driving all of them
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

  /**
   * What one desk's sign currently says.
   *
   * The detail line if the agent gave one, because that is the whole point of
   * it bothering to call `set_status`; the label it filed that under
   * otherwise. Deliberately carries no age: an age ticks, and a sign that
   * turned every minute because a number moved would destroy the only thing
   * that makes this sign readable — that it turns when something happened.
   * The age lives in the popover, where it can tick harmlessly.
   */
  function signCard(d) {
    const b = d.board;
    if (!b?.state) return null;
    const text = b.state.detail || b.state.label;
    if (!text) return null;
    const lines = wrap(text, SIGN_CHARS, SIGN_LINES);
    if (!lines.length) return null;
    return { kind: b.state.source === 'reported' ? 'state' : 'derived', text, lines };
  }

  const rollKey = (channel, agent) => `${channel}|${agent}`;

  const clock = (t) => {
    if (!t) return '';
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  /**
   * The nameplate popover: everything the board says about this agent that the
   * counter deliberately does not.
   *
   * The split is news versus reference. The sign carries the one fact that
   * changes and is worth catching from across the room; this carries the rest —
   * how we are hearing from the agent, when its claim about itself stops being
   * believable, what it is holding. None of it is worth a desk turning for, and
   * all of it is worth being one click away.
   */
  function detailsHtml(d, channel) {
    const b = d.board;
    const bits = [];
    const row = (k, v, cls = '') =>
      bits.push(`<div class="dp-row"><span class="dp-k">${esc(k)}</span><span class="dp-v ${cls}">${v}</span></div>`);

    if (!b) {
      row('board', '<span class="dp-none">this desk has never called an MCP tool</span>');
    } else {
      // Two different presences, named so nobody has to guess which is which.
      row('mcp', `${esc(b.presence)}${b.sessions > 1 ? ` ×${b.sessions}` : ''}` +
        (b.last_seen ? ` <span class="dp-dim">· seen ${esc(ago(b.last_seen))}</span>` : ''));

      if (b.state.source === 'reported') {
        row('status', `${esc(b.state.label)} <span class="dp-dim">· said ${esc(ago(b.reported_at))} ago</span>`);
        // The one fact the sign cannot show: when to stop believing it.
        if (b.reported_expires_at) {
          row('believed until', `<span class="dp-dim">${esc(clock(b.reported_expires_at))}</span>`);
        }
      } else {
        row('status', `${esc(b.state.label)} <span class="dp-dim">· derived</span>`);
        row('', '<span class="dp-none">nothing self-reported — read off the task board</span>');
      }
      if (b.state.detail) row('detail', `<span class="dp-detail">${esc(b.state.detail)}</span>`);
      if (b.last_action) row('last call', `${esc(b.last_action)} <span class="dp-dim">· ${esc(ago(b.last_action_at))} ago</span>`);

      const counts = [];
      if (b.unread) counts.push(`✉ ${b.unread} unread`);
      if (b.assigned_open) counts.push(`☰ ${b.assigned_open} assigned`);
      if (b.claimed_tasks?.length) counts.push(`☑ ${b.claimed_tasks.length} claimed`);
      row('holding', counts.length ? esc(counts.join('  ·  ')) : '<span class="dp-none">nothing</span>');
    }

    const s = d.session ?? {};
    const where = d.hosted
      ? (d.hosted.live ? `hosted on ${d.hosted.host}` : `host ${d.hosted.host} offline`)
      : d.live ? 'reporting' : d.reporting ? 'away' : 'never reported';
    row('window', `${esc(s.window ?? d.hosted?.window ?? '—')} <span class="dp-dim">· ${esc(where)}</span>`);
    if (s.git_branch) row('branch', `<span class="dp-dim">${esc(s.git_branch)}</span>`);

    // A button, not a sentence. The sentence said "click the desk", which became
    // the wrong instruction the moment the desk started opening this card — and
    // was ambiguous even before that, because "the desk" means the counter to a
    // reader and the whole cell to this file.
    // Name, then the id under it, then the way in. Stacked rather than laid out
    // across one line: a hover-only pencil beside the name was discoverable
    // only by people who already knew it was there, and this card is the first
    // thing an operator opens when they want to know who a desk is.
    return `<div class="dp-head">` +
      `<strong>${esc(d.persona)}</strong>` +
      `<span class="dp-dim mono">${esc(channel)}/${esc(d.agent)}</span>` +
      `<button type="button" class="dp-open" data-act="rename"` +
      ` data-channel="${esc(channel)}" data-agent="${esc(d.agent)}">Edit avatar</button>` +
      `</div>${bits.join('')}` +
      `<div class="dp-foot"><button type="button" class="dp-open" data-act="open"` +
      ` data-channel="${esc(channel)}" data-agent="${esc(d.agent)}">Open conversation</button></div>`;
  }

  /** Draw, move or remove the popover to match `ui.details`. */
  function renderDetails() {
    let pop = document.getElementById('desk-pop');
    if (!ui.details) { pop?.remove(); return; }
    const c = floor.channels.find((x) => x.channel === ui.details.channel);
    const d = c?.desks.find((x) => x.agent === ui.details.agent);
    // A desk can vanish under an open popover — retired, or its channel
    // archived. Close rather than leave a card describing something that is no
    // longer on the floor.
    if (!d) { ui.details = null; pop?.remove(); return; }

    if (!pop) {
      pop = document.createElement('div');
      pop.id = 'desk-pop';
      document.body.appendChild(pop);
    }
    pop.innerHTML = detailsHtml(d, ui.details.channel);

    // Anchored to where the nameplate was when it was clicked, not to the live
    // element: rooms are rebuilt wholesale, so that element is already gone.
    const r = ui.detailsRect;
    if (!r) return;
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8));
    const below = r.bottom + 8;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 8) : below;
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
  }

  /** The counts the board puts in the same row, as a tray of buttons. */
  function signPills(d) {
    const b = d.board;
    if (!b) return [];
    const pills = [];
    if (b.unread) {
      pills.push({
        act: 'unread', cls: 'unread', mark: '✉', n: b.unread,
        title: `${b.unread} unread — mark ${d.agent}'s backlog read on its behalf`,
      });
    }
    if (b.assigned_open) {
      pills.push({
        act: 'tasks', kind: 'assigned', cls: 'tasks', mark: '☰', n: b.assigned_open,
        title: `${b.assigned_open} open task${b.assigned_open === 1 ? '' : 's'} assigned to ${d.agent}`,
      });
    }
    // Work this agent is actually holding. It earns a pill by the same test as
    // the other two — the operator can clear it — and the button already
    // existed: the task dialog filters on claimed_by as well as assignee. Until
    // this was drawn, a claimed task was visible only in the derived state
    // label, which a live self-reported status suppresses outright. An agent
    // dutifully calling set_status while holding three tasks showed nothing.
    const claimed = b.claimed_tasks?.length ?? 0;
    if (claimed) {
      pills.push({
        act: 'tasks', kind: 'claimed', cls: 'claimed', mark: '☑', n: claimed,
        title: `${d.agent} is holding ${claimed} claimed task${claimed === 1 ? '' : 's'}`,
      });
    }
    return pills;
  }

  /** A desk's state, in the one word the room is drawn from. */
  function deskState(d) {
    if (!d.live) return 'away';
    if (d.session?.awaiting_kind) return 'needs-you';
    if (d.hosted?.state === 'working' || d.last_turn?.role === 'tool') return 'working';
    return 'here';
  }

  /* ---------- drawing ---------- */

  /**
   * A floor is always the width of a *full* floor, whatever it happens to hold,
   * and a short row is left-aligned inside it.
   *
   * It used to size itself to its own occupancy, which made the same desk a
   * different size from one channel to the next — the floor trades on
   * recognising a person across the room, and that is spent the moment the
   * person changes size when you look at a different channel. In the building
   * view it also made the storeys ragged, and a building whose floors are
   * different widths is not a building.
   *
   * `collapsed` is the building view: one row, and the rest of the floor scrolls
   * past it.
   */
  function roomGeometry(n, collapsed) {
    const cols = COLS;
    const rows = collapsed ? 1 : Math.max(1, Math.ceil(Math.max(1, n) / cols));
    return {
      cols,
      rows,
      collapsed: !!collapsed,
      w: ROOM_W,
      // The last row contributes only what it draws below the desk origin (the
      // nameplate), not a whole cell — a full DESK_H there leaves every room
      // ending in a band of empty carpet that reads as "somebody is missing".
      h: PAD * 2 + HEAD_H + (rows - 1) * (DESK_H + GAP) + DESK_BELOW,
    };
  }

  /* ---------- the monitor ---------- */

  const screenKey = (channel, agent) => `${channel}|${agent}`;

  /** A command as one line of terminal: whitespace collapsed, tail trimmed. */
  const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, SCREEN_CHARS);

  /**
   * Hand a desk's monitor whatever it has not typed yet.
   *
   * Called from desk() on every rebuild, which is also every poll that changed
   * anything — so a command that has just landed is queued the moment the room
   * redraws. Ids are monotonic, so `since` is all the bookkeeping needed to tell
   * a new command from one already on the glass; a Set of seen ids would grow
   * for as long as the page is open.
   *
   * A desk that has stopped working loses its state entirely, which blanks the
   * screen and means the next spell of work starts from a clear one.
   */
  function feedScreen(k, commands, working) {
    if (!working) { ui.screens.delete(k); return null; }
    let st = ui.screens.get(k);
    if (!st) { st = { since: 0, queue: [], done: [], typing: '', full: '' }; ui.screens.set(k, st); }
    for (const c of commands ?? []) {
      if (c.id <= st.since) continue;
      st.since = c.id;
      const line = oneLine(c.text);
      if (line) st.queue.push(line);
    }
    return st;
  }

  /** One character on every monitor that still has something to say. */
  function typeTick() {
    let moved = false;
    for (const st of ui.screens.values()) {
      if (st.typing.length < st.full.length) {
        st.typing = st.full.slice(0, st.typing.length + 1);
        moved = true;
      } else if (st.queue.length) {
        // The finished line scrolls up and the oldest falls off the top.
        if (st.full) st.done.push(st.full);
        while (st.done.length > SCREEN_LINES - 1) st.done.shift();
        st.full = st.queue.shift();
        st.typing = '';
        moved = true;
      }
    }
    if (!moved) return;
    for (const el_ of document.querySelectorAll('#floor-rooms svg.room .desk')) {
      paintScreen(el_, ui.screens.get(screenKey(el_.dataset.channel, el_.dataset.agent)));
    }
  }

  /** Write a monitor's state onto its glass. No state means a blank screen. */
  function paintScreen(deskEl, st) {
    const rows = deskEl.querySelectorAll('.screenLine');
    const lines = st ? [...st.done, st.typing] : [];
    rows.forEach((row, i) => { row.textContent = lines[i] ?? ''; });
  }

  /** How many desks are scrolled off the left of a collapsed storey. */
  function maxScroll(n) { return Math.max(0, n - COLS); }

  /**
   * Point a storey at its remembered scroll offset and show only the arrows
   * that can still go somewhere.
   *
   * Applied rather than baked into the markup so an arrow click costs one
   * transform instead of a rebuild — rebuilding to scroll would drop :hover,
   * cancel the sign's roll animation and delete envelopes in flight.
   */
  function applyScroll(svg, n) {
    if (!svg?.classList.contains('collapsed')) return;
    const ch = svg.dataset.channel;
    const max = maxScroll(n);
    const off = Math.min(Math.max(0, ui.scroll[ch] ?? 0), max);
    ui.scroll[ch] = off;
    svg.querySelector('.deskTrack')?.setAttribute('transform', `translate(${-off * (DESK_W + GAP)} 0)`);
    const arrow = (dir) => svg.querySelector(`.deskArrow.${dir}`);
    arrow('left')?.classList.toggle('spent', off <= 0);
    arrow('right')?.classList.toggle('spent', off >= max);
  }

  /**
   * The three dots that make a speech bubble a *thought* bubble.
   *
   * They replace the tail triangle. A tail says the words were spoken; dots
   * trailing toward the head say they are being thought, which is what a desk's
   * counter actually reports — the last thing this agent was doing, not
   * something it said to anybody.
   *
   * They run down the bubble's *left* and curve in to the head, on the side away
   * from the monitor. The first attempt dropped them straight down from the
   * middle, and there is only 18 units of clear air between the bubble's
   * underside and the top of the head — three dots in that gap have to be tiny
   * to fit, which is exactly how they read. The person's left is empty desk all
   * the way down, so going that way buys the length that lets them be seen.
   *
   * Laid out in desk space, where the fixed landmarks are, then converted: the
   * person sits at translate(66 22) with the head a circle at (0 4) r 12, so the
   * head occupies desk x 54..78 centred on (66, 26), and the monitor is
   * everything to the right of it. The bubble is centred at x 84 with its
   * underside at y -BUBBLE_LIFT whatever it holds.
   */
  const DOT_R = [6.8, 4.8, 3.2];  // biggest at the bubble, smallest at the head
  const DOT_INSET = 9;            // bubble's left edge to the first dot's centre
  const DOT_GAP = 1;              // clear air under the bubble, so they do not touch
  /* The furthest right the first dot may start, and with it the narrowest a
     bubble is allowed to be — because the trail's room comes from the box's left
     edge, not from the text. A box that shrink-wrapped a two-word status put its
     left edge almost over the head, and the three dots piled up on each other
     with 13 units of run between them where they need about 26. The minimum is
     derived from the trail rather than chosen, so raising a dot's radius cannot
     quietly reintroduce the overlap. */
  const DOT_FIRST_X = 28;
  const BUBBLE_MIN_W = (84 - (DOT_FIRST_X - DOT_INSET)) * 2;   // 130
  // Beside the head's upper-left rather than above it, and standing off it: the
  // last dot used to land 0.3 units from the head, which at a glance is touching.
  const DOT_HEAD = { x: 51, y: 16 };
  /* How far the trail sags off the straight line between bubble and head. The
     middle dot lands half of this off the chord, so 9 buys about 4.5 units of
     arc — the previous version interpolated the middle dot at fixed fractions
     (0.55 across, 0.62 down) which put it 0.9 units off the line, and 0.9 units
     over a 38-unit run is a straight line as far as the eye is concerned. */
  const DOT_BOW = 9;

  /**
   * One cycle of the dot animation, in ms — read from the stylesheet, which owns
   * it, and cached because it cannot change for the life of the page.
   */
  let thoughtMs = null;
  function thoughtPeriod() {
    if (thoughtMs === null) {
      const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--thought-ms'));
      thoughtMs = Number.isFinite(v) && v > 0 ? v : 1600;
    }
    return thoughtMs;
  }

  function thoughtDots(w, h) {
    // The group is translated to (84, -h - BUBBLE_LIFT), so this is the inverse.
    const toBubble = (p) => ({ x: p.x - 84, y: p.y + h + BUBBLE_LIFT });
    const first = {
      // Never right of DOT_FIRST_X. BUBBLE_MIN_W guarantees the box reaches at
      // least that far left, so the dot is always under it, never floating.
      x: Math.min(84 - w / 2 + DOT_INSET, DOT_FIRST_X),
      y: -BUBBLE_LIFT + DOT_R[0] + DOT_GAP,
    };
    const last = DOT_HEAD;
    // A real quadratic rather than a nudged straight line: the control point is
    // the chord's midpoint pushed out along the chord's normal, so the trail
    // bows consistently whatever the bubble's width does to the chord.
    const dx = last.x - first.x;
    const dy = last.y - first.y;
    const len = Math.hypot(dx, dy) || 1;
    const ctrl = {
      x: (first.x + last.x) / 2 - (dy / len) * DOT_BOW,
      y: (first.y + last.y) / 2 + (dx / len) * DOT_BOW,
    };
    const at = (t) => ({
      x: (1 - t) ** 2 * first.x + 2 * (1 - t) * t * ctrl.x + t ** 2 * last.x,
      y: (1 - t) ** 2 * first.y + 2 * (1 - t) * t * ctrl.y + t ** 2 * last.y,
    });
    const g = el('g', { class: 'thought' });
    // Where the shared cycle is right now, as a negative delay. Set on the group
    // so it inherits to all three circles, and so a room rebuilt mid-cycle
    // resumes rather than restarting — see the note in styles.css.
    const period = thoughtPeriod();
    g.style.setProperty('--thought-phase', `${-(Date.now() % period)}ms`);
    [at(0), at(0.5), at(1)].forEach((p, i) => {
      const q = toBubble(p);
      g.appendChild(el('circle', {
        cx: +q.x.toFixed(2), cy: +q.y.toFixed(2), r: DOT_R[i], class: 'thoughtDot',
      }));
    });
    return g;
  }

  /**
   * "2 open · 2 claimed · 1 done · 0 contracts · 5 msgs" — the board's line.
   *
   * One <text> of tspans rather than five positioned elements: the numbers vary
   * in width, and anything laid out by hand goes ragged the moment a count
   * reaches double digits.
   */
  function statLine(stats, x, y) {
    const s = stats ?? {};
    const parts = [
      [s.open ?? 0, 'open'], [s.claimed ?? 0, 'claimed'], [s.done ?? 0, 'done'],
      [s.contracts ?? 0, 'contracts'], [s.messages ?? 0, 'msgs'],
    ];
    const t = el('text', { x, y, class: 'roomStat' });
    parts.forEach(([n, word], i) => {
      if (i) t.appendChild(el('tspan')).textContent = ' · ';
      t.appendChild(el('tspan', { class: 'roomStatN' })).textContent = String(n);
      t.appendChild(el('tspan')).textContent = ` ${word}`;
    });
    return t;
  }

  /** One scroll arrow, sitting in the floor's own left or right margin. */
  function scrollArrow(dir, geo) {
    const cx = dir === 'left' ? 15 : geo.w - 15;
    const cy = PAD + HEAD_H + DESK_BELOW / 2;
    const g = el('g', { class: `deskArrow ${dir}`, 'data-scroll': dir, role: 'button', tabindex: '0' });
    g.appendChild(el('title')).textContent = dir === 'left' ? 'Earlier desks' : 'More desks';
    g.appendChild(el('circle', { cx, cy, r: 13, class: 'arrowChip' }));
    const tip = dir === 'left' ? cx - 3.5 : cx + 3.5;
    const tail = dir === 'left' ? cx + 3 : cx - 3;
    g.appendChild(el('path', { d: `M ${tail} ${cy - 5} L ${tip} ${cy} L ${tail} ${cy + 5}`, class: 'arrowGlyph' }));
    return g;
  }

  function deskXY(i, geo) {
    // A collapsed storey never wraps: the fourth desk runs off to the right and
    // is reached with an arrow, which is the whole point of collapsing it.
    const col = geo.collapsed ? i : i % geo.cols;
    const row = geo.collapsed ? 0 : Math.floor(i / geo.cols);
    return {
      x: PAD + col * (DESK_W + GAP),
      y: PAD + HEAD_H + row * (DESK_H + GAP),
    };
  }

  /**
   * Hair, which is the whole of the difference between one avatar and another.
   *
   * Two layers, because the head circle sits between them: `back` is drawn
   * before the head and `front` after it. That ordering is what makes this
   * cheap — the head covers the middle of the back shape, so the silhouette
   * needs no face cut out of it and there is not a clip path or a mask
   * anywhere. Long hair also has to fall *over* the shoulders, and the body is
   * already drawn by then, so back-hair lands in the right place for free.
   *
   * Head is a circle at (0, 4) with r 12; the body starts at y 18. Every number
   * below is in that space.
   */
  const HAIR = {
    neutral: null,
    // A short cut: a cap over the crown, its lower edge swept across to one
    // side. Asymmetry is the only thing that reads as a *style* at this size —
    // a symmetric cap just looks like a darker head.
    male: {
      back: null,
      // Both ends of the arc sit *on* the head circle (r 12 about 0,4), which is
      // what keeps the hairline flush. Ending short of it leaves a sliver of
      // head above the hair that reads as a rendering fault, and closing the
      // path back past the edge leaves a spur — two shapes tried before this.
      front: 'M -11.8 6 A 12 12 0 0 1 11.3 0 C 4 4 -3 2 -11.8 6 Z',
    },
    // Long hair, as two pieces around the figure rather than one on top of it.
    //
    // The back is a plain dome and carries no face cut-out at all: the head is
    // drawn over its middle, so carving one only opened a hole that showed the
    // room through the neck. It also sits *behind* the body, which is what
    // stops it covering the torso — the torso is the seat colour, and the seat
    // colour is how a desk stays recognisable, so hair must never paint over
    // it. What is left is hair spilling past the shoulders on both sides.
    female: {
      // No split in the silhouette. A gap between the locks would be the neck
      // on a real figure, but these have no neck — the head sits straight on
      // the shoulders — so the gap read as two pigtails instead. Splitting it
      // lower was tried and is invisible: the body covers that band anyway.
      back: 'M -14 24 C -16 6 -14 -6 0 -6 C 14 -6 16 6 14 24 Z',
      front: 'M -12 4 A 12 12 0 0 1 12 4 C 7 -5 -7 -5 -12 4 Z',
    },
  };

  /** A person: head, shoulders, and a chair back. Drawn rather than sprited so
   *  there is no asset licence anywhere in this repo and no build step to add. */
  function person(state, seat, d) {
    const g = el('g', { class: `person ${state}`, 'data-seat': seat });
    // Colours arrive already resolved and are handed to CSS as variables, so
    // the stylesheet still owns *how* the figure is painted (including what
    // happens when the desk is away) while the server owns *which* colours.
    g.style.setProperty('--shirt', d.shirt);
    g.style.setProperty('--hair', d.hair);
    g.style.setProperty('--skin', d.skin);
    const hair = HAIR[d.gender] ?? null;
    g.appendChild(el('ellipse', { cx: 0, cy: 46, rx: 26, ry: 6, class: 'shadow' }));
    // Behind the body on purpose — see the note on `female.back` above.
    if (hair?.back) g.appendChild(el('path', { d: hair.back, class: 'hair' }));
    g.appendChild(el('path', { d: 'M -20 44 q 0 -26 20 -26 q 20 0 20 26 z', class: 'body' }));
    g.appendChild(el('circle', { cx: 0, cy: 4, r: 12, class: 'head' }));
    if (hair?.front) g.appendChild(el('path', { d: hair.front, class: 'hair' }));
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
      // Everything the desk draws, not a fixed box: the pad exists so gaps
      // between the painted parts do not fall through to the floor behind, and
      // it can only do that if it actually reaches the bottom of the cell.
      x: 0, y: -46, width: DESK_W, height: DESK_BELOW + 46, class: 'deskHit',
    }));

    // Order matters and is the whole illusion: the person is drawn first so the
    // desk occludes them from the chest down, which is what "sitting at a desk"
    // looks like. Drawn the other way round they float in front of the monitor.
    const p = person(state, d.seat, d);
    p.setAttribute('transform', 'translate(66 22)');
    g.appendChild(p);

    // The counter. A nested <svg> so the blind is clipped by the counter's own
    // edges — no clipPath, and so no page-unique id to collide with, which
    // matters because rooms here are rebuilt wholesale.
    const card = signCard(d);
    const face = el('svg', {
      x: FACE_X, y: FACE_Y, width: FACE_W, height: FACE_H, class: 'face',
    });
    face.appendChild(el('rect', { x: 0, y: 0, width: FACE_W, height: FACE_H, rx: 5, class: 'deskTop' }));

    // The sign gets a viewport of its own, inset by the frame. That is what
    // makes the stitch vanish at the top of the message area rather than
    // sliding out under the desk's own border — the blind is clipped by the
    // sign it runs behind, exactly as the fabric is.
    const sign = el('svg', { x: FRAME, y: FRAME, width: SIGN_W, height: SIGN_H, class: 'sign' });
    sign.appendChild(el('rect', { x: 0, y: 0, width: SIGN_W, height: SIGN_H, rx: 2, class: 'signFace' }));
    if (card) {
      // Compare against what this sign last said. A change puts the old message
      // back on the strip above the new one so there is something to roll away
      // from — a blind with one panel cannot turn.
      const k = rollKey(channel, d.agent);
      const was = ui.sign.get(k);
      if (!was) ui.sign.set(k, { text: card.text, kind: card.kind, from: null, at: 0 });
      else if (was.text !== card.text) {
        ui.sign.set(k, { text: card.text, kind: card.kind, from: was.text, fromKind: was.kind, at: Date.now() });
      }
      const now = ui.sign.get(k);
      const turning = now.from != null && Date.now() - now.at < ROLL_SETTLE_MS;

      const strip = turning
        ? [{ kind: now.fromKind, lines: wrap(now.from, SIGN_CHARS, SIGN_LINES) }, card]
        : [card];
      const blind = el('g', { class: 'blind' });
      blind.style.transform = 'translateY(0px)';
      strip.forEach((c, ci) => {
        const cg = el('g', { class: `card ${c.kind}`, transform: `translate(0 ${ci * CARD_STEP})` });
        const top = (SIGN_H - c.lines.length * SIGN_LINE) / 2 + SIGN_LINE - 3;
        c.lines.forEach((line, li) => {
          const t = el('text', {
            x: SIGN_W / 2, y: top + li * SIGN_LINE, 'text-anchor': 'middle', class: 'signText',
          });
          t.textContent = line;
          cg.appendChild(t);
        });
        blind.appendChild(cg);
        // The seam sits in the gap after every card but the last, so it is
        // genuinely between two messages rather than painted over either. It
        // starts just below the viewport and ends just above it: by the time
        // the new message has settled the stitch has gone out of the top.
        if (ci < strip.length - 1) {
          blind.appendChild(el('rect', {
            x: 0, y: ci * CARD_STEP + SIGN_H, width: SIGN_W, height: BAR_H, class: 'stitch',
          }));
        }
      });
      sign.appendChild(blind);
      if (turning && now.played) {
        // The sweep already happened and the settle window has not closed yet.
        // Land on the new message without replaying it: a room rebuilt in that
        // gap would otherwise run the seam past a second time, for a change
        // that happened once.
        blind.style.transform = `translateY(${-CARD_STEP}px)`;
      } else if (turning) {
        now.played = true;
        // Two frames, not one: the strip has to be in the document and painted
        // at its old offset before the new offset can be a transition rather
        // than a starting value.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          blind.style.transform = `translateY(${-CARD_STEP}px)`;
        }));
      }
    }
    face.appendChild(sign);
    // On top of the words, exactly as on the nameplate: the sign's own text
    // would otherwise be what a click reports, and routing up from a glyph is
    // what sent clicks to the wrong place last time. One pad, one target.
    face.appendChild(el('rect', { x: 0, y: 0, width: FACE_W, height: FACE_H, class: 'faceHit' }));
    g.appendChild(face);

    // The monitor sits on the desk beside them and lights up only when something
    // is really running — it is the one piece of furniture carrying state.
    g.appendChild(el('rect', { x: 100, y: 36, width: 42, height: 28, rx: 3, class: 'monitor' }));
    // A nested <svg> so anything drawn on the screen is clipped by the screen's
    // own bounds — the same trick the counter's blind uses, and for the same
    // reason: a line of text longer than the glass has to run off the edge, not
    // across the desk. Its contents are in screen-local coordinates.
    const glass = el('svg', { x: SCREEN_X, y: SCREEN_Y, width: SCREEN_W, height: SCREEN_H, class: 'glass' });
    glass.appendChild(el('rect', { x: 0, y: 0, width: SCREEN_W, height: SCREEN_H, rx: 2, class: 'screen' }));
    const feed = el('g', { class: 'screenText' });
    for (let i = 0; i < SCREEN_LINES; i += 1) {
      feed.appendChild(el('text', { x: SCREEN_PAD, y: SCREEN_PAD + SCREEN_ASCENT + i * SCREEN_LINE, class: 'screenLine' }));
    }
    glass.appendChild(feed);
    g.appendChild(glass);
    // Paint straight away rather than waiting for the next tick: this node was
    // created a moment ago by a rebuild, and a blank frame between rebuilds is
    // the flicker the state exists to avoid.
    paintScreen(g, feedScreen(screenKey(channel, d.agent), d.commands, state === 'working'));

    // Nameplate. The persona leads because that is what people will say out
    // loud; the real agent name follows because that is what the .mcp.json says
    // and someone will eventually need to match the two up.
    const plate = el('g', {
      class: 'plate',
      transform: `translate(84 ${PLATE_Y})`,
      'data-act': 'details',
      'data-channel': channel,
      'data-agent': d.agent,
      role: 'button',
      tabindex: '0',
    });
    const name = el('text', { x: 0, y: 0, class: 'plateName', 'text-anchor': 'middle' });
    name.textContent = d.persona;
    plate.appendChild(name);
    // A desk the board knows but no window has ever reported from says so on
    // its nameplate — it is the difference between "stepped away" and "never
    // installed the plugin", and only one of those is something to go fix.
    const role = el('text', { x: 0, y: 15, class: 'plateRole', 'text-anchor': 'middle' });
    role.textContent = d.hosted
      ? `${d.agent} · ${d.hosted.live ? 'ready' : 'host offline'}`
      : d.reporting ? d.agent : `${d.agent} · not reporting`;
    plate.appendChild(role);
    // The pad goes LAST, so it lies over the words rather than behind them.
    //
    // Behind them, every click had to be routed by walking up from whatever it
    // landed on, and a click on a glyph reported the glyph. That worked here
    // and did not on the machine that matters, where hitting the words opened
    // the conversation and only the margin around them opened this card. On
    // top, the pad is the only thing in the plate that can be hit at all, so
    // there is no walk to get wrong — the whole nameplate is one target.
    // Transparent fill is still painted, so it takes the click; the words are
    // still readable through it, and `.plate:hover` still lights them.
    plate.appendChild(el('rect', { x: -74, y: -13, width: 148, height: 34, class: 'plateHit' }));
    g.appendChild(plate);

    // The tray. These are buttons, not labels — they open the board's own
    // dialogs, which is the whole reason a count here and a count there can
    // never come to mean different things.
    const pills = signPills(d);
    if (pills.length) {
      const width = (q) => `${q.mark} ${q.n}`.length * 6 + 12;
      const total = pills.reduce((sum, q) => sum + width(q), 0) + (pills.length - 1) * 6;
      let px = (DESK_W - total) / 2;
      for (const q of pills) {
        const w = width(q);
        const pg = el('g', {
          class: `pill ${q.cls}`,
          transform: `translate(${px} ${PILL_Y})`,
          'data-act': q.act,
          'data-kind': q.kind ?? null,
          'data-channel': channel,
          'data-agent': d.agent,
          role: 'button',
          tabindex: '0',
        });
        pg.appendChild(el('rect', { x: 0, y: 0, width: w, height: PILL_H, rx: PILL_H / 2, class: 'pillBox' }));
        const pt = el('text', { x: w / 2, y: PILL_H / 2 + 4, 'text-anchor': 'middle', class: 'pillText' });
        pt.textContent = `${q.mark} ${q.n}`;
        pg.appendChild(pt);
        const tip = el('title');
        tip.textContent = q.title;
        pg.appendChild(tip);
        g.appendChild(pg);
        px += w + 6;
      }
    }

    // What this agent last SAID, wrapped to a box that cannot reach the desk next
    // door. Deliberately not the last *turn*: that is usually a tool call, so
    // the bubble spent most of its life reading "Bash: grep -rn ..." — the one
    // thing the chat panel behind it already shows in full, and the thing an
    // operator is least likely to need at a glance. It also meant the bubble
    // changed on every tool call, which is many times a minute. Commands have
    // their own home now: the monitor types them out (see screenLines).
    if (d.last_message) {
      const lines = wrap(d.last_message.text, PER_LINE, BUBBLE_LINES);
      if (lines.length) {
        const w = Math.min(BUBBLE_W, Math.max(BUBBLE_MIN_W, Math.max(...lines.map((l) => l.length)) * CHAR_W + 16));
        const h = bubbleHeight(lines.length);
        const b = el('g', { class: 'bubble', transform: `translate(84 ${-h - BUBBLE_LIFT})` });
        b.appendChild(el('rect', { x: -w / 2, y: 0, width: w, height: h, rx: 8, class: 'bubbleBox' }));
        lines.forEach((line, li) => {
          const t = el('text', {
            x: 0, y: BUBBLE_PAD + BUBBLE_ASCENT + li * BUBBLE_LINE,
            class: 'bubbleText', 'text-anchor': 'middle',
          });
          t.textContent = line;
          b.appendChild(t);
        });
        b.appendChild(thoughtDots(w, h));
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

  let clipSeq = 0;

  /**
   * Is the floor being drawn as a building?
   *
   * Only with two or more channels, and for the same reason the floor picker
   * appears only then: one storey is not a building, and collapsing it would
   * hide desks behind a scroll arrow with no chip anywhere offering the way
   * back out.
   */
  function inBuilding() { return !ui.floorFilter && (floor.channels?.length ?? 0) > 1; }

  function room(c) {
    const collapsed = inBuilding();
    const geo = roomGeometry(c.desks.length, collapsed);
    const svg = el('svg', {
      class: `room${collapsed ? ' collapsed' : ''}`,
      viewBox: `0 0 ${geo.w} ${geo.h}`,
      preserveAspectRatio: 'xMidYMin meet',
      'data-channel': c.channel,
      // Rooms fill the width they are given, but only up to a point. A two-desk
      // channel stretched across a wide monitor turns furniture into billboards
      // and makes the same desk look different from room to room, which is
      // exactly the recognisability the floor is trading on.
      style: `max-width:${ROOM_MAX_W}px`,
    });

    svg.appendChild(el('rect', { x: 0, y: 0, width: geo.w, height: geo.h, rx: 12, class: 'roomFloor' }));
    svg.appendChild(el('rect', { x: 0, y: 0, width: geo.w, height: HEAD_BAND, rx: 12, class: 'roomWall' }));

    const label = el('text', { x: PAD - 6, y: 23, class: 'roomName' });
    label.textContent = c.channel;
    svg.appendChild(label);

    // The board's channel-header line, verbatim, under the name and on the same
    // left edge. Same numbers from the same helper (agent-state's
    // channelCounts) — the point of showing it here is that an operator who
    // knows the board's line can read a storey without relearning anything.
    svg.appendChild(statLine(c.stats, PAD - 6, 41));

    const meta = el('text', { x: geo.w - PAD + 6, y: 23, class: 'roomMeta', 'text-anchor': 'end' });
    meta.textContent = `${c.live}/${c.desks.length} here${c.awaiting ? ` · ${c.awaiting} need you` : ''}`;
    svg.appendChild(meta);

    // Envelopes are appended to this layer so they sit above the furniture and
    // can be removed without touching anything that was drawn from data.
    const mail = el('g', { class: 'mailLayer' });

    // Desks and mail ride the same group, so a scrolled storey carries its
    // envelopes with it. deskXY() coordinates are track-local either way; in the
    // full-floor view the track simply never moves.
    const track = el('g', { class: 'deskTrack' });
    c.desks.forEach((d, i) => track.appendChild(desk(d, i, geo, c.channel)));
    track.appendChild(mail);

    if (!collapsed) {
      svg.appendChild(track);
      return svg;
    }

    // Clipped to the carpet between the margins, so a desk scrolling out goes
    // under the wall rather than sliding over the room's own edge. The SVG's
    // own overflow would hide everything past x=0, which leaves a desk drawn
    // across the left margin on its way out.
    const clipId = `deskclip-${++clipSeq}`;
    const defs = el('defs');
    const clip = el('clipPath', { id: clipId });
    clip.appendChild(el('rect', { x: PAD - 2, y: 0, width: geo.w - (PAD - 2) * 2, height: geo.h }));
    defs.appendChild(clip);
    svg.appendChild(defs);

    const win = el('g', { 'clip-path': `url(#${clipId})` });
    win.appendChild(track);
    svg.appendChild(win);

    // Both are drawn and applyScroll hides whichever has nowhere to go. Drawn
    // rather than conditional so scrolling never rebuilds the storey — see
    // applyScroll — and each is pinned to its own margin, so the one that stays
    // does not move when the other goes.
    svg.appendChild(scrollArrow('left', geo));
    svg.appendChild(scrollArrow('right', geo));
    applyScroll(svg, c.desks.length);
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
    // Ask the room how it is drawn rather than assuming — a collapsed storey is
    // one row, and laying an envelope out on a three-row grid it is not using
    // sends it to a desk that is not there.
    const geo = roomGeometry(c.desks.length, svg.classList.contains('collapsed'));
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
          <button class="p-persona" data-act="rename" data-channel="${esc(channel)}" data-agent="${esc(agent)}"
                  title="Rename — everyone sees the same name"></button>
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

    // Stacked floors are drawn inside a building; one floor on its own is just
    // that floor. The class carries the whole difference in the stylesheet.
    rooms.classList.toggle('building', inBuilding());

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
    // Ages and counts in the open card tick with everything else.
    renderDetails();
    $('floor-queue').innerHTML = queueHtml();
    const t = floor.totals ?? {};
    $('floor-totals').textContent =
      `${t.channels ?? 0} floor${t.channels === 1 ? '' : 's'} · ${t.desks ?? 0} desk${t.desks === 1 ? '' : 's'} · ${t.live ?? 0} here · ${t.awaiting ?? 0} need you`;
    renderPanel();
  }

  /** Ride to a floor, or back out to the building. */
  function setFloor(name) {
    ui.floorFilter = name || null;
    // The card is anchored to a desk that is about to be redrawn somewhere else.
    ui.details = null;
    try { localStorage.setItem('orch.floor', ui.floorFilter ?? ''); } catch { /* not worth failing over */ }
    render();
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
    // One typewriter for every monitor on the floor, rather than one each: the
    // work per tick is a string slice per working desk, and a timer per desk
    // would have to be torn down and rebuilt with the rooms.
    ui.typer = setInterval(typeTick, SCREEN_TICK_MS);
  }

  function stop() {
    clearInterval(ui.timer);
    ui.timer = null;
    clearInterval(ui.typer);
    ui.typer = null;
    ui.screens.clear();
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

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ui.details) { ui.details = null; renderDetails(); }
  });

  // The card is positioned against a rectangle captured at click time, so any
  // scroll leaves it pointing at nothing. Closing beats chasing.
  window.addEventListener('scroll', () => {
    if (ui.details) { ui.details = null; renderDetails(); }
  }, true);

  document.addEventListener('click', async (e) => {
    // The card's own clicks. Everything else inside it is text, so anything not
    // named here is deliberately swallowed rather than falling through to the
    // desk handlers underneath and re-opening the thing you clicked out of.
    if (e.target.closest?.('#desk-pop')) {
      const openBtn = e.target.closest?.('[data-act="open"]');
      if (openBtn && ui.on) {
        ui.details = null;
        renderDetails();
        openDesk(openBtn.dataset.channel, openBtn.dataset.agent);
        return;
      }
      // "Edit avatar", from the card that already names this desk. The card
      // closes first: it is positioned against the desk it came from and would
      // otherwise sit under the modal.
      const edit = e.target.closest?.('[data-act="rename"]');
      if (edit && typeof window.renameDialog === 'function') {
        ui.details = null;
        renderDetails();
        window.renameDialog(edit.dataset.channel, edit.dataset.agent);
      }
      return;
    }

    // The building view is navigation, not operation. A storey is one button:
    // click the carpet, a desk, a nameplate, the header — anything on it — and
    // you ride to that floor, where the desks can actually be worked. Ahead of
    // every desk handler below, because in this view a desk is scenery.
    //
    // The arrows are the one exception, and they have to be tested first: they
    // sit inside the storey, so the storey would otherwise swallow the click
    // and take you to the floor you were only trying to look along.
    const scroller = e.target.closest?.('svg.room .deskArrow');
    if (scroller && ui.on) {
      const svg = scroller.closest('svg.room');
      const c = floor.channels.find((x) => x.channel === svg.dataset.channel);
      const ch = svg.dataset.channel;
      ui.scroll[ch] = (ui.scroll[ch] ?? 0) + (scroller.classList.contains('left') ? -1 : 1);
      applyScroll(svg, c?.desks.length ?? 0);
      return;
    }

    const storey = e.target.closest?.('svg.room.collapsed');
    if (storey && ui.on) {
      setFloor(storey.dataset.channel);
      return;
    }

    // The desk and the nameplate both open the details card. They are the two
    // surfaces already carrying words about this agent, so asking them for more
    // words is the obvious move — and the sign in particular is what a reader is
    // looking at when they want to know more.
    //
    // Ahead of the cell test for the same reason the pills are: both sit inside
    // the cell's group, which would otherwise swallow the click and open a
    // conversation instead.
    const infoEl = e.target.closest?.('svg.room .plate[data-act="details"], svg.room svg.face');
    if (infoEl && ui.on) {
      const cell = infoEl.closest('.desk');
      const { channel, agent } = cell.dataset;
      const already = ui.details?.channel === channel && ui.details?.agent === agent;
      ui.details = already ? null : { channel, agent };
      // Anchored to the whole cell, not to what was clicked: the card hangs
      // below its anchor, and anything smaller puts it over this cell's own
      // pill tray. The room SVG is scaled to fit its width, so a fixed pixel
      // offset would clear the pills at one zoom and not another — the cell's
      // own box is the only measure that holds.
      if (ui.details) ui.detailsRect = cell.getBoundingClientRect();
      renderDetails();
      return;
    }
    // Any other click dismisses it, then goes on to do whatever it was for.
    if (ui.details) { ui.details = null; renderDetails(); }

    // Before the desk test, because a pill sits inside the desk group and the
    // desk would otherwise swallow the click and just open the panel.
    const pill = e.target.closest?.('svg.room .pill[data-act]');
    if (pill && ui.on) {
      const { channel, agent, act: which } = pill.dataset;
      // app.js owns these dialogs and both scripts share one page. Calling them
      // is deliberate: a second implementation of "mark this backlog read" is
      // how one button comes to mean two things depending on where it was
      // clicked. If the board half is not there, fall back to opening the desk
      // rather than swallowing the click silently.
      const dlg = which === 'unread' ? window.backlogDialog : window.taskDialog;
      // The third argument tells the task dialog which pill was pressed, so it
      // shows claims or assignments rather than both under one heading.
      if (typeof dlg === 'function') dlg(channel, agent, pill.dataset.kind ?? null);
      else openDesk(channel, agent);
      return;
    }

    const deskEl = e.target.closest?.('svg.room .desk');
    if (deskEl && ui.on) {
      openDesk(deskEl.dataset.channel, deskEl.dataset.agent);
      return;
    }

    const pick = e.target.closest?.('#floor-pick [data-floor]');
    if (pick && ui.on) {
      setFloor(pick.dataset.floor || null);
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
    } else if (act.dataset.act === 'rename') {
      // app.js owns the dialogs on this page — same reason the pills call into
      // it rather than growing a second implementation. A `prompt()` used to do
      // this: it could not show the agent id the name belongs to, could not say
      // what clearing the field would restore, and is styled by the browser.
      // The desk may be named from its popover with no panel open, so take the
      // target from the button rather than from ui.open.
      const channel = act.dataset.channel ?? ui.open?.channel;
      const agent = act.dataset.agent ?? ui.open?.agent;
      if (!channel || !agent) return;
      if (typeof window.renameDialog === 'function') window.renameDialog(channel, agent);
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
   * The board's "Nudge agent" button, told to the floor.
   *
   * Nudge is a shortcut for typing the word, so it has to look like typing the
   * word. The endpoint is the same one `sendChat` posts to, but the button is
   * in a dialog the board owns, so nothing here would otherwise know it had
   * happened until the window echoed the turn back — a poll and a host
   * round-trip later, by which time the operator has clicked something else and
   * credits that instead.
   *
   * Shown as sending rather than as a turn, for the same reason `sendChat` does
   * it: the board accepting the word is not the window having recorded it.
   */
  window.floorNudged = (channel, agent, text) => {
    if (ui.open && ui.open.channel === channel && ui.open.agent === agent) {
      ui.sending = ui.sending.concat([{ text, at: Date.now() }]);
      ui.stick = true;
      renderPanel();
    }
    // Even with no panel open on that desk, its sign is about to change.
    tick();
  };

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
    if (e.key !== 'Enter' && e.key !== ' ') return;

    // Keyboard has to mean what the pointer means, or the two surfaces teach
    // different things about what a desk is.
    const arrowEl = document.activeElement?.closest?.('svg.room .deskArrow');
    if (arrowEl) {
      e.preventDefault();
      arrowEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return;
    }
    const deskEl = document.activeElement?.closest?.('svg.room .desk');
    if (!deskEl) return;
    e.preventDefault();
    if (deskEl.closest('svg.room.collapsed')) setFloor(deskEl.closest('svg.room').dataset.channel);
    else openDesk(deskEl.dataset.channel, deskEl.dataset.agent);
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
