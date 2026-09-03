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
  /* How long a question may be "being read" before the panel stops waiting for
     the host and offers the ordinary buttons instead. Reading walks the window's
     tabs, which is a second or two; this is generous against that. */
  const READ_GIVE_UP_MS = 12_000;
  /* The other half of the same wait. Submitting is not a POST that finishes: the
     host has to walk back to the first tab, press a key per choice, type any free
     text, tab to Submit and then press the confirmation until the window takes it
     — measured at twenty-one keystrokes for two questions. For that whole time the
     form sat there looking unpressed, which is what invites a second click.

     Generous against the host's own pace (a step is ~120ms, plus up to three
     confirm presses ~900ms apart). What it bounds is only the spinner: by the
     time this runs the prompt has been deleted server-side, so there is no form
     to put back and nothing to re-answer. A host that genuinely fails says so
     through an error event, which raises its own alert — this deadline is just
     what stops a silent one from turning for ever. */
  const ANSWER_SEND_MS = 25_000;
  /* Moving a conversation between apps is the host's work, not the POST's. It
     closes a tmux window and opens the editor, or opens a window and waits for
     Claude Code to come up — up to READY_TIMEOUT_MS (45s) on the host — and the
     board only hears about it when the desk's holder changes, a second or more
     later. Until then the link had nothing to show for having been clicked, so
     it got clicked again. This is the deadline after which the spinner gives up
     and says what it saw, rather than turning forever; comfortably past the
     host's own timeout so a slow open is a slow open and not a lie. */
  const MOVE_MS = 90_000;
  // How long a refused attach keeps its sentence on screen. Longer than a
  // flash, because that sentence usually carries the command the person now has
  // to type somewhere else, and it should not vanish while they read it.
  const TMUX_NOTE_MS = 25_000;
  // How long to wait for a terminal to turn up before saying it did not. Well
  // past a cold iTerm start; the spinner normally ends in about a second, when
  // the host's next watch tick reports the new client.
  const ATTACH_MS = 20_000;
  /* The links' labels, here as well as in the markup, because the spinner takes
     one over and something has to put it back. */
  const LINK_LABEL = { openhere: 'Open on the floor', handback: 'Open in VS Code', attach: 'Open in tmux', claude: 'Open in Claude' };
  /* Which seat each link is asking for. That seat arriving is what "done" means
     — the POST returning only means the host has been told. Note this is not
     the same as the link going away: handback stays offered while the editor
     has it, so a spinner keyed to its own visibility would never stop. */
  const LINK_SEAT = { openhere: 'floor', handback: 'editor' };
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
  /* What a desk says between hearing something and answering it. Ellipsis
     rather than three dots so it cannot be mistaken for the thought trail. */
  const THINKING = 'Thinking…';
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
  /* Where the avatar sits in its cell. A constant because the bell is now
     positioned from it: the same 66 written in two places would drift the first
     time the figure moved. */
  const PERSON_X = 66;
  const PERSON_Y = 22;

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

  /* The service bell.
     -----------------
     Sits on the desk opposite the monitor and nudges the agent when clicked —
     the same word the board's dialog types, sent to the same endpoint, so the
     two ways of nudging cannot come to mean different things.

     Where it goes is not a free choice. The avatar owns x 46–86 at the
     shoulders and the monitor owns x 100–142, so the bell has the strip left of
     x 46 and nothing else. It sits centred in that strip at x 23, spanning
     15.6–30.4, with the widest arc reaching x 33.3 — clear of the shoulders,
     and clear of the desk's own edge, which it looked ready to fall off when it
     was set against it. */
  /* The dome is a third of the avatar's shoulders, and every other part is a
     ratio of the dome, so "in proportion" is arithmetic rather than five
     numbers that have to be kept in step by hand. A real service bell is far
     smaller than this against a person — but scaled honestly it stops being a
     recognisable object at floor zoom, and this is the size at which it still
     reads as a bell. It used to stand as tall as the monitor, which is what
     made it look wrong. */
  const BODY_R = 20;             // half the avatar body path's width at the shoulders
  const DOME_R = BODY_R * 0.33;
  const BASE_W = DOME_R * 2.23;
  const BASE_H = DOME_R * 0.46;
  const POST_W = DOME_R * 0.2;
  const POST_H = DOME_R * 0.54;
  const KNOB_RX = DOME_R * 0.37;
  const KNOB_RY = DOME_R * 0.18;
  const BELL_FOOT = 64;          // base sits on the same line as the monitor's foot
  const DOME_TOP = BELL_FOOT - BASE_H - DOME_R;
  const POST_TOP = DOME_TOP - POST_H;
  /* Centred in the gap between the desk's edge and the avatar's shoulders,
     rather than measured from either one. The person is drawn at PERSON_X and
     is BODY_R wide either side, so the free strip is 0 to PERSON_X - BODY_R and
     the bell sits in the middle of it. */
  const BELL_CX = Math.round((PERSON_X - BODY_R) / 2);
  /* Sound. Three arcs a side, struck from just below the plunger, because that
     is where the noise comes from and an arc centred lower reads as a shadow.
     The angles keep the arcs off the vertical — a bar straight up the middle
     looks like an antenna, not a ring.

     They are shorter and lower than they first were, and the reason is the
     thought-dot trail: it runs from the bubble's bottom-left diagonally down to
     the head, through exactly this corner, and the first cut had the middle dot
     sitting on the outer right arc with no gap at all. A working agent being
     nudged is not a rare case, so the two have to share the corner. These
     numbers put the outer arc's top at y 28.6 against a trail that bottoms out
     at 18.7 with the narrowest bubble — the case that brings the dots lowest
     and furthest right, and so the one to measure against. Change any of them
     and check that gap again. */
  const RING_CY = POST_TOP + 2;
  /* Sound is not part of the object, so it is proportional to the bell rather
     than strictly to scale: at strict scale the arcs are under 5 units across
     and stop registering as anything at floor zoom. */
  const RING_R = DOME_R * 0.85;  // the innermost arc
  const RING_GAP = DOME_R * 0.42;
  const RINGS = 3;
  const RING_A0 = 38;            // degrees from vertical: where each arc starts
  const RING_A1 = 68;            // and ends

  /* The stop sign's octagon, as a points list on a unit circle (0..2 across),
     so whatever draws it decides how big it is.

     It lives in the chat panel rather than on the desk. Stopping is something
     you do while reading what an agent is writing, not something you reach for
     across a room — and a dim octagon on every desk was standing clutter bought
     for a rare action. The shape still carries the whole message, so it is
     drawn the same way: flat top, not vertex up, because the flat edge is most
     of what makes an octagon read as a road sign rather than a gem. */
  /* The saved-prompts glyph: a caret and an underscore in a rounded box, which
     is Bootstrap's `terminal`. Drawn rather than imported — this page loads no
     icon font, and pulling one in for a single mark is a page-weight bill for
     one glyph. */
  const PROMPT_GLYPH =
    '<rect x="0.12" y="0.28" width="1.76" height="1.44" rx="0.28" />' +
    '<polyline points="0.52,0.78 0.84,1.0 0.52,1.22" />' +
    '<line x1="1.02" y1="1.26" x2="1.46" y2="1.26" />';

  /* The octagon circumscribes the unit box rather than being inscribed in it:
     dividing by cos(22.5°) pushes the flat top and bottom out to y=0 and y=2,
     so the shape's edges are the viewBox's edges. That is what lets CSS set the
     mark's height and get the mark, not the mark plus a margin — an inscribed
     octagon in a 2×2 box is 92% of the height it is given, which read on the
     page as a sign two pixels short of the button beside it. */
  const STOP_PTS = Array.from({ length: 8 }, (_, k) => {
    const a = (Math.PI / 8) + (k * Math.PI) / 4;
    const r = 1 / Math.cos(Math.PI / 8);
    return `${(1 + r * Math.cos(a)).toFixed(3)},${(1 + r * Math.sin(a)).toFixed(3)}`;
  }).join(' ');

  /* Each glyph's viewBox is its own ink, so `height` in CSS means the height of
     the shape. They are not the same proportion — a regular octagon is square,
     a terminal box is wider than it is tall — and they used to share a 2×2 box,
     which sized the *boxes* alike and so the marks inside them differently.
     Cropped to the ink, one height in the row governs both and each takes the
     width that height gives it. PROMPT_BOX is the rect above, exactly. */
  const STOP_BOX = '0 0 2 2';
  const PROMPT_BOX = '0.12 0.28 1.76 1.44';

  /**
   * How long a sent message may sit unrecorded before it says so.
   *
   * Only ever applied to a message nothing has vouched for. A desk that is
   * working takes your message and reads it at its next step, and the host says
   * so — see `ui.delivery` — so the clock has nothing to do with those: it used
   * to tell somebody to send again while the window was holding the message,
   * about to answer it. This is now the deadline for silence alone.
   */
  const SENDING_GRACE_MS = 30_000;

  const ui = {
    on: false,
    open: null,          // { channel, agent } whose chat panel is showing
    turns: [],
    sending: [],         // messages accepted but not yet seen in the conversation
    delivery: null,      // { state, text, held } — a message the window has but has not read

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
    // When each desk's bell was struck, keyed by desk. Out of the DOM for the
    // third time and the same reason: the ring lasts 1.33s and rooms rebuild
    // every 2, so a ring living in a class on a node would be thrown away
    // mid-peal about half the time. It is also what rejects a second click —
    // the timestamp outlives the node, so the guard does too.
    rings: new Map(),
    // A seat change in flight: { channel, agent, act, since }. Outside the DOM
    // for the usual reason and one more — the panel skeleton is rebuilt when
    // you switch desks, and a spinner has to outlive both the poll that redraws
    // it and a trip to another desk and back.
    moving: null,
    // Why the last attach was refused: { channel, agent, text, since }. Out
    // here rather than written to the node, because renderPanel runs every poll
    // and would wipe a message written straight into the DOM within two seconds.
    tmuxNote: null,
    // An attach in flight: { channel, agent, since, from }. `from` is the
    // attached-terminal count at click time — the number a new terminal has to
    // beat — because "a client is attached" is already true whenever you are
    // watching, and only a *rise* means this click did something.
    attaching: null,
    // The saved-prompt picker: { rect } while its menu is open, anchored to
    // where the button was at click time — the same trick the nameplate popover
    // uses, and for the same reason.
    prompts: null,
    // The library itself, kept between openings so the menu draws immediately
    // rather than after a round trip. Re-read every time it is opened, because
    // the manager may have changed it since.
    promptList: [],
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
    // Count what actually landed rather than measure the result. Measuring it
    // meant stripping a trailing ellipsis to see how much was real text — which
    // is right for one this function added and wrong for one the agent typed,
    // so any message ending in … was read as truncated and got a second one.
    let placed = 0;
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (next.length <= per) { line = next; continue; }
      if (line) { lines.push(line); placed += line.split(' ').length; }
      // A single word longer than the line gets cut rather than widening the box.
      line = w.length > per ? `${w.slice(0, per - 1)}…` : w;
      if (lines.length === max) break;
    }
    if (line && lines.length < max) { lines.push(line); placed += line.split(' ').length; }
    if (placed < words.length && lines.length) {
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

  /* ---------- a question the window is asking ---------- */

  /**
   * An AskUserQuestion, as a form.
   *
   * Every question is drawn at once and all but one hidden, rather than one
   * rendered at a time. The panel redraws on a poll; a form whose answers lived
   * in script state would need that state carefully preserved, and a form whose
   * questions were built on demand would lose the ones not on screen. Built once
   * and hidden with a class, the operator's ticks live in the DOM, which is
   * exactly as durable as the box around them.
   *
   * Tabs across the top because that is what you asked for and, as it turns out,
   * what the window itself does — the terminal draws the same strip, so the two
   * surfaces read the same way.
   */
  function askHtml(req) {
    const qs = req.questions ?? [];
    const tabs = qs.map((q, i) =>
      `<button type="button" class="p-tab${i === 0 ? ' on' : ''}" data-act="ask-tab" data-q="${i}">${esc(clip(q.tab_title || q.question || `Question ${i + 1}`, 28))}</button>`).join('');
    const body = qs.map((q, i) => {
      const multi = q.kind === 'multi';
      const opts = (q.options ?? []).map((o) => `
        <label class="p-opt">
          <input type="${multi ? 'checkbox' : 'radio'}" name="q${i}" value="${esc(String(o.n))}"${o.other ? ' data-other="1"' : ''}>
          <span class="p-opt-text">${esc(o.text)}${o.detail ? `<span class="p-opt-detail">${esc(clip(o.detail, 160))}</span>` : ''}</span>
        </label>`).join('');
      // The free-text field belongs to the choice that opens it, and is no use
      // until that choice is ticked — in the window the field does not exist
      // until then either.
      const other = (q.options ?? []).some((o) => o.other)
        ? `<input class="input p-other" type="text" placeholder="Type your own answer\u2026" disabled>`
        : '';
      return `<div class="p-q${i === 0 ? '' : ' hidden'}" data-q="${i}">
        <div class="p-qtext">${esc(q.question ?? '')}</div>
        ${opts}${other}
      </div>`;
    }).join('');
    return `<div class="p-ask" data-request="${esc(req.request_id)}">
      <div class="p-tabs">${tabs}</div>
      ${body}
      <div class="p-ask-warn hidden">\u26a0 You have not answered all questions</div>
      <div class="p-ask-foot">
        <button type="button" class="btn primary" data-act="ask-submit">${qs.length > 1 ? 'Submit all answers' : 'Submit answers'}</button>
        <button type="button" class="btn" data-act="decide" data-choice="cancel" data-request="${esc(req.request_id)}"
                title="The same as pressing Escape in the window">Cancel</button>
      </div>
    </div>`;
  }

  /**
   * The same warning the window gives, in the same words.
   *
   * Claude Code's review screen says "You have not answered all questions" and
   * still lets you submit. Measured, not assumed — a partly-filled form went
   * through and came back with one answer missing. So the floor warns and does
   * not block either: matching what an operator is already used to beats being
   * stricter than the thing we are a second door onto.
   */
  function askWarn(form) {
    const qs = [...form.querySelectorAll('.p-q')];
    const done = qs.filter((q) => q.querySelector('input:checked')).length;
    const warn = form.querySelector('.p-ask-warn');
    if (!warn) return;
    warn.classList.toggle('hidden', done === qs.length);
    // Counted, because "you have not answered all questions" under a form
    // showing one of them does not say which. The button above says it submits
    // all of them; this says how many of them have anything in them.
    warn.textContent = `\u26a0 ${done} of ${qs.length} answered \u2014 you can still submit`;
  }

  /** Read the form back. Only the free text of a choice that was actually ticked. */
  function askAnswers(form) {
    return [...form.querySelectorAll('.p-q')].map((q) => {
      const choose = [...q.querySelectorAll('input[type="radio"]:checked,input[type="checkbox"]:checked')]
        .map((i) => Number(i.value));
      const otherBox = q.querySelector('input[data-other="1"]');
      const text = otherBox?.checked ? (q.querySelector('.p-other')?.value ?? '') : '';
      return { choose, text };
    });
  }

  /* ---------- saved prompts ---------- */

  /**
   * The operator's own library, on the compose row.
   *
   * A body-level popover rather than a node inside the panel: the panel scrolls
   * and clips, and a menu that has to fit inside it would be a menu the tenth
   * prompt falls out of. Anchored to the button's rectangle as it was at click
   * time, like the nameplate card — by the time this draws, a poll may already
   * have redrawn the row.
   */
  function renderPromptMenu() {
    let menu = document.getElementById('prompt-menu');
    const btn = document.querySelector('[data-act="prompts"]');
    btn?.setAttribute('aria-expanded', ui.prompts ? 'true' : 'false');
    if (!ui.prompts) { menu?.remove(); return; }
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'prompt-menu';
      menu.setAttribute('role', 'menu');
      document.body.appendChild(menu);
    }
    // An empty library says so. A menu holding nothing but "Manage" reads as a
    // feature that failed to load rather than one you have not used yet.
    const rows = ui.promptList.length
      ? ui.promptList.map((p) =>
          `<button type="button" class="pm-item" role="menuitem" data-pick="${esc(String(p.id))}" title="${esc(clip(p.content, 400))}">${esc(p.title)}</button>`).join('')
      : '<div class="pm-empty">No saved prompts yet</div>';
    menu.innerHTML = `${rows}<div class="pm-sep"></div><button type="button" class="pm-item pm-manage" role="menuitem" data-pick="manage">Manage…</button>`;

    const r = ui.prompts.rect;
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    // Right-aligned to the button and above it by preference: the compose row
    // sits at the bottom of the panel, so below is usually off-screen.
    const left = Math.max(8, Math.min(r.left + r.width - w, window.innerWidth - w - 8));
    const above = r.top - 6 - h;
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(above < 8 ? Math.min(r.bottom + 6, window.innerHeight - h - 8) : above)}px`;
  }

  /** Open the picker: re-read the library, then draw it where the button is. */
  async function openPromptMenu(btn) {
    const rect = btn.getBoundingClientRect();
    try {
      const r = await fetch('./api/prompts', { headers: { accept: 'application/json' } });
      if (r.ok) ui.promptList = (await r.json()).prompts ?? [];
    } catch { /* keep whatever was last read; the menu still opens */ }
    ui.prompts = { rect };
    renderPromptMenu();
  }

  function closePromptMenu() {
    if (!ui.prompts) return;
    ui.prompts = null;
    renderPromptMenu();
  }

  /* ---------- drafts ----------
     What is in the compose box belongs to the desk, not to the panel.

     The panel's shell — textarea included — is rebuilt whenever a different
     desk is opened, and emptied when the panel closes. So the ordinary thing:
     three hundred words into an instruction for one agent, a bell rings on
     another, click over, answer it, click back — and the three hundred words
     were gone. Nothing the page does may cost somebody their own writing, so
     every keystroke is filed under the desk it was typed for, in localStorage
     rather than in `ui`, so a reload or a closed tab loses nothing either.

     A draft is a message that has not been handed over yet. It goes when the
     board accepts the send (the text is then a pending bubble, and the window's
     transcript is what says whether it arrived), or when the person empties
     the box. A refused send keeps it, and a message the window lost is put
     back into it — both already the behaviour, both now written down. */
  const draftKey = (channel, agent) => `orch.draft:${channel}|${agent}`;
  function saveDraft(channel, agent, text) {
    try {
      if (text && text.trim()) localStorage.setItem(draftKey(channel, agent), text);
      else localStorage.removeItem(draftKey(channel, agent));
    } catch { /* storage blocked or full: the box still has it until the shell goes */ }
  }
  function loadDraft(channel, agent) {
    try { return localStorage.getItem(draftKey(channel, agent)) ?? ''; } catch { return ''; }
  }
  /** File what the box holds now, under the desk whose panel this is. Read
   *  off the panel's own dataset rather than ui.open, which has already moved
   *  on by the time the old shell is being replaced. */
  function stashDraft() {
    const ta = $('p-text');
    const wrap = $('floor-panel');
    if (!ta || !wrap?.dataset.agent) return;
    saveDraft(wrap.dataset.channel, wrap.dataset.agent, ta.value);
  }

  /**
   * Put a prompt in the box, as though it had been typed.
   *
   * At the cursor, not over the top: an operator who has half a sentence typed
   * and reaches for a saved paragraph means to have both. With an empty box —
   * which is most of the time — this is indistinguishable from filling it.
   */
  function insertPrompt(text) {
    const ta = $('p-text');
    if (!ta) return;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    const at = start + text.length;
    ta.focus();
    ta.setSelectionRange(at, at);
    stashDraft();
    // Nothing is sent. The whole point of a template is the edit you make to it
    // before it goes.
  }

  /** Re-read the library from wherever it was changed — the manager calls this. */
  window.floorPromptsChanged = async () => {
    try {
      const r = await fetch('./api/prompts', { headers: { accept: 'application/json' } });
      if (r.ok) ui.promptList = (await r.json()).prompts ?? [];
    } catch { /* the next open re-reads anyway */ }
    if (ui.prompts) renderPromptMenu();
  };

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
    // The server's answer, not a second reading of the same two columns. It
    // used to be `hosted.state === 'working' || last_turn.role === 'tool'` right
    // here, which was fine until the stop sign needed the same fact: a desk
    // drawn as working with a sign that would not light is the drift this file
    // keeps warning about.
    if (d.working) return 'working';
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

  /* ---------- the service bell ---------- */

  const ringKey = (channel, agent) => `${channel}|${agent}`;

  /**
   * Why this desk cannot be nudged, or null if it can.
   *
   * The server decides; this only reads the answer. It was derived here at
   * first, from `hosted`, and that lasted a day: reading `held` treated "no
   * window open at all" as no different from "our own window has it", so a desk
   * whose session had ended the previous evening showed a live bell offering to
   * nudge nobody. The board's button had always asked the server. Now both do,
   * and there is one place left where the answer can be wrong. (That bell is
   * live again today, on purpose and labelled — ringing it opens the window
   * first. See nudgeable() for why, and `wake` in bell() for how it shows.)
   */
  const nudgeBlock = (d) => (d?.nudge?.ok ? null : d?.nudge?.reason ?? 'Nothing is known about this desk yet.');
  /* And whether its turn can be stopped. Same shape, and used the same way: the
     control stays where it is and dims, with the server's reason on hover. A
     control that vanishes tells you nothing. */
  const stopBlock = (d) => (d?.stop?.ok ? null : d?.stop?.reason ?? 'Nothing is known about this desk yet.');

  /* How long one peal lasts, read from the stylesheet rather than repeated
     here. CSS owns the timing — the same arrangement --thought-ms has, and for
     the same reason: two numbers that must agree should be one number. */
  let ringMs = null;
  function ringPeriod() {
    if (ringMs === null) {
      const cs = getComputedStyle(document.documentElement);
      const num = (name, fallback) => {
        const v = parseFloat(cs.getPropertyValue(name));
        return Number.isFinite(v) && v > 0 ? v : fallback;
      };
      // The last arc starts (RINGS - 1) steps in and runs a full duration, so
      // that is when the peal is over.
      ringMs = num('--ring-step', 180) * (RINGS - 1) + num('--ring-dur', 970);
    }
    return ringMs;
  }

  /** How long a refused bell stays marked before it goes back to normal. */
  const REFUSED_MS = 2500;
  /** The word a bell types. One literal, because the bubble is matched on it. */
  const NUDGE_WORD = 'nudge';

  const deskBell = (channel, agent) =>
    document.querySelector(`.desk[data-channel="${CSS.escape(channel)}"][data-agent="${CSS.escape(agent)}"] .bell`);

  /**
   * Put a bell into (or out of) its peal.
   *
   * Called from two places for one reason: a room is only rebuilt when its
   * signature changes, and striking a bell changes nothing the signature is
   * made of — so waiting for the rebuild meant the first ring after a quiet
   * spell never appeared at all. bell() calls this at build time so a peal
   * survives a rebuild; ring() calls it on the live node so a peal starts
   * without one.
   */
  function paintRing(node, since) {
    if (!node) return;
    node.classList.toggle('ringing', !!since);
    node.classList.remove('refused');
    if (since) node.style.setProperty('--ring-phase', `${-(Date.now() - since)}ms`);
    else node.style.removeProperty('--ring-phase');
  }

  const ringingSince = (k) => {
    const at = ui.rings.get(k);
    if (at === undefined) return null;
    if (Date.now() - at < ringPeriod()) return at;
    ui.rings.delete(k);
    return null;
  };

  /**
   * Strike a desk's bell: deliver the nudge, then ring — and show it as
   * sending in the panel, if that desk's is open, exactly as the board's
   * Nudge button does through floorNudged().
   *
   * In that order, and it matters. The ring is the operator's evidence that
   * something was sent, so it must not play for a nudge the board refused —
   * a bell that rings whatever happened is a bell that means nothing. The wait
   * is one round trip to localhost, and the plunger is what covers it.
   *
   * The bubble used to be missing here. The bell rang and that was all, so on
   * a desk mid-turn — where the word sits queued until the next step — nothing
   * on screen said the nudge was in line, and the operator was left trusting
   * the ring against a chat panel that showed nothing. The ring says "sent";
   * the amber bubble is what says "the desk has it".
   */
  async function strike(channel, agent) {
    const k = ringKey(channel, agent);
    if (ringingSince(k)) return;              // already pealing; the click is rejected
    try {
      const r = await fetch('./api/floor/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel, agent, text: NUDGE_WORD }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? `nudge failed (${r.status})`);
    } catch (err) {
      // Quote what came back rather than guessing at a cause: a bell that
      // refuses for its own reasons and a bell repeating the board's are
      // different things, and only one of them tells you where to look.
      const node = deskBell(channel, agent);
      if (node) {
        const tip = node.querySelector('title');
        const was = tip?.textContent;
        node.classList.add('refused');
        if (tip) tip.textContent = String(err.message).slice(0, 140);
        setTimeout(() => {
          node.classList.remove('refused');
          if (tip && was != null) tip.textContent = was;
        }, REFUSED_MS);
      }
      return;
    }
    window.floorNudged(channel, agent, NUDGE_WORD);
  }

  /** Start a peal on a desk, whoever asked for it. */
  function ring(channel, agent) {
    const k = ringKey(channel, agent);
    const at = Date.now();
    ui.rings.set(k, at);
    paintRing(deskBell(channel, agent), at);
    tick();
    // A ring that ends between two rebuilds would otherwise keep its class
    // until the next one. That is not cosmetic: under `prefers-reduced-motion`
    // the arcs are held up by the class rather than by an animation, so a bell
    // left marked is a bell left ringing on screen forever. Clear it on the
    // peal's own clock, off the node as well as out of the map.
    setTimeout(() => {
      if (ui.rings.get(k) !== at) return;      // struck again since; that peal owns it now
      ui.rings.delete(k);
      paintRing(deskBell(channel, agent), null);
    }, ringPeriod() + 60);
  }

  /** One sound arc: `i` counts outward from the bell, `side` is -1 left, +1 right. */
  function ringArc(side, i) {
    const r = RING_R + i * RING_GAP;
    const at = (deg) => {
      const a = (deg * Math.PI) / 180;
      return `${(BELL_CX + side * r * Math.sin(a)).toFixed(2)} ${(RING_CY - r * Math.cos(a)).toFixed(2)}`;
    };
    return `M ${at(RING_A0)} A ${r} ${r} 0 0 ${side > 0 ? 1 : 0} ${at(RING_A1)}`;
  }

  /**
   * The bell itself: base, dome, plunger, and six arcs of sound.
   *
   * The three parts are three shades of the desk's own furniture colour rather
   * than three colours, so the bell reads as one object made of one material —
   * and each part is a clear step from the one it touches, which is the only
   * way a solid shape this small stays legible at floor zoom.
   */
  function bell(d, channel) {
    const blocked = nudgeBlock(d);
    // A desk with no window keeps a working bell: ringing it opens the window
    // first — the conversation resumes — and then nudges. It is drawn half-lit
    // and says so on hover, so nobody opens a session by surprise. The server
    // decides this too (`opens`), for the reason nudgeBlock() gives.
    const wakes = !blocked && !!d?.nudge?.opens;
    const label = blocked ? `Cannot nudge ${d.persona}`
      : wakes ? `Nudge ${d.persona} — opens their window first`
      : `Nudge ${d.persona}`;
    const k = ringKey(channel, d.agent);
    const since = ringingSince(k);
    const g = el('g', {
      class: `bell${blocked ? ' blocked' : ''}${wakes ? ' wake' : ''}`,
      'data-act': 'nudge',
      'data-channel': channel,
      'data-agent': d.agent,
      role: 'button',
      tabindex: blocked ? null : '0',
      'aria-disabled': blocked ? 'true' : null,
      'aria-label': label,
    });
    // SVG has no title attribute — the tooltip is a child element. The reason
    // comes from the same three cases the server refuses with, so hovering a
    // dead bell says what the dialog's disabled button would have said.
    const tip = el('title');
    tip.textContent = blocked ?? label;
    g.appendChild(tip);
    // How far the plunger travels. Geometry, so it is set here and not in the
    // stylesheet, and it is half the post rather than a fixed distance: at the
    // bell's true proportions a fixed 3 units was most of the post's visible
    // height, and the knob drove itself into the dome.
    g.style.setProperty('--press-depth', `${(POST_H / 2).toFixed(2)}px`);

    // A rebuilt node restarts its animation at 0%, which for a one-shot peal
    // means starting over — the same fault the thought dots had, fixed the same
    // way: the animation is anchored to the wall clock, so a bell rebuilt
    // two-thirds of the way through a ring picks up two-thirds of the way in.
    paintRing(g, since);

    // Sound first, so the bell is drawn over it: arcs struck from behind the
    // plunger read as leaving it, arcs on top read as lying across it.
    const sound = el('g', { class: 'bellSound' });
    for (let i = 0; i < RINGS; i += 1) {
      for (const side of [-1, 1]) {
        const arc = el('path', { d: ringArc(side, i), class: 'bellRing' });
        arc.style.setProperty('--ring-i', String(i));
        sound.appendChild(arc);
      }
    }
    g.appendChild(sound);

    // The plunger is one group so the press moves post and knob together.
    const plunger = el('g', { class: 'bellPlunger' });
    plunger.appendChild(el('rect', {
      // Two units longer than it looks: the tail runs into the dome, so the
      // press has somewhere to go without opening a gap under the knob.
      x: BELL_CX - POST_W / 2, y: POST_TOP, width: POST_W, height: POST_H + 2, class: 'bellPost',
    }));
    plunger.appendChild(el('ellipse', { cx: BELL_CX, cy: POST_TOP, rx: KNOB_RX, ry: KNOB_RY, class: 'bellKnob' }));
    g.appendChild(plunger);

    const domeY = BELL_FOOT - BASE_H;
    g.appendChild(el('path', {
      d: `M ${BELL_CX - DOME_R} ${domeY} A ${DOME_R} ${DOME_R} 0 0 1 ${BELL_CX + DOME_R} ${domeY} Z`,
      class: 'bellDome',
    }));
    g.appendChild(el('rect', {
      x: BELL_CX - BASE_W / 2, y: domeY, width: BASE_W, height: BASE_H, rx: BASE_H / 2, class: 'bellBase',
    }));

    // The pad goes last, over the painted parts, for the reason the nameplate's
    // does: a click that lands on a glyph or a stroke reports that shape, and
    // routing up from whatever was hit is what sent clicks to the wrong desk
    // before. One target, no walk.
    //
    // Deliberately larger than the bell, and it does not shrink with it. At the
    // proportions a bell actually has against a person, the object is a few
    // units across — accurate, and much too small to aim at. The pad is sized
    // for the pointer instead, filling the strip the bell sits in without
    // reaching the avatar's shoulders at PERSON_X - BODY_R.
    const padW = Math.max(BASE_W + 16, 30);
    const padTop = POST_TOP - KNOB_RY - 8;
    g.appendChild(el('rect', {
      x: BELL_CX - padW / 2, y: padTop, width: padW, height: BELL_FOOT + 2 - padTop, class: 'bellHit',
    }));
    return g;
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

  /* Somebody who has asked their system for less motion. Read fresh on every
     tick rather than captured once: the setting can be turned on mid-session,
     and a floor left running overnight should notice.

     The guard has to be here rather than in the stylesheet with the other four,
     because this animation is a string growing by a character rather than a CSS
     property changing — @media cannot reach it. There is a pointer beside
     .screenLine in styles.css so that reading the guards there does not leave
     someone concluding this one was forgotten. */
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;

  /** One character on every monitor that still has something to say. */
  function typeTick() {
    const instant = still?.matches ?? false;
    let moved = false;
    for (const st of ui.screens.values()) {
      if (instant) {
        // No typewriter: land on the finished screen in one step. The commands
        // are still there, and the screen still says work is running by having
        // text on it at all — the same trade the thought dots make, where the
        // trail stays put and only the cycling stops.
        while (st.queue.length) {
          if (st.full) st.done.push(st.full);
          st.full = st.queue.shift();
        }
        while (st.done.length > SCREEN_LINES - 1) st.done.shift();
        if (st.typing !== st.full) { st.typing = st.full; moved = true; }
        continue;
      }
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
    p.setAttribute('transform', `translate(${PERSON_X} ${PERSON_Y})`);
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

    // The bell, on the far side of the desk from the monitor. Drawn after the
    // counter so its foot sits on the counter's top edge exactly as the
    // monitor's does — both are objects standing on the desk, not beside it.
    g.appendChild(bell(d, channel));

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
    //
    // A desk that has just been spoken to says so, whatever it said last. An
    // agent can take minutes to get its first words out, and for all of those
    // minutes the bubble was still showing its answer to the previous
    // question — so a desk given new work looked exactly like one that had not
    // heard you. This is the one case where the bubble is not a quotation.
    const said = d.heard ? THINKING : d.last_message?.text;
    if (said) {
      const lines = wrap(said, PER_LINE, BUBBLE_LINES);
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
  function inBuilding() { return !ui.floorFilter && onFloor().length > 1; }

  /* The channels the building is made of, and the ones put away.

     Two ways to put one away, and they are not the same kind of statement.
     **Archived** is shared, audited and on the server; **minimized** is this
     browser tidying up and never leaves it. Both are the board's controls —
     there is nothing on the floor that sets either, deliberately, because a
     room you have to walk into to put away is a worse place to put it away
     from than the list of rooms.

     What the floor does with both is the same: refuse to build with them. A
     channel that is put away is not a storey — and it keeps its chip, at the
     end of the picker, so the room is still somewhere you can go and look.

     Where they differ is the totals, and that difference is on purpose:

     - Archived is out of them, decided on the server, because the count of
       floors in this building is the same number for everyone looking at it.
     - Minimized is NOT. It is one person's fold, and it would make "4 floors"
       mean something different in two browsers looking at one board. The board
       does not move its own totals for a minimized card either; this is that
       rule, not a second one. The chips at the tail are where the rest went.

     So the totals stay the server's, in one place, rather than being
     re-derived here from the same rows by different code. */
  const foldedNow = () => new Set(window.minimizedChannels?.() ?? []);
  const onFloor = () => {
    const m = foldedNow();
    return (floor.channels ?? []).filter((c) => !c.archived && !m.has(c.channel));
  };
  /* The tail, in the order they were put away in: minimized first, archived
     after it. Both are behind the same separator — one mark saying "past here
     is put away" reads faster than two saying which kind. */
  const shelved = () => {
    const m = foldedNow();
    return (floor.channels ?? [])
      .filter((c) => c.archived || m.has(c.channel))
      .sort((a, b) => (a.archived ? 1 : 0) - (b.archived ? 1 : 0) || a.channel.localeCompare(b.channel));
  };

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

  /* The operator queue used to be drawn here, as a red full-width strip above
     the floor. It is gone: it sat at the top of the page while the operator's
     attention is at the bottom, in the conversation, and it repeated an alarm
     the desk was already raising. `floor.queue` is still on the payload — it is
     the derived answer to "who is blocking on a human", it is what the header
     count is counting, and the next thing to surface a prompt will want it. */

  /* ---------- markdown ---------- */

  /**
   * Turn an agent's message into HTML. Half the assistant turns on this board
   * carry markdown — inline code in nearly half of them — and a panel that
   * shows the asterisks is showing the source of a message rather than the
   * message.
   *
   * The string is escaped ONCE, here, before any pattern below runs. Every
   * pattern after this point matches text that is already inert and emits only
   * tags we wrote, so there is no path by which turn text becomes markup and
   * nothing left to sanitise afterwards. Turn text is arbitrary — an agent
   * pasting a file is pasting whatever is in it — so that ordering is the
   * whole safety argument, not a detail. Its one visible cost is that the
   * blockquote matcher below looks for `&gt;`: by the time it runs, escaping
   * has already happened.
   */
  function md(text) {
    return mdBlocks(esc(String(text ?? '').replace(/\r\n?/g, '\n')).split('\n'));
  }

  const RE_FENCE = /^ {0,3}(`{3,}|~{3,})/;
  const RE_HEAD = /^ {0,3}(#{1,6}) +(.*?)\s*#*\s*$/;
  const RE_HR = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
  const RE_QUOTE = /^ {0,3}&gt; ?/;
  const RE_ITEM = /^(\s*)(?:([-*+])|(\d{1,9})[.)]) +(.*)$/;
  const RE_ROW = /^ {0,3}\|(.*)\|\s*$/;
  const RE_SEP = /^ {0,3}\|[-\s|:]*-[-\s|:]*\|\s*$/;
  const isTable = (a, b) => RE_ROW.test(a ?? '') && RE_SEP.test(b ?? '');

  /**
   * Blocks, in the order they have to be tried. Recursive, because a
   * blockquote or a list item holds blocks of its own; every leaf that becomes
   * text leaves through mdInline().
   *
   * Indented code blocks are deliberately absent. Four leading spaces meaning
   * "code" is the largest source of false positives in real chat text — a
   * wrapped line under a list item hits it constantly — and every code block
   * in the turns on this board is fenced.
   */
  function mdBlocks(lines) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      const fence = line.match(RE_FENCE);
      if (fence) {
        // Closed by the same character, at least as long. An unterminated
        // fence runs to the end rather than falling back to paragraphs.
        const close = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
        const body = [];
        i++;
        while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
        i++;
        out.push(`<pre><code>${body.join('\n')}</code></pre>`);
        continue;
      }

      const head = line.match(RE_HEAD);
      if (head) {
        const n = head[1].length;
        out.push(`<h${n}>${mdInline(head[2])}</h${n}>`);
        i++;
        continue;
      }

      if (RE_HR.test(line)) { out.push('<hr>'); i++; continue; }

      if (isTable(line, lines[i + 1])) {
        const cells = (l) => l.replace(/^ {0,3}\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
        const heads = cells(line);
        const align = cells(lines[i + 1]).map((c) =>
          /^:-+:$/.test(c) ? ' class="md-c"' : /^-+:$/.test(c) ? ' class="md-r"' : '');
        i += 2;
        const rows = [];
        while (i < lines.length && RE_ROW.test(lines[i])) rows.push(cells(lines[i++]));
        const cell = (tag) => (c, n) => `<${tag}${align[n] ?? ''}>${mdInline(c)}</${tag}>`;
        out.push(
          `<table><thead><tr>${heads.map(cell('th')).join('')}</tr></thead>` +
          `<tbody>${rows.map((r) => `<tr>${r.map(cell('td')).join('')}</tr>`).join('')}</tbody></table>`
        );
        continue;
      }

      if (RE_QUOTE.test(line)) {
        const body = [];
        // A quote takes the plain lines that follow it too — agents wrap a long
        // quoted line without repeating the marker.
        while (i < lines.length && (RE_QUOTE.test(lines[i]) || (body.length && lines[i].trim()))) {
          body.push(lines[i++].replace(RE_QUOTE, ''));
        }
        out.push(`<blockquote>${mdBlocks(body)}</blockquote>`);
        continue;
      }

      if (RE_ITEM.test(line)) {
        const items = [];
        while (i < lines.length) {
          if (RE_ITEM.test(lines[i]) || (items.length && lines[i].trim())) { items.push(lines[i++]); continue; }
          // A blank line stays inside the list when what follows still belongs
          // to it. That is the difference between a list with a paragraph in
          // it and two lists that happen to touch.
          const next = lines[i + 1] ?? '';
          if (items.length && (RE_ITEM.test(next) || /^\s{2,}\S/.test(next))) { items.push(lines[i++]); continue; }
          break;
        }
        out.push(mdList(items));
        continue;
      }

      const para = [];
      while (i < lines.length && lines[i].trim() &&
             !RE_FENCE.test(lines[i]) && !RE_HEAD.test(lines[i]) && !RE_HR.test(lines[i]) &&
             !RE_QUOTE.test(lines[i]) && !RE_ITEM.test(lines[i]) && !isTable(lines[i], lines[i + 1])) {
        para.push(lines[i++]);
      }
      if (!para.length) { i++; continue; }   // consuming nothing here would spin
      out.push(`<p>${mdInline(para.join('\n'))}</p>`);
    }
    return out.join('');
  }

  /**
   * One list, however deep. Continuation lines lose this level's indent, so
   * the recursive pass sees a nested list starting at column zero and does not
   * have to know it is nested.
   */
  function mdList(lines) {
    const first = lines[0].match(RE_ITEM);
    const ordered = !!first[3];
    const indent = first[1].length;
    const items = [];
    let buf = null;
    for (const l of lines) {
      const m = l.match(RE_ITEM);
      if (m && m[1].length <= indent + 1) { buf = [m[4]]; items.push(buf); continue; }
      if (buf) buf.push(l.slice(Math.min(l.length - l.trimStart().length, indent + 2)));
    }
    const tag = ordered ? 'ol' : 'ul';
    const start = ordered && first[3] !== '1' ? ` start="${Number(first[3])}"` : '';
    const body = items.map((b) => {
      // A one-paragraph item stays a bare <li>; anything holding a blank line,
      // a nested list or a code block gets the full block treatment.
      const simple = !b.some((l) => !l.trim() || RE_ITEM.test(l) || RE_FENCE.test(l));
      return `<li>${simple ? mdInline(b.join('\n')) : mdBlocks(b)}</li>`;
    }).join('');
    return `<${tag}${start}>${body}</${tag}>`;
  }

  /**
   * Inline markup. Code spans and links are lifted out into slots before the
   * emphasis pass, so a `*` inside either is left alone — the ordering a
   * hand-written renderer gets wrong first. Restoring is recursive because a
   * link's label can hold a slot of its own.
   *
   * A slot reads `<7>`, which is safe for the same reason the rest of this is:
   * the text arrived escaped, so it contains no `<` of its own and cannot
   * counterfeit one.
   */
  function mdInline(text) {
    const slots = [];
    const hold = (html) => `<${slots.push(html) - 1}>`;
    let s = String(text);
    s = s.replace(/(`+)([^`]+?)\1/g, (m, ticks, body) => hold(`<code>${body}</code>`));
    s = s.replace(/\[([^\]\n]+)\]\(([^\s)]+)\)/g, (m, label, href) => hold(mdLink(label, href)));
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]*[^\s<).,;:!?'"])/g, (m, pre, url) => pre + hold(mdLink(url, url)));
    s = mdEmph(s);
    // Inside a paragraph a newline stays a newline. CommonMark folds it into a
    // space, but half these turns are not markdown at all and their line breaks
    // are the only structure they have — losing those to make *emphasis* work
    // would be a bad trade.
    s = s.replace(/\n/g, '<br>');
    const back = (t) => t.replace(/<(\d+)>/g, (m, n) => back(slots[n]));
    return back(s);
  }

  // Emphasis never opens or closes on a space, and `*` will not italicise
  // across a word boundary: `2 * 3 * 4` is arithmetic, not emphasis. `_` is not
  // an emphasis marker here at all, because snake_case is far commoner in these
  // messages than underscore italics.
  const mdEmph = (s) => s
    .replace(/\*\*(?![\s*])([^]*?[^\s*])\*\*/g, '<strong>$1</strong>')
    .replace(/~~(?![\s~])([^]*?[^\s~])~~/g, '<del>$1</del>')
    .replace(/(^|[^\w*])\*(?![\s*])([^*\n]*[^\s*])\*(?!\w)/g, '$1<em>$2</em>');

  /**
   * Only http(s) and mailto become anchors, which is also what keeps
   * `javascript:` out. Everything else is nearly always a repo-relative path —
   * [host/window.js](host/window.js), a clickable file reference in an editor
   * and a 404 on this board — so it keeps its label as code: still readable,
   * still copyable, and not a link that goes nowhere.
   */
  function mdLink(label, href) {
    return /^(https?:\/\/|mailto:)/i.test(href)
      ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${mdEmph(label)}</a>`
      : `<code>${label}</code>`;
  }

  /* ---------- the chat panel ---------- */

  /**
   * A task notification: Claude Code telling the agent that something it
   * started in the background — a command, a subagent — has finished. It
   * arrives through the message queue, so the relay used to file it as the
   * operator's words, and this panel drew "YOU" over another agent's whole
   * report, as plain text, because plain text is what the operator's own
   * typing is drawn as. It is the system talking, like every other context
   * turn — but unlike IDE state it carries something worth reading: a status,
   * a one-line summary, and often the entire result. So it gets a note of its
   * own. Amber-outlined like the alert box, for the same reason: something
   * happened, and nothing went wrong. The result is drawn as markdown because
   * it is an agent's writing, not the person's. The fields are read off the
   * block's own child elements, so a shape this does not recognise falls
   * through to the plain context line rather than to nothing.
   */
  // The fields read off a live notice (qa desk, 2026-09-02): task-id,
  // tool-use-id, output-file, status, summary, then for an agent's result a
  // `note` (Claude Code's aside about when these fire), the `result` itself,
  // and a `usage` line of nested counters. Everything not named here is
  // treated as the result and drawn as markdown, so a field this list has
  // never seen is shown rather than dropped.
  const NOTE_META = new Set(['task-id', 'tool-use-id', 'output-file', 'status', 'summary', 'note', 'usage']);
  function noteFields(text) {
    const inner = String(text ?? '').replace(/^\s*<[A-Za-z][\w-]*>/, '').replace(/<\/[A-Za-z][\w-]*>\s*$/, '');
    const fields = [];
    const re = /<([A-Za-z][\w-]*)>([\s\S]*?)<\/\1>/g;
    let m;
    while ((m = re.exec(inner))) fields.push([m[1], m[2].trim()]);
    return fields;
  }
  /** `<subagent_tokens>335433</subagent_tokens><tool_uses>50</tool_uses>` →
   *  "subagent tokens 335433 · tool uses 50". Counters, not prose. */
  function noteUsage(s) {
    return noteFields(`<u>${s}</u>`).map(([n, v]) => `${n.replace(/_/g, ' ')} ${v}`).join(' · ');
  }
  function noteNode(t) {
    const f = noteFields(t.text);
    if (!f.length) return null;
    const get = (k) => f.find(([n]) => n === k)?.[1] ?? '';
    const status = get('status');
    const summary = get('summary');
    const file = get('output-file');
    const aside = get('note');
    const usage = get('usage') ? noteUsage(get('usage')) : '';
    const body = f.filter(([n]) => !NOTE_META.has(n)).map(([, v]) => v).filter(Boolean).join('\n\n');
    const div = document.createElement('div');
    div.dataset.id = t.id;
    div.className = 't t-note';
    div.innerHTML = `
      <div class="t-who">task${status ? ` · ${esc(status)}` : ''}<span class="t-when mono" data-at="${esc(t.created_at)}">${esc(ago(t.created_at))}</span></div>
      ${summary ? `<div class="t-note-summary">${esc(summary)}</div>` : ''}
      ${body ? `<div class="t-body t-md">${md(body)}</div>` : ''}
      ${aside ? `<div class="t-note-aside muted" title="${esc(aside)}">${esc(aside)}</div>` : ''}
      ${file || usage ? `<div class="t-note-file mono muted"${file ? ` title="${esc(file)}"` : ''}>${esc([file ? file.split('/').filter(Boolean).slice(-2).join('/') : '', usage].filter(Boolean).join(' · '))}</div>` : ''}`;
    return div;
  }

  function turnNode(t) {
    const div = document.createElement('div');
    div.dataset.id = t.id;
    if (t.role === 'tool') {
      div.className = 't t-tool';
      // A subagent's tool call carries the subagent's description — the same
      // label the chat puts over its words, so the two read as one thread.
      div.innerHTML = `<span class="t-dot"></span><span class="t-text mono">${esc(t.via ? `${t.via} · ` : '')}${esc(t.text ?? t.tool_name)}</span>`;
      return div;
    }
    if (t.role === 'context' && t.tool_name === 'task-notification') {
      const note = noteNode(t);
      if (note) return note;
    }
    if (t.role === 'context') {
      // The system talking, not the person: IDE state, slash-command records.
      // Same quiet line as a tool call, labeled by its tag. Every wrapper
      // token is stripped for display — a context row only exists because its
      // whole text was wrappers, so none of them is anyone's prose — and the
      // full stored text stays reachable on hover.
      const inner = (t.text ?? '').replace(/<\/?[A-Za-z][\w-]*>/g, ' ').replace(/\s+/g, ' ').trim();
      div.className = 't t-tool t-context';
      div.title = t.text ?? '';
      div.innerHTML = `<span class="t-dot"></span><span class="t-text mono">${esc(t.tool_name ? `${t.tool_name} · ` : '')}${esc(inner)}</span>`;
      return div;
    }
    if (t.role === 'thinking') {
      // What the agent is thinking, drawn as a thought: the desk's own idiom —
      // a bubble whose tail is a trail of dots rather than a point — brought
      // into the chat. No speaker header, deliberately: with one, these read
      // as a message from somebody called "thinking" (the operator said so,
      // 2026-09-03). Plain text, never markdown, and never the agent's words.
      div.className = 't t-thinking';
      div.innerHTML = `
      <span class="t-thought-dots" aria-hidden="true"><i></i><i></i><i></i></span>
      <div class="t-thought" role="note" aria-label="${esc(t.via ? `Thought from ${t.via}` : 'Thought')}">
        <div class="t-body">${esc(t.text ?? '')}</div>
        <div class="t-thought-meta mono">${esc(t.via ? `${t.via} · ` : '')}<span class="t-when" data-at="${esc(t.created_at)}">${esc(ago(t.created_at))}</span></div>
      </div>`;
      return div;
    }
    // A subagent speaking is labeled as such. Its words are still the desk's —
    // the editor shows them under the Agent call for the same reason — but
    // "agent" alone would have the desk appear to change subject mid-thought.
    const who = t.role === 'user' ? 'you' : t.role === 'assistant' ? (t.via ? `agent · ${t.via}` : 'agent') : t.role;
    div.className = `t t-${esc(t.role)}`;
    // Only the agent's own messages are read as markdown. What the operator
    // typed comes back exactly as typed — the compose box is a plain textarea,
    // and a line that starts with a dash should not become a bullet on its way
    // back to the person who wrote it.
    const body = t.role === 'assistant'
      ? `<div class="t-body t-md">${md(t.text)}</div>`
      : `<div class="t-body">${esc(t.text ?? '')}</div>`;
    div.innerHTML = `
      <div class="t-who">${esc(who)}<span class="t-when mono" data-at="${esc(t.created_at)}">${esc(ago(t.created_at))}</span></div>
      ${body}`;
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
    // Whose panel this is, as a DOM fact. The shell is rebuilt in the same
    // synchronous pass that gates the links beneath it, so anything reading
    // the strip can wait on this instead of racing openDesk's async render —
    // which is exactly how a headless check read one desk's buttons against
    // the next desk's name.
    // The old shell's box goes with the old shell. File it first — under the
    // desk it was typed for, which is still what the dataset says.
    stashDraft();
    wrap.dataset.channel = channel;
    wrap.dataset.agent = agent;
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
      <div class="p-turns" id="p-turns"></div>
      <div class="p-compose">
        <!-- Where the question is, not where the panel begins. It used to sit up
             here under the meta line, above a scrolling transcript — so on any
             conversation longer than a screen the thing waiting on you was off
             the top while your eyes were at the bottom, in the box you type in.
             It belongs against the box. -->
        <div class="p-alert-slot"></div>
        <textarea id="p-text" class="input" rows="3"></textarea>
        <div class="p-actions">
          <span class="muted p-hint"></span>
          <button class="btn stopbtn" data-act="stop" aria-label="Stop this turn"><svg class="stopGlyph" viewBox="${STOP_BOX}" aria-hidden="true"><polygon points="${STOP_PTS}" /></svg></button>
          <button class="btn promptbtn" data-act="prompts" aria-label="Saved prompts" aria-haspopup="menu" aria-expanded="false"><svg class="promptGlyph" viewBox="${PROMPT_BOX}" aria-hidden="true">${PROMPT_GLYPH}</svg></button>
          <button class="btn primary" data-act="send">Send</button>
        </div>
        <div class="p-links">
          <button class="p-link" data-act="openhere" title="Open a window for this conversation on this machine">${LINK_LABEL.openhere}</button>
          <button class="p-link" data-act="handback" title="Open this conversation in VS Code">${LINK_LABEL.handback}</button>
          <!-- Not a seat move, though it stands with one: the window stays on
               the floor, which keeps driving it. The terminal lands ON that
               window, so closing it is a detach and never kills the
               conversation — the reason this is not a hand-off to a bare
               claude process. -->
          <button class="p-link" data-act="claude" title="Open this conversation in claude CLI — a terminal on this desk's own window">${LINK_LABEL.claude}</button>
          <!-- Beneath the other two, not beside them: it is not a third place to
               put the conversation, it is the way out of this page. -->
          <button class="p-link" data-act="attach">${LINK_LABEL.attach}</button>
          <!-- Shown only when the button cannot fire. Text, not a second
               mechanism — the one thing still useful when the host that would
               have opened the terminal is itself what is down. -->
          <div class="p-tmux mono hidden"></div>
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
      stashDraft();
      wrap.innerHTML = '';
      // Nobody's panel now, and said so: the dataset is the DOM's word on
      // whose panel this is, and a closed panel that still named its last
      // desk let a probe read "alpha's panel is up" off an empty box.
      delete wrap.dataset.channel;
      delete wrap.dataset.agent;
      ui.panelFor = null;
      // The menu lives on the body, not in the panel, so emptying the panel does
      // not take it with it — it would be left floating over the floor, pointing
      // at a compose box that is no longer there.
      closePromptMenu();
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
    // A message the window is holding, from the poll rather than the stream.
    // Gated on there being no stream for the same reason `partial` is: the
    // stream is two seconds fresher and says the same thing, and letting a
    // stale poll write over it would put a delivery note back seconds after
    // the turn that ended it.
    if (!ui.stream) ui.delivery = d.delivery ?? null;
    const forKey = `${channel}|${agent}`;
    if (ui.panelFor !== forKey) {
      panelShell(wrap, channel, agent);
      // A new shell, an empty box — unless this desk has something unsent.
      $('p-text').value = loadDraft(channel, agent);
      ui.panelFor = forKey;
      // Same reason, one desk over: the menu was anchored to the button in the
      // row that has just been replaced.
      closePromptMenu();
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
    // Deliberately looser than the bell: a message may open a window, so a desk
    // with none is still worth typing into. See nudgeable() on the server.
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
    // The choices are part of what this box says, so they belong in the
    // signature: they arrive a moment after the prompt itself — the host has to
    // go and read them off the window — and without them here the slot is
    // already built and never rebuilt, so the extra buttons never appear.
    // What the box is *for*, not everything currently true about it.
    //
    // One prompt announces itself twice, six seconds apart, and the second
    // announcement changes both the kind and the message. With those in the key,
    // the box was rebuilt underneath whoever was filling it in and every tick
    // went with it — once, a few seconds in, which is why a second attempt
    // always worked. A form is identified by the question it is asking and
    // nothing else.
    // Reading is a state with a deadline. A host that never comes back would
    // otherwise leave a spinner where the answer should be, and no way to say
    // no — so past this it falls through to the ordinary buttons, which is what
    // was there before any of this and is at least something to press.
    const reading = !!req?.reading && Date.now() - Date.parse(req.at ?? 0) < READ_GIVE_UP_MS;
    // What this waits on is not the prompt closing. /api/floor/answer clears the
    // desk's awaiting state as soon as it queues the work, so by the time the
    // POST returns the alert is already gone and the panel is back to normal —
    // which is the whole problem, because the host has not pressed anything yet.
    // Keying the spinner on awaiting_kind would settle it instantly and show
    // nothing at all. Measured on the real page before this read the turn count.
    //
    // A new turn is the honest signal: the window took the answers and the
    // conversation moved on. The deadline is the other way out, for a host that
    // never gets there.
    const answering = ui.answering?.channel === channel && ui.answering?.agent === agent ? ui.answering : null;
    if (answering && ((d.turns ?? 0) > answering.turns || Date.now() - answering.since > ANSWER_SEND_MS)) {
      ui.answering = null;
    }
    const sendingAnswers = !!answering && ui.answering === answering;
    // An alert nobody could read. Not "no request object" — a permission_prompt
    // notification makes one of those with every choice null, which is exactly
    // the case in question. What decides it is whether anything came back that
    // can be pressed: no approve, no deny, no numbered choices, no form.
    //
    // Before this, that state rendered buttons saying Approve and Deny, which
    // claim an understanding nobody has. The window might be asking something
    // else entirely.
    // `req.read` is the difference between "the host looked and found nothing"
    // and "nobody has looked yet". Without it this fired for the second or two
    // every ordinary prompt spends being read, replacing Approve and Deny with
    // guess buttons — and a Yes pressed in that window is a blind keystroke at a
    // prompt the board never saw. Measured live: four of them in a row.
    const unreadable = !!req && !!req.read && !req.questions?.length
      && !req.choices?.approve && !req.choices?.deny && !(req.choices?.extras ?? []).length;
    const kindKey = /^permission_(request|prompt)$/.test(s.awaiting_kind ?? '') ? 'permission' : s.awaiting_kind;
    const alertSig = sendingAnswers
      ? `sending|${answering.request_id}`
      : !s.awaiting_kind
      ? ''
      : req?.questions?.length
        ? `form|${req.request_id}|${req.questions.map((q) => `${q.kind}:${(q.options ?? []).length}`).join(';')}`
        : `${kindKey}|${s.awaiting_message ?? ''}|${req?.request_id ?? ''}` +
          `|${(req?.options ?? []).map((o) => o.n).join(',')}|${req?.options_error ?? ''}|${reading ? 'reading' : ''}|${unreadable ? 'unreadable' : ''}|${req?.startup ? `startup:${req.request_id}` : ''}`;
    if (alertSlot.dataset.sig !== alertSig) {
      alertSlot.dataset.sig = alertSig;
      alertSlot.innerHTML = sendingAnswers
        ? `<div class="p-alert p-alert-ask">
             <div class="p-reading"><span class="pspin" aria-hidden="true"></span>sending your answers to the window…</div>
           </div>`
        // A startup question stands on its own: the window asking it has no
        // session yet, and an editor session in the same repo may be the
        // desk's current one and not waiting on anything.
        : (s.awaiting_kind || req?.startup)
        ? `<div class="p-alert${req ? ' p-alert-ask' : ''}${s.awaiting_kind === 'error' ? ' p-alert-error' : ''}">
             <div>${req?.questions?.length
               // "permission request — AskUserQuestion" is the hook's words for
               // what the tool is called. What it is, to the person reading it,
               // is a question.
               ? `<b>${req.questions.length === 1 ? 'A question for you' : `${req.questions.length} questions for you`}</b>`
               // Not "open it to see what it is asking" any more. That sentence
               // was the whole failure: it told the operator the floor could not
               // help and sent them to a terminal, which is the outcome the
               // floor exists to avoid.
               // A window that has not started yet, asking whether it may. The
               // question is the dialog's own sentence; the rows below are its
               // own rows. See startupQuestionOf in host/window.js.
               : req?.startup
               ? `<b>Before it can start, the window asks</b> — ${esc(clip(req.summary, 220))}`
               : `<b>${esc(String(s.awaiting_kind ?? '').replace(/_/g, ' '))}</b> — ${esc(clip(req?.summary || s.awaiting_message || 'the window has interrupted and is waiting on an answer', 200))}`
             } <span class="mono t-when" data-at="${esc(req?.startup ? (s.awaiting_since ?? req.at ?? '') : s.awaiting_since)}"></span></div>
             ${req?.questions?.length ? askHtml(req) : ''}
             ${reading ? `<div class="p-reading"><span class="pspin" aria-hidden="true"></span>reading the question from the window\u2026</div>` : ''}
             ${unreadable && !reading ? `<div class="p-unknown">
               <div class="p-unknown-why">The window is waiting on something this board could not read.
                 These press the usual keys — they are a guess, not an answer to a question we understood.</div>
               <div class="p-decide">
                 <button class="btn primary" data-act="press" data-choice="yes">Yes</button>
                 <button class="btn danger" data-act="press" data-choice="no">No</button>
                 <button class="btn" data-act="press" data-choice="interrupt" title="Stop the turn instead of answering it">Interrupt</button>
               </div>
             </div>` : ''}
             ${req?.startup ? `<div class="p-startup">
               <div class="p-unknown-why">Nothing here is answered for you. Pick a row and that row is chosen in the window, the same as pressing it there.</div>
               <div class="p-more">${req.options.map((o) =>
                 `<button class="btn p-choice" data-act="decide" data-choice="${esc(String(o.n))}" data-request="${esc(req.request_id)}" title="${esc(o.text)}"><span>${esc(o.text)}</span></button>`).join('')}</div>
             </div>` : ''}
             ${req && !req.questions?.length && !reading && !unreadable && !req.startup ? `<div class="p-decide">
               <button class="btn primary" data-act="decide" data-choice="allow" data-request="${esc(req.request_id)}">Approve</button>
               <button class="btn danger" data-act="${req.choices?.denyAsks ? 'deny-open' : 'decide'}" data-choice="deny" data-request="${esc(req.request_id)}">Deny</button>
               <button class="btn" data-act="decide" data-choice="cancel" data-request="${esc(req.request_id)}" title="The same as pressing Escape in the window">Cancel</button>
             </div>
             ${req.choices?.denyAsks ? `<div class="p-why hidden">
               <input class="input p-why-text" type="text" placeholder="What should Claude do instead? (optional)" maxlength="2000">
               <div class="p-why-row">
                 <button class="btn danger" data-act="decide" data-choice="deny" data-request="${esc(req.request_id)}">Send refusal</button>
                 <button class="btn" data-act="deny-cancel">Back</button>
               </div>
             </div>` : ''}
             ${(req.choices?.extras ?? []).length ? `<div class="p-more">${req.choices.extras.map((o) =>
               `<button class="btn p-choice" data-act="decide" data-choice="${esc(String(o.n))}" data-request="${esc(req.request_id)}" title="${esc(o.text)}"><span>${esc(clip(o.text, 200))}</span></button>`).join('')}</div>` : ''}
             ${req.options_error ? `<div class="p-more-why muted">${esc(req.options_error)}</div>` : ''}` : ''}
           </div>`
        : '';
    }

    $('p-text').placeholder = canChat
      ? `Message ${d.persona}…`
      : held
      ? `${d.persona}’s conversation is open in your editor…`
      : `${d.persona}’s machine isn’t reachable right now…`;
    wrap.querySelector('[data-act="send"]').disabled = !canChat;
    // Gated with Send, not with the stop sign: a prompt is something to send, so
    // offering the library for a box that cannot deliver is the same drift the
    // composer's own gating exists to prevent.
    const promptBtn = wrap.querySelector('[data-act="prompts"]');
    promptBtn.disabled = !canChat;
    promptBtn.title = canChat ? 'Saved prompts' : 'Nothing typed here can be delivered right now.';
    if (!canChat) closePromptMenu();
    // The stop sign. It used to hide itself when there was nothing to stop,
    // which is most of the time — so the row it sits in changed width whenever
    // an agent started or finished, and the control you wanted was the one that
    // had just moved. Dimmed in place instead, exactly like the bell, with the
    // server's own reason on hover.
    //
    // The verdict comes from the server rather than from `h.state` here: the
    // endpoint refuses on exactly this, so a live-looking button over a 409 is
    // the drift the payload's `stop` exists to prevent.
    const stopBtn = wrap.querySelector('[data-act="stop"]');
    const cannotStop = stopBlock(d);
    stopBtn.disabled = !!cannotStop;
    stopBtn.title = cannotStop ?? `Stop ${d.persona}`;
    stopBtn.setAttribute('aria-label', cannotStop ? `Cannot stop ${d.persona}` : `Stop ${d.persona}`);
    const toVsc = wrap.querySelector('[data-act="handback"]');
    const toFloor = wrap.querySelector('[data-act="openhere"]');
    const toTmux = wrap.querySelector('[data-act="attach"]');
    const toClaude = wrap.querySelector('[data-act="claude"]');
    const tmuxCmd = wrap.querySelector('.p-tmux');
    // A move in flight is settled here, against the payload, because the
    // payload is the only thing that knows. The POST is answered the moment the
    // work is queued; the seat changes when the host has actually done it, and
    // the desk's `held` says so. Failing that, the deadline.
    let failed = null;
    const pending = ui.moving && ui.moving.channel === channel && ui.moving.agent === agent ? ui.moving : null;
    if (pending) {
      if (h?.held === LINK_SEAT[pending.act]) ui.moving = null;
      else if (Date.now() - pending.since > MOVE_MS) {
        // What was seen, not why it happened. If the host failed it has already
        // said so in its own error turn, right above this; all this line knows
        // is that the seat never changed.
        failed = pending.act === 'handback'
          ? `no editor has it after ${MOVE_MS / 1000}s`
          : `still no window after ${MOVE_MS / 1000}s`;
        ui.moving = null;
      }
    }
    // An attach in flight, settled against the payload for the same reason a
    // move is: the POST is answered when the work is queued, and the thing
    // actually being waited for happens later, on another machine. `clients`
    // rising is that thing. Ending the spinner on a timer instead would be a
    // spinner that stops meaning anything the moment it is wrong.
    let attachFailed = null;
    let attachDone = false;
    // Two buttons share this flow — "Open in tmux" and "Open in Claude" both
    // end in a terminal attaching — so the act rides along, and the flash
    // lands on the button that was clicked.
    let attachAct = 'attach';
    const attachPending = ui.attaching && ui.attaching.channel === channel && ui.attaching.agent === agent ? ui.attaching : null;
    if (attachPending) {
      attachAct = attachPending.act ?? 'attach';
      if ((h?.clients ?? 0) > attachPending.from) { ui.attaching = null; attachDone = true; }
      else if (Date.now() - attachPending.since > ATTACH_MS) {
        // What was seen, not why. If the host failed to open anything it has
        // already said so in its own error turn, right above this.
        attachFailed = `no new terminal after ${ATTACH_MS / 1000}s`;
        ui.attaching = null;
      }
    }
    const attaching = ui.attaching === attachPending ? attachPending : null;
    const move = ui.moving === pending ? pending : null;
    toVsc.classList.toggle('hidden', !h?.live);
    // Offered only when the desk has no window and no editor on it. With an
    // editor holding it this would open a second process on one transcript,
    // which is the thing handback closes its own window to avoid; with a floor
    // window already up there is nothing to do.
    // ...and not when a window is already sitting in that repo. `held` alone
    // was the test, and `held` is null for the whole of Claude Code's startup:
    // a window stopped on the folder-trust or MCP question has registered no
    // session, so nothing holds it, so the floor offered to open one — with the
    // window already on screen, waiting for a keypress. Reproduced on the qa
    // desk: pane alive, held null, "New MCP server found in this project" on
    // the pane. `window_open` is the fact that separates starting from absent.
    toFloor.classList.toggle('hidden', !(h?.live && !h.held && !h.window_open));
    // Mid-move the strip shows the clicked link, spinning, and nothing else.
    // Leaving the other one up offers the opposite seat while the host is on
    // its way to this one, and it makes the strip change height twice — once
    // for the spinner and again when the move lands. Hiding it puts the strip
    // straight into the shape it will finish in.
    // The escape hatch, offered whenever this conversation is in a tmux window
    // — including while the host is offline. The host is a separate process
    // from the windows it opened and killing it leaves them running, so the
    // session normally outlives it, and a dead host is precisely the state
    // somebody needs a way in from. Hiding this there would remove the hatch at
    // the only moment it is the last one.
    //
    // What an offline host takes away is the ability to open the terminal for
    // you, not the ability to say how. So the row stays, the button goes flat,
    // and the command appears under it.
    const inTmux = h?.held === 'floor';
    const canSpawn = !!(inTmux && h?.live);
    toTmux.classList.toggle('hidden', !inTmux);
    toTmux.disabled = !canSpawn;
    // "Open in Claude" wants a live host (it may have to open the window, and
    // only the host can) and a conversation not held elsewhere. No window is
    // fine — opening one is half of what the button does. When the host is
    // dead the tmux hatch above stays, so hiding this removes no last exit.
    toClaude.classList.toggle('hidden', !(h?.live && h?.held !== 'editor'));
    // Only the reason that is actually true. The offline sentence used to be
    // the whole else-branch, which put "livebox is offline" on a button whose
    // host was perfectly alive and which was hidden for a different reason
    // entirely. Nobody could see it — and a false sentence in the DOM is still
    // a false sentence, waiting for the change that reveals this element.
    toTmux.title = canSpawn
      ? `Open a terminal on ${h.host}, attached to tmux`
      : inTmux
        ? `${h?.host ?? 'That host'} is offline and cannot open a terminal — run the command below on it yourself`
        : '';
    // Named by the host, not assumed: ORCH_TMUX_SESSION moves it, and sending
    // someone to `tmux attach -t orch` on a host that calls it something else
    // is a "no such session" at the worst possible moment.
    // A refusal from the last click outranks the command, and ages out on its
    // own. Settled here, against state, for the same reason a move is: this is
    // the function that runs on every poll, so it is the only one that can.
    const note = ui.tmuxNote
      && ui.tmuxNote.channel === channel && ui.tmuxNote.agent === agent
      && Date.now() - ui.tmuxNote.since < TMUX_NOTE_MS
      ? ui.tmuxNote : null;
    if (ui.tmuxNote && !note) ui.tmuxNote = null;
    tmuxCmd.textContent = note ? note.text : `tmux attach -t ${h?.tmux ?? 'orch'}`;
    tmuxCmd.classList.toggle('tmux-why', !!note);
    // A refusal note shows wherever it was earned — a click on "Open in
    // Claude" with no window can be refused too, and hiding its sentence
    // because the desk is not in tmux would leave that click answered by
    // nothing but a flash.
    tmuxCmd.classList.toggle('hidden', !(note || (inTmux && !canSpawn)));
    if (move) {
      (move.act === 'handback' ? toVsc : toFloor).classList.remove('hidden');
      (move.act === 'handback' ? toFloor : toVsc).classList.add('hidden');
      // A seat move decides whether there is a tmux window at all, so the hatch
      // is not offered while one is in flight — same reason the opposite seat's
      // link goes away, and the same rule: the strip finishes in one shape.
      toTmux.classList.add('hidden');
      toClaude.classList.add('hidden');
      tmuxCmd.classList.add('hidden');
    }
    setLinkBusy(toVsc, move?.act === 'handback');
    setLinkBusy(toFloor, move?.act === 'openhere');
    setLinkBusy(toTmux, !!attaching && attachAct === 'attach');
    setLinkBusy(toClaude, !!attaching && attachAct === 'claude');
    // Hiding both links is not the same as hiding the strip: an empty flex
    // column is zero-height but still counts as a row, so .p-compose's gap
    // leaves a blank line where the links were.
    wrap.querySelector('.p-links').classList
      .toggle('hidden', toVsc.classList.contains('hidden')
        && toFloor.classList.contains('hidden')
        && toTmux.classList.contains('hidden')
        && toClaude.classList.contains('hidden'));
    // After setLinkBusy, so the label is back before flash() borrows it.
    if (failed) flash(wrap.querySelector(`[data-act="${pending.act}"]`), failed);
    // "attached", not "asked" — this one has been observed now.
    if (attachDone) flash(attachAct === 'claude' ? toClaude : toTmux, 'terminal attached');
    if (attachFailed) flash(attachAct === 'claude' ? toClaude : toTmux, attachFailed);
    const askForm = wrap.querySelector('.p-ask');
    if (askForm) askWarn(askForm);
    wrap.querySelector('.p-compose').classList.toggle('held', held);
    // The hint says exactly what will happen, because a Send button that
    // sometimes can't is worse than one that says why.
    // Two copies is the first thing worth saying, because everything else the
    // hint could say is about a conversation the words assume is in one place.
    // Nothing prevents this — two processes may resume one session id, and they
    // append to one transcript while keeping separate context — so the honest
    // report is the count, not a guess at which one you are looking at.
    const holders = h?.holders ?? 0;
    wrap.querySelector('.p-hint').innerHTML = holders > 1
      ? `<b>${holders} processes hold this conversation.</b> They share its transcript but not their context, and the floor types into whichever it found first. Close all but one.`
      : held
      ? `Open in your editor${h.held_pid ? ` (pid ${h.held_pid})` : ''}. Close it there, or move it back with the link below — one app holds a conversation at a time.`
      : canChat
      ? `A turn in <b class="mono">${esc(h.window ?? agent)}</b> on ${esc(h.host)}. Enter sends, Shift+Enter for a new line.`
      : h
        ? `The host for this desk (${esc(h.host)}) is offline, so nothing sent here can reach it. Start it on that machine and this works again.`
        // Hosts look for a newly bound repo on their own — before each
        // heartbeat, and the moment a session starts in it — so this says so,
        // and offers the look now for anyone who would rather not wait a
        // minute to find out. What the button heard back is kept in ui rather
        // than flashed onto it, because this hint is rewritten every poll.
        : `No host on this board is running that repo yet. Hosts look for it again every minute, and the moment a session starts in it. `
          + `<button class="btn" data-act="rescan">Look now</button>`
          + (ui.rescanSaid && Date.now() - ui.rescanSaid.at < 8000 ? ` <span class="muted">${esc(ui.rescanSaid.text)}</span>` : '');

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
      const queued = deliveredNow(p.text);
      const stale = !queued && Date.now() - (p.at ?? 0) > SENDING_GRACE_MS;
      box.insertBefore(pendingNode(p.text, queued, stale), partialNode);
    }
    // A queued message this browser did not send — the bell struck with the
    // panel shut, the board's Nudge button, another tab, a reload — is still
    // the operator's, and the desk has said it holds it. Nothing in
    // `ui.sending` stands for it, so it is drawn from the server's note
    // instead: the same bubble, already queued, and gone the moment the note
    // is — a turn retires it there, exactly as a turn retires the others here.
    if (ui.delivery && !ui.sending.some((p) => deliveredNow(p.text))) {
      box.insertBefore(pendingNode(ui.delivery.text, ui.delivery, false), partialNode);
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

  /**
   * Has the window vouched for this pending message?
   *
   * Returns the delivery note when the desk has said it holds this exact text,
   * which is what stops the grace clock running on it. Matched on the words for
   * the same reason `settle` matches on them: there is no id to match: the host
   * reports what it typed in, and this is the copy that was typed.
   */
  function deliveredNow(text) {
    const d = ui.delivery;
    if (!d || !text) return null;
    return squash(d.text).includes(squash(text)) ? d : null;
  }

  /**
   * One pending bubble. Three states, and the difference between them is who
   * has the message.
   *
   * `queued` is the window's own word: it took the message while it was
   * working and will read it at its next step. That is a delivery, not a
   * delay, so it never goes stale — the desk is holding it and has said so.
   * Everything the operator does next depends on telling that apart from
   * silence, which is what the third state is.
   */
  function pendingNode(text, queued, stale) {
    const node = document.createElement('div');
    node.className = 't t-user t-pending';
    node.classList.toggle('stale', stale);
    node.classList.toggle('queued', !!queued);
    const said = queued
      ? (queued.held ? 'queued — the window took it once it was free' : 'queued — the desk is working')
      : (stale ? 'not recorded — send again' : 'sending…');
    node.innerHTML = `<div class="t-who">you<span class="t-when mono">${said}</span></div>` +
      ' <div class="t-body"></div>';
    node.querySelector('.t-body').textContent = text;
    return node;
  }

  function settle(rows) {
    if (!ui.sending.length) return;
    const arrived = rows.filter((r) => r.role === 'user').map((r) => squash(r.text));
    // A refused send used to end here, and that was the whole of it: the pending
    // bubble went, and with it the only copy of what the operator had typed. The
    // wait before a refusal is minutes long, so what gets thrown away is usually
    // a paragraph somebody sat and wrote.
    //
    // The words go back where they came from. Prepended rather than assigned,
    // because clobbering whatever is in the box now would be the same mistake in
    // the other direction.
    if (rows.some((r) => r.role === 'error')) {
      const lost = ui.sending.map((pnd) => pnd.text).filter(Boolean).join('\n\n');
      ui.sending = [];
      const box = $('p-text');
      if (lost && box) {
        box.value = box.value.trim() ? `${lost}\n\n${box.value}` : lost;
        box.focus();
        stashDraft();   // a draft again, and kept as one
      }
      return;
    }
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
      } else if (ev.type === 'delivery') {
        // The window has the message, or has just stopped having it. Straight
        // to the panel rather than through tick(): this is what the pending
        // bubble is waiting to hear, and two seconds of "sending…" over a
        // message already delivered is the whole complaint this answers.
        ui.delivery = ev.delivery ?? null;
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
    const here = onFloor();
    const away = shelved();
    const names = floor.channels.map((c) => c.channel);
    if (ui.floorFilter && !names.includes(ui.floorFilter)) ui.floorFilter = null;
    const pickSig = JSON.stringify([here.map((c) => c.channel), away.map((c) => c.channel), ui.floorFilter]);
    if (pickSig !== ui.pickSig) {
      ui.pickSig = pickSig;
      const chip = (n, cls = '', title = '') =>
        `<button class="chip${cls}${ui.floorFilter === n ? ' on' : ''}" data-floor="${esc(n)}"${title ? ` title="${esc(title)}"` : ''}>${esc(n)}</button>`;
      // Why this chip is in the tail, on the chip. Archived wins when a channel
      // is both: it is the one of the two that other people can see.
      const put = (c) => c.archived
        ? [' archived', 'Archived on the board — kept out of "all floors". Restore it from the board view.']
        : [' folded', 'Minimized on the board, in this browser only — kept out of "all floors". Restore it from the board view.'];
      // A picker with one choice is furniture — but an archived channel makes a
      // second choice out of a single floor, because "all floors" no longer
      // contains it and there would otherwise be nothing offering the way in.
      const worth = names.length > 1 || away.length > 0;
      $('floor-pick').innerHTML = !worth ? '' : [
        `<button class="chip${ui.floorFilter ? '' : ' on'}" data-floor="">all floors</button>`,
        ...here.map((c) => chip(c.channel)),
        // The tail, and why it is a tail. Archived rooms sort after everything
        // else behind a mark rather than being dropped or greyed in place: a
        // list that reorders itself around a flag reads as a list in an order,
        // which is the one thing it must not be mistaken for.
        ...(away.length ? ['<span class="pick-sep" aria-hidden="true">·</span>'] : []),
        ...away.map((c) => chip(c.channel, ...put(c))),
      ].join('');
    }
    // "all floors" means the floors in the building. Named, it is whichever one
    // you named, archived or not — the chip is an offer to go and look.
    const shown = ui.floorFilter ? floor.channels.filter((c) => c.channel === ui.floorFilter) : here;

    // Stacked floors are drawn inside a building; one floor on its own is just
    // that floor. The class carries the whole difference in the stylesheet.
    rooms.classList.toggle('building', inBuilding());

    const sig = JSON.stringify([ui.floorFilter, shown]);
    if (sig !== ui.roomsSig) {
      ui.roomsSig = sig;
      if (!shown.length) {
        // Two different empties. "Nothing here yet" is wrong when there are
        // rooms and every one of them has been put away — that sends someone
        // looking for a bug in the hook plugin over a decision they made
        // themselves on the board. It names which decision, because minimized
        // and archived are undone in different places.
        const arc = away.filter((c) => c.archived).length;
        const how = [(away.length - arc) && `${away.length - arc} minimized`, arc && `${arc} archived`]
          .filter(Boolean).join(' and ');
        rooms.innerHTML = away.length
          ? `<div class="q-empty">Every floor is put away — ${how}, on the chips above. Nothing is deleted: pick a chip to look at one, or bring it back from the board view.</div>`
          : '<div class="q-empty">No desks yet. An agent gets a seat the moment it appears on the board or its window posts a hook event.</div>';
      } else {
        rooms.replaceChildren(...shown.map(room));
      }
    }
    // Ages and counts in the open card tick with everything else.
    renderDetails();
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
        ui.delivery = null;
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
    ui.rings.clear();
  }

  /* ---------- events ---------- */

  function openDesk(channel, agent) {
    ui.open = { channel, agent };
    ui.turns = [];
    ui.sending = [];
    // Per desk, like everything else here. A note about a message one desk is
    // holding would otherwise be read against the pending message of the next
    // desk opened, and label it queued on the strength of somebody else's.
    ui.delivery = null;
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
    // Same reason: it is placed against a rectangle captured at click time.
    closePromptMenu();
  }, true);

  document.addEventListener('click', async (e) => {
    // The prompt menu's own clicks, and the click that dismisses it.
    //
    // Handled before anything else so a pick cannot also register as a click on
    // whatever the menu is covering. The button itself is left to the panel's
    // handler, which toggles — catching it here as "outside" would close the
    // menu and immediately reopen it.
    if (ui.prompts) {
      const item = e.target.closest?.('#prompt-menu [data-pick]');
      if (item) {
        const pick = item.dataset.pick;
        closePromptMenu();
        if (pick === 'manage') {
          // app.js owns the dialogs on this page, the same arrangement the pills
          // and the stop sign use. With the board half missing, do nothing
          // rather than half-open a manager.
          window.promptManager?.();
        } else {
          const p = ui.promptList.find((x) => String(x.id) === pick);
          if (p) insertPrompt(p.content);
        }
        return;
      }
      if (!e.target.closest?.('#prompt-menu') && !e.target.closest?.('[data-act="prompts"]')) closePromptMenu();
    }
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

    // The bell rings the agent without opening the conversation panel (it may
    // open the desk's *window*, when there is none). Ahead of the desk test
    // for the same reason the pills are — it sits inside the cell — and it
    // returns even when it refuses, so a click on a bell that cannot ring does
    // not fall through and open the conversation instead.
    const bellEl = e.target.closest?.('svg.room .bell');
    if (bellEl && ui.on) {
      if (!bellEl.classList.contains('blocked') && !bellEl.closest('svg.room.collapsed')) {
        strike(bellEl.dataset.channel, bellEl.dataset.agent);
      }
      return;
    }

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
    } else if (act.dataset.act === 'ask-tab') {
      const form = act.closest('.p-ask');
      const want = act.dataset.q;
      for (const t of form.querySelectorAll('.p-tab')) t.classList.toggle('on', t.dataset.q === want);
      for (const q of form.querySelectorAll('.p-q')) q.classList.toggle('hidden', q.dataset.q !== want);
    } else if (act.dataset.act === 'ask-submit') {
      const form = act.closest('.p-ask');
      const answers = askAnswers(form);
      if (!answers.some((a) => a.choose.length)) {
        flash(act, 'nothing chosen yet');
        return;
      }
      // The spinner goes up on the POST succeeding, not on the click. Not for
      // caution — because the two waits are wildly different lengths. Queueing
      // the work is a local POST; what takes seconds is the host afterwards,
      // walking back to the first tab and pressing a key per choice.
      //
      // Doing it this way round is also what keeps a refusal cheap: showing the
      // spinner first would mean taking the form down, and putting it back
      // rebuilds it from the payload — so every answer just ticked would be lost
      // to an error that changed nothing.
      for (const b of form.querySelectorAll('button')) b.disabled = true;
      try {
        const r = await fetch('./api/floor/answer', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...ui.open, request_id: form.dataset.request, answers }),
        });
        if (r.ok) {
          // The count as it stands now, because what retires the spinner is this
          // desk gaining a turn — the window having taken the answers and moved
          // on. Captured here rather than in renderPanel so a poll landing
          // between the click and the first draw cannot settle it early.
          const now = floor?.channels?.find((c) => c.channel === ui.open.channel)
            ?.desks?.find((x) => x.agent === ui.open.agent);
          ui.answering = { ...ui.open, request_id: form.dataset.request, since: Date.now(), turns: now?.turns ?? 0 };
          renderPanel();
        } else {
          const body = await r.json().catch(() => ({}));
          flash(act, String(body.error ?? `that didn't send (${r.status})`).slice(0, 60));
          for (const b of form.querySelectorAll('button')) b.disabled = false;
        }
      } catch (err) {
        flash(act, String(err.message).slice(0, 60));
        for (const b of form.querySelectorAll('button')) b.disabled = false;
      }
      tick();
    } else if (act.dataset.act === 'deny-open') {
      // Deny does not refuse on its own any more: it opens the box. The window's
      // own "No, and tell Claude what to do differently" is what the floor has
      // been pressing all along, and that choice does not answer the prompt — it
      // asks for the rest of the sentence. Sending nothing left the window
      // holding an empty field.
      const alert = act.closest('.p-alert');
      alert?.querySelector('.p-why')?.classList.remove('hidden');
      alert?.querySelector('.p-decide')?.classList.add('hidden');
      alert?.querySelector('.p-why-text')?.focus();
    } else if (act.dataset.act === 'deny-cancel') {
      const alert = act.closest('.p-alert');
      alert?.querySelector('.p-why')?.classList.add('hidden');
      alert?.querySelector('.p-decide')?.classList.remove('hidden');
    } else if (act.dataset.act === 'press') {
      // Hold all three while it is in flight, for the same reason `decide` does:
      // a prompt that looks unresponsive is one that gets clicked again, and
      // these keys go straight into somebody's window.
      const all = act.closest('.p-alert')?.querySelectorAll('[data-act="press"]') ?? [act];
      for (const b of all) b.disabled = true;
      try {
        const choice = act.dataset.choice;
        // Interrupt is not a guessed key — it stops the turn, and that already
        // has a route with its own checks. Sending it through `press` would be a
        // second way to do one thing.
        const r = await fetch(choice === 'interrupt' ? './api/floor/interrupt' : './api/floor/press', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(choice === 'interrupt' ? { ...ui.open } : { ...ui.open, choice }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          flash(act, String(body.error ?? `that didn't send (${r.status})`).slice(0, 60));
        }
      } catch (err) {
        flash(act, String(err.message).slice(0, 60));
      } finally {
        for (const b of all) b.disabled = false;
      }
      tick();
    } else if (act.dataset.act === 'decide') {
      // The panel is the only place these appear now, so the desk is ui.open.
      // The strip used to name its own desk on the button, which is why this
      // read a channel and an agent off the dataset.
      //
      // Every answer goes through one branch — the three that always show and
      // the window's own numbered choices alike. What each one presses is the
      // server's business, decided from the same list the buttons were drawn
      // from; this only says which was clicked.
      //
      // Hold all of them while it is in flight. Clicking again cannot help, and
      // a prompt that looks unresponsive invites exactly that.
      const all = act.closest('.p-alert')?.querySelectorAll('[data-act="decide"]') ?? [act];
      for (const b of all) b.disabled = true;
      try {
        // Empty is a decision too, and is sent as one: the operator opened the
        // box, chose to say nothing, and the window still needs its Enter.
        // Only when a box was actually offered. A prompt whose refusal is a plain
        // "No" has nowhere to put a sentence, and sending an empty one would ask
        // the host to press Enter at a prompt that has already closed.
        const box = act.closest('.p-alert')?.querySelector('.p-why-text');
        const why = act.dataset.choice === 'deny' && box ? box.value : null;
        await decide(act.dataset.request, act.dataset.choice, why);
      } finally {
        for (const b of all) b.disabled = false;
      }
    } else if (act.dataset.act === 'stop') {
      // Ask first. Nothing else in this panel throws work away, and a turn
      // three minutes in is worth a sentence of confirmation.
      //
      // app.js owns the dialogs on this page, the same arrangement the pills
      // use. If the board half is missing, do nothing rather than stopping an
      // agent with no prompt — the prompt is the feature.
      if (ui.open && typeof window.stopDialog === 'function') {
        // This payload's name for the desk, not the board's — both read the same
        // rows, but the panel is open on a desk this one is guaranteed to hold.
        const open = floor.channels.find((c) => c.channel === ui.open.channel)
          ?.desks.find((x) => x.agent === ui.open.agent);
        window.stopDialog(ui.open.channel, ui.open.agent, open?.persona ?? ui.open.agent);
      }
    } else if (act.dataset.act === 'rescan') {
      // One click, one look, by every host on the board. The result is a
      // re-registration the next poll shows; what is said here is only who was
      // asked, or why nobody could be.
      act.disabled = true;
      try {
        const r = await fetch('./api/floor/rescan', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ channel: ui.open?.channel, agent: ui.open?.agent }),
        });
        const body = await r.json().catch(() => ({}));
        ui.rescanSaid = {
          at: Date.now(),
          text: r.ok ? `asked ${body.asked} host${body.asked === 1 ? '' : 's'} — looking…` : (body.error ?? `failed (${r.status})`),
        };
      } catch (err) {
        ui.rescanSaid = { at: Date.now(), text: err.message };
      }
      act.disabled = false;
      renderPanel();
    } else if (act.dataset.act === 'prompts') {
      // A toggle: the second click on the button closes it, which is what a
      // menu button does everywhere else.
      if (ui.prompts) closePromptMenu();
      else await openPromptMenu(act);
    } else if (act.dataset.act === 'handback' || act.dataset.act === 'openhere') {
      await moveSeat(act.dataset.act);
    } else if (act.dataset.act === 'attach' || act.dataset.act === 'claude') {
      await attachTmux(act.dataset.act);
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
    btn.classList.add('flashed');
    setTimeout(() => { btn.textContent = was; btn.classList.remove('flashed'); }, ms);
  }

  /**
   * The board's "Nudge agent" button, told to the floor.
   *
   * Nudge is a shortcut for typing the word, so it has to look like typing the
   * word. The endpoint is the same one `sendChat` posts to, but the button is
   * in a dialog the board owns, so nothing here would otherwise know it had
   * happened until the window echoed the turn back — a poll and a host
   * round-trip later, by which time the operator has clicked something else and
   * credits that instead. The floor's own bell comes through here too
   * (strike()), so a nudge shows as sending, then queued, then a turn,
   * whichever surface struck it.
   *
   * Shown as sending rather than as a turn, for the same reason `sendChat` does
   * it: the board accepting the word is not the window having recorded it.
   */
  window.floorNudged = (channel, agent, text) => {
    // Whichever surface sent it, the desk rings. The board's dialog has already
    // had its "ok" from the same endpoint strike() posts to, so the evidence
    // the ring stands for is the same evidence either way.
    ring(channel, agent);
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
      stashDraft();   // handed over: no longer a draft
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

  async function decide(requestId, decision, reason = null) {
    if (!ui.open || !requestId) return;
    const r = await fetch('./api/floor/permission', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...ui.open, request_id: requestId, decision,
        ...(typeof reason === 'string' ? { reason } : {}) }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      alert(body.error ?? `That didn't work (${r.status}).`);
    }
    tick();
  }

  /** Swap a seat link for a spinner, and back again. */
  function setLinkBusy(btn, busy) {
    if (!btn) return;
    // Only on the transition. Rewriting the node every poll restarts the CSS
    // animation, and a spinner that jumps back to the top every two seconds
    // reads as a page that keeps starting over rather than one that is working.
    if (busy === (btn.dataset.busy === '1')) return;
    if (busy) {
      btn.dataset.busy = '1';
      btn.innerHTML = '<span class="pspin" aria-hidden="true"></span>';
      btn.setAttribute('aria-busy', 'true');
      // The glyph is decorative, so the name has to carry the whole meaning.
      btn.setAttribute('aria-label', `${LINK_LABEL[btn.dataset.act]} — waiting`);
    } else {
      delete btn.dataset.busy;
      btn.textContent = LINK_LABEL[btn.dataset.act];
      btn.removeAttribute('aria-busy');
      btn.removeAttribute('aria-label');
    }
  }

  /**
   * Move the open desk's conversation between the editor and the floor.
   *
   * A conversation is one process, so this is a change of seat and not a
   * message. `handback` has the host close its own window before opening the
   * editor — the reverse order leaves two live copies — and `open` has it open
   * a window here, refused outright while an editor still holds it, for the
   * same reason.
   *
   * The click is answered long before the work is done: the server queues it,
   * the host picks it up on its next poll, closes or opens a window, and for
   * `open` waits for Claude Code to actually come up. Seconds, sometimes many.
   * The links showed nothing at all for that, so the only thing left to do was
   * click again — and clicking again queued a second move. The spinner is the
   * receipt for the click; the seat arriving is the receipt for the move, and
   * only renderPanel can see that, so that is where this ends.
   */
  async function moveSeat(act) {
    if (!ui.open) return;
    const { channel, agent } = ui.open;
    // One move per desk at a time — both links go to the same host queue, and
    // two in flight is a request to be in two places. A stale move left on some
    // other desk is not a reason to refuse this one; it is simply replaced,
    // since only the open desk's spinner is on screen to settle.
    if (ui.moving && ui.moving.channel === channel && ui.moving.agent === agent) return;
    ui.moving = { channel, agent, act, since: Date.now() };
    // Before the fetch, not after. The whole point is that the click is
    // acknowledged while the request is still open.
    renderPanel();
    try {
      const r = await fetch(act === 'handback' ? './api/floor/handback' : './api/floor/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel, agent }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        failMove(act, String(body.error ?? `couldn't ${act === 'handback' ? 'move' : 'open'} it (${r.status})`).slice(0, 60));
      }
    } catch (err) {
      failMove(act, String(err.message).slice(0, 60));
    }
    tick();
  }

  /**
   * Ask the host to open a terminal attached to its tmux session.
   *
   * Deliberately none of moveSeat's machinery, because this is not a move. A
   * seat change is settled by watching `held` flip, since that is the
   * observable fact it produces. Attaching produces no fact on this board at
   * all — the result is a window on somebody's desktop, which the floor cannot
   * see and must not pretend to.
   *
   * So the spinner ends when the POST is answered, and the receipt says only
   * what is actually known: that the host was asked. If opening the terminal
   * then fails, the host says so in its own error turn on this desk, which is
   * the only place that can honestly report it.
   */
  async function attachTmux(act = 'attach') {
    if (!ui.open) return;
    const { channel, agent } = ui.open;
    const btn = $('floor-panel').querySelector(`[data-act="${act}"]`);
    if (!btn || btn.disabled) return;
    // One at a time, like a seat move: the spinner is the receipt for the click,
    // and a second click while it turns would queue a second terminal. Shared
    // across both buttons for the same reason — two clicks, two terminals.
    if (ui.attaching && ui.attaching.channel === channel && ui.attaching.agent === agent) return;
    ui.tmuxNote = null;
    // The count to beat, read before the request. Somebody clicking this often
    // already has a terminal attached, so the test is a rise, not a presence.
    const now = floor?.channels?.find((c) => c.channel === channel)?.desks?.find((x) => x.agent === agent);
    ui.attaching = { channel, agent, act, since: Date.now(), from: now?.hosted?.clients ?? 0 };
    // Before the fetch, not after — the click is acknowledged while the request
    // is still open, same as moveSeat.
    renderPanel();
    try {
      const r = await fetch(act === 'claude' ? './api/floor/claude' : './api/floor/attach', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel, agent }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        // Refused outright: stop waiting now rather than spinning out the full
        // deadline for a terminal nothing ever went to open.
        ui.attaching = null;
        renderPanel();
        // The refusals are sentences carrying the command, so they go in the
        // line beneath rather than the label — flashing one into a 10px
        // uppercase link truncates the only part worth reading.
        flash(btn, 'could not open a terminal');
        ui.tmuxNote = { channel, agent, text: String(body.error ?? `the board refused it (${r.status})`), since: Date.now() };
      }
    } catch (err) {
      ui.attaching = null;
      renderPanel();
      flash(btn, 'could not reach the board');
      ui.tmuxNote = { channel, agent, text: String(err.message), since: Date.now() };
    }
    tick();
  }

  /** A move that was refused outright: stop waiting now, and say what came back. */
  function failMove(act, message) {
    ui.moving = null;
    // Puts the label back before flash() borrows it — the spinner has no text
    // to save and restore.
    renderPanel();
    flash($('floor-panel').querySelector(`[data-act="${act}"]`), message);
  }

  // The free-text field is only live while the choice that opens it is ticked —
  // in the window that field does not exist until then either. Delegated,
  // because the form is rebuilt whenever a new question arrives.
  document.addEventListener('change', (e) => {
    const box = e.target.closest?.('.p-q input[type="radio"],.p-q input[type="checkbox"]');
    if (!box) return;
    const q = box.closest('.p-q');
    askWarn(box.closest('.p-ask'));
    const other = q.querySelector('input[data-other="1"]');
    const field = q.querySelector('.p-other');
    if (!field) return;
    field.disabled = !other?.checked;
    if (!field.disabled) field.focus();
    else field.value = '';
  });

  // Every keystroke into the box is filed under its desk as it happens, so no
  // moment — a click on another desk, a reload, a closed tab — can be the one
  // that loses it. See the drafts note above stashDraft.
  document.addEventListener('input', (e) => {
    if (e.target?.id === 'p-text') stashDraft();
  });

  document.addEventListener('keydown', (e) => {
    if (!ui.on) return;
    // Enter sends; Shift+Enter is a newline, the way every chat box works.
    if (e.target?.id === 'p-text' && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChat();
      return;
    }
    // The menu first, then the panel. One Escape should undo one thing, and the
    // menu is the thing most recently opened.
    if (e.key === 'Escape' && ui.prompts) {
      closePromptMenu();
      document.querySelector('[data-act="prompts"]')?.focus();
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
    const bellEl = document.activeElement?.closest?.('svg.room .bell');
    if (bellEl) {
      e.preventDefault();
      bellEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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
  /* First visit lands on the floor, all floors — the less technical face of the
     board. A stored choice (either one) always wins; only the absence of a
     choice defaults here. */
  let initial = 'floor';
  try { initial = (localStorage.getItem('orch.view') ?? 'floor') === 'floor' ? 'floor' : 'board'; } catch { /* default */ }
  setView(initial);
})();
