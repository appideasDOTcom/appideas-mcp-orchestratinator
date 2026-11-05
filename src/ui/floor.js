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
  /* A poll the board has not answered in this long is given up on, and the
     next one runs (task 264). Without a limit one request held open stayed
     pending for as long as the connection did — measured behind a forwarder
     that kept the browser's connection across a board's restart, and the
     live board's own `slow GET /api/state 46764ms` under memory pressure.
     About three periods of app.js's 2.5 s poll, against 7–35 ms normally.
     The same number as app.js's POLL_TIMEOUT_MS: the two scripts share no
     module, and the board's dot is app.js's. */
  const POLL_TIMEOUT_MS = 8000;
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
  const LINK_LABEL = { openhere: 'Open on the floor', handback: 'Open in VS Code', attach: 'Open in tmux', claude: 'Open in Claude', sessions: 'Sessions' };
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
  /* The bulk-selection toolbar (issue #23): a band of its own under the
     header while a room is selecting, rather than a takeover of the header's
     second line. That line is the board's channel stats, and an operator
     choosing which desks to act on is the one reading it most. The desks move
     down to clear the band for as long as it is there; roomGeometry and
     deskXY carry the offset, so an envelope lands where the desk is. */
  const SEL_BAND = 52;
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
  // The hidden desks' pills under a storey (#20): air above the row, and
  // between rows when the names wrap.
  const PILL_ROW_GAP = 10;
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
    // The chat box's height (issue #13): what fitBox last drew it from, a
    // press on it in progress, and heights for desks with no session.
    boxSig: null,
    boxPress: null,      // { el, before } between a pointerdown on the box and its release
    boxLoose: new Map(), // `${channel}|${agent}` -> px, for a desk with no session to file it under
    // A narrow popout's desk gives way to the box (#43 follow-up): the
    // height the box was last drawn at, which popLayout leaves room for, and
    // how much shorter the desk can still be drawn, which fitBox may take.
    boxDrawn: null,
    popFree: null,       // the box's room without that slack, as fitBox last read it
    popSlack: 0,

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
    reading: null,       // a past conversation open to read in the panel — see readingShell
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
    // Bulk selection (issue #23), keyed by channel. A room is selecting while
    // it has an entry in `select`, and the Set is the desks checked on it.
    // Outside the DOM for the bell's reason: a working floor rebuilds every
    // room most ticks, and a check that lived on the node would be gone at
    // the next one. `bulk` is what the last action of each kind did, desk by
    // desk — kept past the end of selecting, because a nudge still in line
    // is what the chat panel's pending bubble reads (bulkWait).
    select: new Map(),
    bulk: new Map(),
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
    // Popouts (issue #19). In a popout, `popout` is the desk it shows, and
    // follows that desk to another floor; on the floor it is null. `outs` is
    // the floor's record of which desks are out, by desk key, from what the
    // popouts themselves say (see "popouts: the windows"); `popWins` the
    // windows this page opened or was handed, for bringing one to the front.
    // `fate` is what a popout last read of its desk (deskFate), and `mem`
    // which folder on which host it last saw the desk bound to — what a move
    // is followed by.
    popout: null,
    outs: new Map(),
    popWins: new Map(),
    fate: null,
    mem: null,
    lastDesk: null,      // the popout's desk as last read, for a header after it is gone
    ended: null,         // a popout re-attached: { open }, and saying where the chat went
    // A meeting room's window (issue #44): its id, floor, participants,
    // messages and notes — see "meeting rooms: the window". Null everywhere
    // else, the floor and a popout included.
    meeting: null,
  };

  let floor = { channels: [], queue: [], totals: {}, cast: [] };
  let floorRead = false;   // an /api/floor has answered at least once (loadTurns)

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
      ` data-channel="${esc(channel)}" data-agent="${esc(d.agent)}">Open conversation</button>` +
      // Move to another floor (#18, Decided 1): Take a desk's move from the
      // agent's side — this desk's folder and host, only the floor to pick.
      // Disabled, with the reason under it, while no live host runs the
      // desk; see moveBlockedWords.
      `<button type="button" class="dp-open dp-hide dp-move" data-act="move-desk"` +
      ` data-channel="${esc(channel)}" data-agent="${esc(d.agent)}"` +
      (moveBlockedWords(d) ? ' disabled' : '') +
      ` title="${esc(moveBlockedWords(d) ?? 'Seat this agent on another floor: its folder is rebound there. A window the floor holds closes and a new conversation opens on the new floor; with no window open, it opens on its last conversation.')}">Move to another floor</button>` +
      (moveBlockedWords(d) ? `<p class="dp-move-why">${esc(moveBlockedWords(d))}</p>` : '') +
      // Put this desk away (#20, Decided 2): under "Open conversation", for
      // any desk this card is open on. It becomes a pill under the storey,
      // and stays one until that pill is clicked, whatever the agent does.
      `<button type="button" class="dp-open dp-hide" data-act="hide-desk"` +
      ` data-channel="${esc(channel)}" data-agent="${esc(d.agent)}"` +
      ` title="Put this desk away: a pill under the storey, shared with everyone looking at this board; the agent keeps working and still counts. Click the pill to bring it back.">Hide desk</button></div>`;
  }

  /** Draw, move or remove the popover to match `ui.details`. */
  function renderDetails() {
    let pop = document.getElementById('desk-pop');
    if (!ui.details) { pop?.remove(); return; }
    const c = floor.channels.find((x) => x.channel === ui.details.channel);
    const d = c?.desks.find((x) => x.agent === ui.details.agent);
    // A desk can vanish under an open popover — retired, its channel archived,
    // put away from this very card, or gone empty under it (#20: a hidden or
    // empty desk is still in the payload, so "still in the payload" is not
    // "still drawn"). Close rather than leave a card describing something that
    // is no longer on the floor.
    // A popout draws its desk whatever the floor does with it — hidden (#20)
    // changes what the floor draws, not the popout (issue #19).
    if (!d || !c || (!ui.popout && !deskRows(c).drawn.includes(d))) { ui.details = null; pop?.remove(); return; }

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

  /* ---------- a question form: what the page decides ---------- */

  /**
   * Which questions of a form have no answer yet, by index.
   *
   * The page's copy of `unansweredOf` in src/floor.js, which is where the
   * ruling and the measurements behind it are written down. The server decides
   * — it refuses the POST — and this exists so Submit can show the question
   * without a round trip, and so the count under the form is the same count.
   * No DOM in it: test/floor.mjs lifts this section out by its two comments and
   * runs it against the server's over the same cases. If the slice fails, the
   * section moved — fix the markers there.
   *
   * `questions` is `[{ options: [{ n, other }] }]`, `answers` is what
   * `askAnswers` reads off the form.
   */
  function askUnanswered(questions, answers) {
    const qs = Array.isArray(questions) ? questions : [];
    const open = [];
    for (let i = 0; i < qs.length; i++) {
      const a = answers?.[i] ?? {};
      const opts = Array.isArray(qs[i]?.options) ? qs[i].options : [];
      const chosen = (Array.isArray(a.choose) ? a.choose : []).map((n) => opts.find((o) => o.n === n)).filter(Boolean);
      const typed = typeof a.text === 'string' && a.text.trim() !== '';
      // A free-text choice with nothing typed is not an answer, whatever else
      // is ticked beside it.
      if (!chosen.length || (!typed && chosen.some((o) => o.other))) open.push(i);
    }
    return open;
  }

  /** What the line under the form says, or null when every question has an answer. */
  function askWarnText(open, total) {
    if (!open.length) return null;
    return `\u26a0 ${total - open.length} of ${total} answered \u2014 Submit sends nothing until every question has an answer`;
  }

  /**
   * What the form says the moment "Type something." is ticked on a
   * single-choice question, or null.
   *
   * On a single-select that row is not a fourth answer: it is the window's
   * clarify hatch, and taking it withdraws the whole form. So the host
   * withdraws it and sends one message with every answer as words instead
   * (`clarifyMessage` in src/floor.js; costmo's ruling on issue #7,
   * 2026-11-02). The person filling the form in is told so before they
   * press Submit, because "Submit all answers" otherwise promises a form
   * that will not be submitted. A multi-select's field is a real field and
   * says nothing. `questions` is `[{ kind, options: [{ n, other }] }]`.
   */
  function askWithdrawText(questions, answers) {
    const qs = Array.isArray(questions) ? questions : [];
    for (let i = 0; i < qs.length; i++) {
      if (qs[i]?.kind === 'multi') continue;
      const opts = Array.isArray(qs[i]?.options) ? qs[i].options : [];
      const a = answers?.[i] ?? {};
      const other = (Array.isArray(a.choose) ? a.choose : []).map((n) => opts.find((o) => o.n === n)).find((o) => o?.other);
      if (!other) continue;
      return qs.length > 1
        ? '\u270e A typed answer withdraws the form in the window \u2014 every answer will be sent as one message in words instead'
        : '\u270e A typed answer withdraws the form in the window \u2014 it will be sent as a message in words instead';
    }
    return null;
  }

  /**
   * What the alert box offers for an open prompt, as one word.
   *
   * Pulled out of the template because the rule that matters is a negative
   * one, and a negative spread over four conditions is how it was broken: a
   * question is never offered as a menu (issue #7, item 3). The board knows a
   * prompt is a question before anyone reads the pane — the hook names the
   * tool — so whenever it has no form to draw for one, this says
   * `question-unread`, and the box says so and offers the window. Three ways
   * used to end at Approve / Deny / Cancel instead:
   *
   *   - the host found no form on the pane and read it as a flat menu
   *     (measured: a form taller than an 80x24 pane loses its header row);
   *   - the host never answered, and the reading spinner gave up to "the
   *     ordinary buttons";
   *   - and with nothing pressable at all, the guess buttons — where Yes
   *     presses `1`, which on a question is its first choice.
   *
   * `reading` is the caller's, because it has a deadline and this has no clock.
   */
  function promptOffer(req, reading) {
    if (!req) return 'none';
    if (req.questions?.length) return 'form';
    if (reading) return 'reading';
    if (req.startup) return 'startup';
    if (req.tool === 'AskUserQuestion') return 'question-unread';
    // An alert nobody could read. Not "no request object" — a permission_prompt
    // notification makes one of those with every choice null, which is exactly
    // the case in question. What decides it is whether anything came back that
    // can be pressed: no approve, no deny, no numbered choices.
    //
    // `req.read` is the difference between "the host looked and found nothing"
    // and "nobody has looked yet". Without it this fired for the second or two
    // every ordinary prompt spends being read, replacing Approve and Deny with
    // guess buttons — and a Yes pressed in that window is a blind keystroke at a
    // prompt the board never saw. Measured live: four of them in a row.
    const pressable = !!req.choices?.approve || !!req.choices?.deny || (req.choices?.extras ?? []).length > 0;
    return req.read && !pressable ? 'unreadable' : 'menu';
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
      <div class="p-ask-note hidden"></div>
      <div class="p-ask-foot">
        <button type="button" class="btn primary" data-act="ask-submit">${qs.length > 1 ? 'Submit all answers' : 'Submit answers'}</button>
        <button type="button" class="btn" data-act="decide" data-choice="cancel" data-request="${esc(req.request_id)}"
                title="The same as pressing Escape in the window">Cancel</button>
      </div>
    </div>`;
  }

  /**
   * How many questions have an answer, said under the form.
   *
   * This used to be the window's own warning with the window's own leniency:
   * Claude Code's review screen says "You have not answered all questions" and
   * still lets you submit, and the floor matched it — "you can still submit" —
   * on the argument that a second door should not be stricter than the first.
   * Ruled out on issue #7 (2026-10-01): a part-filled form sent from here
   * half-sends, the agent carries on one answer short, and the host says
   * "answered". Now Submit goes to the first question without an answer and
   * sends nothing; the person at the window can still do what the window lets
   * them.
   *
   * Counted, because a warning under a form showing one question of three does
   * not say which. Submit is what says which, by showing it.
   */
  function askWarn(form) {
    const warn = form.querySelector('.p-ask-warn');
    if (!warn) return;
    const shape = askShape(form);
    const answers = askAnswers(form);
    const text = askWarnText(askUnanswered(shape, answers), shape.length);
    warn.classList.toggle('hidden', !text);
    if (text) warn.textContent = text;
    // Said the moment the row is ticked, not when Submit is pressed: the
    // choice to type is made with the form still in front of the person.
    const note = form.querySelector('.p-ask-note');
    const withdraw = askWithdrawText(shape, answers);
    if (note) {
      note.classList.toggle('hidden', !withdraw);
      if (withdraw) note.textContent = withdraw;
    }
  }

  /** The form as `askUnanswered` wants it: each question's rows, and which one
   *  is the free-text row. Read off the DOM for the same reason the answers
   *  are — it is what the operator is looking at. */
  function askShape(form) {
    return [...form.querySelectorAll('.p-q')].map((q) => ({
      kind: q.querySelector('input[type="checkbox"]') ? 'multi' : 'single',
      options: [...q.querySelectorAll('input[type="radio"],input[type="checkbox"]')]
        .map((i) => ({ n: Number(i.value), other: i.dataset.other === '1' })),
    }));
  }

  /** Bring one question to the front, the way its tab does. */
  function askShow(form, index) {
    const want = String(index);
    for (const t of form.querySelectorAll('.p-tab')) t.classList.toggle('on', t.dataset.q === want);
    for (const q of form.querySelectorAll('.p-q')) q.classList.toggle('hidden', q.dataset.q !== want);
    // A free-text choice ticked with nothing in it is the one gap that has
    // somewhere to put the cursor.
    const field = form.querySelector(`.p-q[data-q="${want}"] .p-other`);
    if (field && !field.disabled && !field.value.trim()) field.focus();
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

  /* ---------- chat box height: what the page decides ---------- */
  // Pure, and lifted into test/floor.mjs by the two markers around this
  // section — see CLAUDE.md on page logic. Issue #13 (0.10.17).
  //
  // The box grows with its text and keeps a height the operator drags it to.
  // Three numbers decide how tall it is drawn: what the text needs, the
  // operator's height for this session (a floor, never a ceiling), and the
  // room the panel has left. Everything in px.

  /** The starting size, in lines: rows="3" in panelShell, today's box. */
  const BOX_ROWS = 3;
  /** How far the box grows on its own before it scrolls inside. 14 lines is
   *  220px at the box's 15px line; the issue asked for 12–15. */
  const BOX_CAP_ROWS = 14;
  /** Transcript kept in view under a tall box, so the panel never becomes a
   *  text field with a header: about three short turns. */
  const BOX_TURNS_KEEP = 60;

  /** One height per channel + agent + session. The draft is per desk; the
   *  height is per conversation, because a new one starts at the default. */
  const boxHeightKey = (channel, agent, session) => `orch.boxh:${channel}|${agent}|${session}`;
  /** A hosted desk's turns are filed under `host:<host>:<channel>:<agent>`
   *  until its SDK session announces itself (placeholderSession in
   *  src/floor.js). The page sees that string as the desk's session. */
  const isPlaceholderSession = (s) => typeof s === 'string' && s.startsWith('host:');

  /**
   * How tall to draw the box.
   *
   * The operator's height is a floor: never shorter, and the text still grows
   * it past that, up to the larger of that height and the cap. The room is
   * applied last, so the alert slot, the send row and the seat links stay on
   * a panel that is `overflow: hidden` — but never below the starting size.
   */
  function boxHeight({ content, base, cap, set = null, room = Infinity }) {
    const floorH = Math.max(base, set ?? 0);
    const ceil = Math.max(cap, set ?? 0);
    const want = Math.max(floorH, Math.min(content, ceil));
    return Math.max(base, Math.min(want, room));
  }

  /**
   * What a press and release on the box did to the operator's height.
   *
   * Only the operator's drag sets a height: the page's own growing happens on
   * input, never between a press and its release, so a height that changed
   * across one is the drag handle's. A click in the text changes nothing.
   * Dragged back to the starting size (the box's min-height) clears it.
   *
   * `set` is the height already stored for this session, if any. A taller
   * drag sets a height. A shorter one lowers the stored height when it ends
   * below it, and otherwise stores nothing: a box its text holds up cannot
   * be drawn shorter than the text, so a floor dragged under it is one the
   * operator cannot see, and they met it only after the next send emptied
   * the box (QA, PR #39 finding 1: 14 lines drawn at 220, dragged to 120,
   * back to 220 on release, and 120 instead of 55 once emptied).
   */
  function dragOutcome({ before, after, base, set = null }) {
    if (Math.abs(after - before) < 1) return { kind: 'none' };
    if (after <= base + 1) return { kind: 'clear' };
    if (after < before && !(set != null && after < set)) return { kind: 'none' };
    return { kind: 'set', height: Math.round(after) };
  }

  /**
   * A height set while the desk was on its placeholder is that session's, so
   * it goes to the first real id the panel sees. `stored` is this desk's
   * heights by session. The real id keeps its own if it has one; the
   * placeholder's heights are dropped either way, because the next window
   * that opens on this desk is filed under the same placeholder string and
   * must start at the default.
   */
  function boxCarry(session, stored) {
    if (!session || isPlaceholderSession(session)) return null;
    const held = Object.keys(stored ?? {}).filter(isPlaceholderSession);
    if (!held.length) return null;
    const own = stored[session] != null;
    return { to: session, height: own ? null : stored[held[held.length - 1]], drop: held };
  }

  /* ---------- chat box height: the drawing ---------- */

  /** This desk's stored heights, by session. */
  function loadBoxHeights(channel, agent) {
    const prefix = boxHeightKey(channel, agent, '');
    const out = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k?.startsWith(prefix)) continue;
        const h = Number(localStorage.getItem(k));
        if (h > 0) out[k.slice(prefix.length)] = h;
      }
    } catch { /* storage blocked: the box auto-grows and keeps nothing */ }
    return out;
  }
  function saveBoxHeight(channel, agent, session, h) {
    try {
      if (h) localStorage.setItem(boxHeightKey(channel, agent, session), String(h));
      else localStorage.removeItem(boxHeightKey(channel, agent, session));
    } catch { /* as above */ }
  }

  /** The box's starting size and cap, read off its own computed style so a
   *  change to the font or padding in styles.css moves both. */
  function boxMetrics(ta) {
    const cs = getComputedStyle(ta);
    const line = parseFloat(cs.lineHeight) || 15;
    const extra = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
      + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    // scrollHeight counts padding and not border, so `border` is what turns
    // a scrollHeight into the box's border-box height.
    return { base: Math.ceil(line * BOX_ROWS + extra), cap: Math.ceil(line * BOX_CAP_ROWS + extra), border };
  }

  /**
   * The tallest the box may be with everything else still on the panel:
   * the panel's max-height, less every part of it that is not the box or the
   * transcript, less a little transcript. Read each time, because the alert
   * slot above the box grows with a question and shrinks when it is answered.
   */
  function boxRoom(ta, wrap) {
    const turns = $('p-turns');
    const last = wrap.lastElementChild;
    const cs = getComputedStyle(wrap);
    // A popout's panel has no max-height: it is the window's height (issue
    // #19), so that is its limit. Without this the room was unlimited
    // there, and 18 lines or a drag pushed the send row out of the window.
    const max = ui.popout || ui.meeting ? wrap.getBoundingClientRect().height : parseFloat(cs.maxHeight);
    if (!turns || !last || !(max > 0)) return Infinity;
    // Measured from the parts, not from the panel's own height: once a box
    // pushes the panel past its max-height, the panel's height is clamped
    // there and the overflow is merely hidden, so "panel less box" would
    // grow with the box (a red in check-chatbox's mutant without the drag's
    // max-height: the room followed the drag off the panel).
    const w = wrap.getBoundingClientRect();
    const t = turns.getBoundingClientRect();
    const above = t.top - w.top;
    const below = last.getBoundingClientRect().bottom - t.bottom + parseFloat(cs.borderBottomWidth) + parseFloat(cs.paddingBottom);
    // The transcript keeps BOX_TURNS_KEEP, or its own min-height where the
    // stylesheet gives it more (a popout's): a box sized past that pushes
    // the foot off, because the transcript will not shrink to make room.
    const keep = Math.max(BOX_TURNS_KEEP, parseFloat(getComputedStyle(turns).minHeight) || 0);
    return Math.floor(max - above - below + ta.offsetHeight - keep);
  }

  /**
   * Draw the box at its height. Called wherever its text or its desk's
   * session can have changed: every render of the panel (which is how a new
   * session on an open desk is noticed — the shell is not rebuilt for one),
   * and stashDraft, which every path that sets `.value` already calls.
   * Cheap when nothing changed, because the inputs are compared first.
   */
  function fitBox() {
    const ta = $('p-text');
    const wrap = $('floor-panel');
    if (!ta || !wrap?.dataset.agent || wrap.classList.contains('hidden') || !ta.offsetParent) return;
    if (ui.boxPress) return;   // the operator has hold of the handle
    const { channel, agent } = wrap.dataset;
    const session = sessionFilter();
    let set = null;
    if (session) {
      const stored = loadBoxHeights(channel, agent);
      const carry = boxCarry(session, stored);
      if (carry) {
        if (carry.height) { saveBoxHeight(channel, agent, carry.to, carry.height); stored[carry.to] = carry.height; }
        for (const s of carry.drop) { saveBoxHeight(channel, agent, s, null); delete stored[s]; }
      }
      set = stored[session] ?? null;
    } else {
      // No session to file it under (a desk that cannot chat): kept for as
      // long as the page is, and no longer.
      set = ui.boxLoose.get(`${channel}|${agent}`) ?? null;
    }
    const { base, cap, border } = boxMetrics(ta);
    // In a narrow popout the desk above the chat gives way too, once the
    // transcript is down to its least: its slack is part of the box's room,
    // and popLayout draws it shorter to match whatever the box is drawn at.
    // Without it a popout under ~800px tall left the box no room at all, so
    // it neither grew nor took a drag (costmo, #43 follow-up).
    const free = boxRoom(ta, wrap);
    const room = free + (ui.popout ? ui.popSlack : 0);
    const sig = `${channel}|${agent}|${session}|${set}|${room}|${ta.clientWidth}|${ta.value}`;
    if (sig === ui.boxSig) return;
    ui.boxSig = sig;
    // Shrinking it to measure would scroll the transcript out from under a
    // reader who was at the bottom, and the box's own scroll with it.
    const turns = $('p-turns');
    const stuck = turns && turns.scrollHeight - turns.scrollTop - turns.clientHeight < 4;
    const top = ta.scrollTop;
    ta.style.minHeight = `${base}px`;
    ta.style.height = `${base}px`;
    const content = ta.scrollHeight + border;
    const h = boxHeight({ content, base, cap, set, room });
    ta.style.height = `${h}px`;
    // The drag handle obeys the same room, so a drag cannot push the foot off.
    ta.style.maxHeight = Number.isFinite(room) ? `${Math.max(base, room)}px` : '';
    ta.scrollTop = top;
    if (stuck) turns.scrollTop = turns.scrollHeight;
    // The desk is drawn for the box at this height and the rest of the panel
    // as popLayout last measured it. Either changing (the meta line filled
    // in after a reload left the send row 6px off the panel) draws it again;
    // popLayout's own call back here then finds both as it left them.
    if (ui.popout && (h !== ui.boxDrawn || free !== ui.popFree)) { ui.boxDrawn = h; ui.popFree = free; popLayout(); }
  }

  /** The end of a press on the box: if its height moved, the operator dragged
   *  it, and that height is theirs for this desk's session. */
  function endBoxPress() {
    const p = ui.boxPress;
    if (!p) return;
    ui.boxPress = null;
    const ta = $('p-text');
    const wrap = $('floor-panel');
    if (!ta || ta !== p.el || !wrap?.dataset.agent) return;
    const { channel, agent } = wrap.dataset;
    const session = sessionFilter();
    const set = session ? loadBoxHeights(channel, agent)[session] ?? null : ui.boxLoose.get(`${channel}|${agent}`) ?? null;
    const out = dragOutcome({ before: p.before, after: ta.offsetHeight, base: boxMetrics(ta).base, set });
    if (out.kind !== 'none') {
      const h = out.kind === 'set' ? out.height : null;
      if (session) saveBoxHeight(channel, agent, session, h);
      else if (h) ui.boxLoose.set(`${channel}|${agent}`, h);
      else ui.boxLoose.delete(`${channel}|${agent}`);
    }
    ui.boxSig = null;
    fitBox();
  }
  document.addEventListener('pointerdown', (e) => {
    if (e.target?.id === 'p-text' && e.button === 0) ui.boxPress = { el: e.target, before: e.target.offsetHeight };
  }, true);
  // A drag in a narrow popout moves the desk as it goes, so the send row
  // stays on the panel while the box takes the desk's slack. fitBox is
  // still out of the way (boxPress); popLayout only redraws the desk.
  document.addEventListener('pointermove', () => {
    const p = ui.boxPress;
    if (!ui.popout || !p || p.el.offsetHeight === ui.boxDrawn) return;
    ui.boxDrawn = p.el.offsetHeight;
    popLayout();
  }, true);
  document.addEventListener('pointerup', endBoxPress, true);
  document.addEventListener('pointercancel', endBoxPress, true);
  // The panel's max-height is in vh, so the room changes with the window.
  window.addEventListener('resize', () => fitBox());

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
    // Every path that puts text in the box or takes it out comes through
    // here — typing, a draft put back, a prompt inserted, a lost message
    // returned, the box emptied after a send, a command completed — and
    // none of the others fire an `input` event. So the height follows here.
    fitBox();
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
  function roomGeometry(n, collapsed, pillLines = 0, selecting = false) {
    const cols = COLS;
    const rows = collapsed ? 1 : Math.max(1, Math.ceil(Math.max(1, n) / cols));
    // The selection toolbar's band, under the header, when the room has one.
    const top = selecting ? SEL_BAND : 0;
    // The last row contributes only what it draws below the desk origin (the
    // nameplate), not a whole cell — a full DESK_H there leaves every room
    // ending in a band of empty carpet that reads as "somebody is missing".
    // A storey with nothing drawn on it (every desk empty or put away, #20)
    // ends at its header band for the same reason: the row's height is
    // mostly the bubble above it, and there is nobody to speak.
    const bottom = (n ? PAD + HEAD_H + (rows - 1) * (DESK_H + GAP) + DESK_BELOW : HEAD_BAND) + top;
    // The hidden desks' pills, as a tray under the last desk; absent, no height.
    const pillY = bottom + PILL_ROW_GAP;
    return {
      cols,
      rows,
      collapsed: !!collapsed,
      w: ROOM_W,
      top,
      pillY,
      h: (pillLines ? pillY + pillLines * (PILL_H + PILL_ROW_GAP) - PILL_ROW_GAP : bottom) + PAD,
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
  // Returns the board's words when it refused, so a caller with no drawn
  // bell to put them on (a meeting room's participant, issue #44) can say
  // them; null when the nudge went.
  async function strike(channel, agent) {
    const k = ringKey(channel, agent);
    if (ringingSince(k)) return null;         // already pealing; the click is rejected
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
      return String(err.message ?? err);
    }
    window.floorNudged(channel, agent, NUDGE_WORD);
    return null;
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
    for (const el_ of document.querySelectorAll('svg.room .desk')) {
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
    const cy = PAD + HEAD_H + (geo.top ?? 0) + DESK_BELOW / 2;
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
      y: PAD + HEAD_H + (geo.top ?? 0) + row * (DESK_H + GAP),
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
    // A compacting desk says so in its bubble: it is doing nothing else, and
    // for 10–150 s a quotation of its last reply would read as idle.
    const said = d.session?.compacting ? `Compacting the conversation (${d.session.compacting.trigger ?? 'auto'})…` : d.heard ? THINKING : d.last_message?.text;
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

    // Bulk selection's checkbox, when the room is selecting (issue #23).
    // Last, so it lies over the bubble's thought trail, which runs through
    // the same corner.
    if (ui.select.has(channel)) {
      g.classList.toggle('checked', !!ui.select.get(channel)?.has(d.agent));
      g.appendChild(selBox(d, channel));
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

     One way to put a floor away: archive, the server's flag, shared and
     audited. A put-away floor is not a storey, is not in the picker, and is
     drawn in one place on this view — the pill list under "all floors",
     where clicking it restores. The floor can put one away too (the control
     on each storey opens the board's own channel dialog), so the list of
     rooms is a place you can put a room away from without walking into it.

     There used to be a second way, a browser-local "minimize" that this view
     read off the board and kept out of the building alongside archived
     rooms, with both kinds behind a separator at the end of the picker. The
     two were undone in different places and looked alike; see the section
     comment above `onBoard` in app.js for why it went and must not return.

     The totals stay the server's: archived is out of them there, because the
     count of floors in this building is the same number for everyone looking
     at it, and nothing here re-derives them from the same rows.

     Both lists come from app.js — `onBoard`, `putAway`, `pillBar` — so the two
     views cannot disagree about which floors are on them. The `?.` and the
     fallback are the cross-script contract: loading this file alone must not
     crash, but it is not a second definition of "put away". */
  const onFloor = () => window.onBoard?.(floor.channels) ?? (floor.channels ?? []).filter((c) => !c.archived);
  const shelved = () => window.putAway?.(floor.channels) ?? [];

  /* ---------- a desk's place on the floor: what the page decides ---------- */

  /**
   * Empty: nothing live behind the desk (issue #20). Exactly the three
   * nameplate readings — `host offline`, `not reporting`, and the name alone,
   * which the card calls `away` — and nothing else: a hosted desk is live
   * while its host says so, an unhosted one while its hooks are heard or it
   * is waiting on a person, and both of those are the server's `live` and
   * `hosted.live`. Nothing here re-derives them.
   *
   * An empty desk is not drawn, and is back by itself the moment either turns
   * true; nothing is clicked and nothing is recorded (Decided 1). It is not a
   * pill either — a pill is the way back from a decision, and nobody made one.
   * The payload keeps the desk, so every count the storey prints still counts
   * it; `2/5 here` over two desks is the truth about that floor.
   *
   * This reverses, for the drawing only, the server's rule that every agent
   * the board knows gets a desk (buildFloor's comment on it still holds for
   * the payload): the reminder of who still needs the plugin was fifteen
   * nameplates on the live board that nobody could type into.
   */
  const deskEmpty = (d) => !d.live && !d.hosted?.live;

  /**
   * How a storey draws its desks: the ones on it, and the ones the operator
   * put away by hand as a row of pills beneath them (Decided 3). A hidden
   * desk is a pill whatever its agent does meanwhile — live or empty — until
   * the pill is clicked (Decided 5); an empty desk that nobody hid is neither
   * drawn nor a pill. Archive wins: a put-away floor is not a storey, so it
   * has no desk pills either. The page never asks for one (`onFloor` keeps
   * archived channels out of `room`), and this says so too rather than
   * leaving the rule to the caller.
   */
  function deskRows(c) {
    if (c.archived) return { drawn: [], pills: [] };
    const desks = c.desks ?? [];
    return {
      drawn: desks.filter((d) => !d.hidden && !deskEmpty(d)),
      pills: desks.filter((d) => d.hidden),
    };
  }

  /**
   * Why the nameplate card's Move to another floor cannot be pressed (#18),
   * or null when it can. A move is a host rebinding the desk's folder, so it
   * needs the desk's host here and running it — `hosted.live`, exactly when
   * POST /api/floor/desk/move accepts it. The words are Take a desk's
   * `no_host` (noHostWords in src/floor.js), the same sentence either way;
   * test/floor.mjs holds the two copies to it.
   *
   * Drawn disabled with this under it, not left off (the issue's Not
   * established line, the developer's call): a desk drawn without a live
   * host is one that is reporting through an editor or a hook, its host may
   * be a restart away, and a button that is simply absent reads as "this
   * desk can never be moved" — the reason is the useful part.
   */
  function moveBlockedWords(d) {
    if (d?.hosted?.live) return null;
    const host = d?.hosted?.host ?? null;
    return host
      ? `The host ${host} is not on this board right now, so there is nobody to bind it.`
      : 'No host on this board is running this folder, so there is nobody to bind it.';
  }

  /* ---------- a desk's place on the floor: the drawing ---------- */

  /** A desk pill's width, by the same estimate the sign's pills use. */
  const deskPillWidth = (d) => d.agent.length * 6 + 16 + (d.board?.unread ? String(d.board.unread).length * 6 + 14 : 0);

  /**
   * Lay the hidden desks out as a row of pills under the storey's last desk,
   * wrapping when the row is wider than the room — a floor can hide more
   * names than one line holds. Positions are room-local; the row's own top is
   * added by the caller, since it depends on how many desk rows sit above.
   */
  function deskPillTray(pills) {
    const items = [];
    let x = PAD, line = 0;
    for (const d of pills) {
      const w = deskPillWidth(d);
      if (x > PAD && x + w > ROOM_W - PAD) { x = PAD; line++; }
      items.push({ d, x, y: line * (PILL_H + PILL_ROW_GAP), w });
      x += w + 6;
    }
    return { items, lines: pills.length ? line + 1 : 0 };
  }

  /**
   * One pill: the agent's name, its unread count if it has one, and the way
   * back. The name is the id rather than the persona, the way the board's
   * pills name a channel by its id: it is what the .mcp.json says, and the
   * persona is one hover away. The unread count rides on it for the reason
   * the floor's pills carry one — a pill that hid news would make the page
   * lie by omission. Dashed, like those, so it reads as something put away
   * and not as one more control.
   */
  function deskPill(it, channel) {
    const { d, x, y, w } = it;
    const unread = d.board?.unread ?? 0;
    const g = el('g', {
      class: 'deskPill',
      transform: `translate(${x} ${y})`,
      'data-act': 'show-desk',
      'data-channel': channel,
      'data-agent': d.agent,
      role: 'button',
      tabindex: '0',
    });
    g.appendChild(el('rect', { x: 0, y: 0, width: w, height: PILL_H, rx: PILL_H / 2, class: 'deskPillBox' }));
    const name = el('text', { x: 8, y: PILL_H / 2 + 3.5, class: 'deskPillText' });
    name.textContent = d.agent;
    g.appendChild(name);
    if (unread) {
      const cw = String(unread).length * 6 + 8;
      g.appendChild(el('rect', { x: w - cw - 4, y: 2, width: cw, height: PILL_H - 4, rx: (PILL_H - 4) / 2, class: 'deskPillCount' }));
      const n = el('text', { x: w - 4 - cw / 2, y: PILL_H / 2 + 3, 'text-anchor': 'middle', class: 'deskPillCountText' });
      n.textContent = String(unread);
      g.appendChild(n);
    }
    const tip = el('title');
    tip.textContent = `${d.persona} (${d.agent}) — hidden; click to restore the desk` +
      `${unread ? ` · ${unread} unread` : ''}${deskEmpty(d) ? '' : ' · live'}`;
    g.appendChild(tip);
    return g;
  }

  /* ---------- bulk selection: what the page decides ---------- */

  /*
   * Bulk selection on a room (issue #23): the bell, Mark all read (operator)
   * and Hide desk, applied to the desks checked on one storey. Every decision
   * is in here as a plain function over the floor payload, so test/floor.mjs
   * can lift the section and hold each rule to desks the server really
   * built. The drawing and the requests are the callers.
   */

  const bulkSquash = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  /**
   * The desks a room's actions reach: drawn and checked, in drawn order.
   * Only a drawn desk has a checkbox (Decided 2). The Set may still name a
   * desk that has stopped being drawn since it was checked — empty for a
   * poll, or hidden — and such a desk is simply not acted on. It is not
   * forgotten either, so a desk that blinks out and back is still checked.
   */
  const checkedDesks = (drawn, checked) => drawn.filter((d) => checked?.has(d.agent));

  /**
   * Who a bulk nudge types into, in what order, and who it cannot reach.
   *
   * The order was measured, not chosen (task 267 step 1). The host types
   * its work one item at a time (host/index.js `run`), each delivery taking
   * about 3 s for the screen to settle, and a desk with no window holds every
   * desk queued behind it while its window comes up. That is about 1.5 s
   * when the window starts, and READY_TIMEOUT_MS (45 s) when it does not:
   * the three windowed desks behind such a desk landed at 48, 52 and 55 s.
   * Sent last, the windowed desks land at 3, 7 and 10 s whatever the
   * windowless one does, and a window that never comes up keeps only itself
   * waiting. So: windowed desks first, then windowless, each in drawn order.
   *
   * A desk the server says cannot be nudged is not sent anything. The bell
   * does not ring for it either, and the reason is the server's own words
   * (`nudge.reason`, from the deliverable() the chat route refuses with).
   * `base` is the desk's newest turn as drawn. The nudge's own turn, or the
   * error that says it failed, is the first one after it (nudgeOutcome).
   */
  function nudgePlan(desks) {
    const windowed = [];
    const opens = [];
    const blocked = [];
    for (const d of desks) {
      if (!d.nudge?.ok) {
        blocked.push({ agent: d.agent, persona: d.persona, reason: d.nudge?.reason ?? 'Nothing is known about this desk yet.' });
        continue;
      }
      const e = { agent: d.agent, persona: d.persona, host: d.nudge.host ?? null, opens: !!d.nudge.opens, base: d.last_turn?.id ?? 0 };
      (e.opens ? opens : windowed).push(e);
    }
    return { send: [...windowed, ...opens], opens, blocked };
  }

  /**
   * The Nudge control: how many it types into, and how many of those open a
   * window first. Said on the control before it is pressed, because a nudge
   * never opens a window by surprise (nudgeable(), src/floor.js). The bell
   * says it on hover, half-lit. This says it in the label, and names the
   * desks on hover.
   */
  function nudgeChip(plan, busy = false) {
    const n = plan.send.length;
    const o = plan.opens.length;
    const names = (xs) => xs.map((x) => `${x.persona} (${x.agent})`).join(', ');
    const title = [
      n ? `Types “nudge” into ${plural(n, 'desk')}, the open windows first.` : 'Nothing checked can be nudged.',
      o ? `Opens a window first on ${names(plan.opens)}, resuming each one's conversation.` : '',
      ...plan.blocked.map((b) => `Can't nudge ${b.persona} (${b.agent}): ${b.reason}`),
      busy ? 'The last nudge from this room is still in line.' : '',
    ].filter(Boolean).join('\n');
    return { text: `Nudge ${n}${o ? ` · ${o} open${o === 1 ? 's' : ''} a window` : ''}`, title, disabled: !n || busy };
  }

  /**
   * What Mark read does: each checked desk with something unread, marked up
   * to the newest message the page drew for it (`board.unread_max_id`) and
   * no further. A message that arrives after the click stays unread, as it
   * does from the backlog dialog, which sends the id it drew too. The cursor
   * only moves forward, so this is the one action here with no undo, and
   * its count is on the control before it is pressed.
   */
  function readPlan(desks) {
    const rows = desks
      .filter((d) => (d.board?.unread ?? 0) > 0 && Number.isInteger(d.board?.unread_max_id))
      .map((d) => ({ agent: d.agent, persona: d.persona, upTo: d.board.unread_max_id, count: d.board.unread }));
    return { rows, total: rows.reduce((s, r) => s + r.count, 0) };
  }

  function readChip(plan) {
    const { rows, total } = plan;
    return {
      text: `Mark read${total ? ` · ${total}` : ''}`,
      title: total
        ? `Marks ${plural(total, 'message')} read on ${plural(rows.length, 'desk')}, as the operator: ${rows.map((r) => `${r.agent} ${r.count}`).join(', ')}. Read is a cursor and only moves forward, so this cannot be undone. Anything that arrives after this click stays unread.`
        : 'Nothing checked has anything unread.',
      disabled: !total,
    };
  }

  /** Hide: each checked desk becomes a pill under the storey, as Hide desk does (#20). No bulk unhide (Decided 3). */
  function hideChip(desks) {
    return {
      text: `Hide ${desks.length}`,
      title: desks.length
        ? `Puts ${plural(desks.length, 'desk')} away as pills under this storey. Each comes back from its own pill. The desks keep working and are still counted.`
        : 'Nothing checked.',
      disabled: !desks.length,
    };
  }

  /**
   * What a desk's turns since the bulk nudge say happened to it, or null
   * while they say nothing yet.
   *
   * The receipt is the one the chat panel settles on (settle()): the word
   * as a user turn means the window took it, and an error turn means the
   * host could not deliver it. An error turn carries no tag saying which
   * message it was about, so an unrelated error landing first reads as this
   * nudge failing. The panel reads it the same way and hands the words back
   * to the composer, and that is the closer of two wrong readings: "not
   * nudged, here is why" sends the operator to look, while calling it
   * delivered would be a claim with nothing behind it.
   */
  function nudgeOutcome(rows, word = 'nudge') {
    for (const r of [...(rows ?? [])].sort((a, b) => a.id - b.id)) {
      if (r.role === 'user' && bulkSquash(r.text).includes(word)) return { state: 'sent' };
      if (r.role === 'error') return { state: 'failed', words: r.text || 'the host could not deliver it' };
    }
    return null;
  }

  /**
   * How many of this bulk nudge's own desks are ahead of `agent` in its host's
   * line, still unresolved. Same host only: each host has its own line.
   */
  function aheadOf(entries, agent) {
    const at = entries.findIndex((e) => e.agent === agent);
    if (at < 0) return 0;
    const host = entries[at].host;
    return entries.slice(0, at).filter((e) => e.host === host && e.state === 'line').length;
  }

  /**
   * What the chat panel's pending bubble says about a nudge this room sent
   * in bulk, and whether its silence clock may run.
   *
   * The clock is SENDING_GRACE_MS of silence before "not recorded — send
   * again", and the step-1 measurement is why it cannot simply start at
   * the click. A desk queued behind others on its host waits about 3 s for
   * each of them, and 45 s behind a window that never comes up. Either can
   * pass 30 s with nothing wrong: two windowless desks, or ten windowed ones.
   * So the clock waits on facts. While a desk of this bulk is ahead of it on
   * the host, it does not run and the bubble says so. While its own window
   * is still being opened, it does not run either, because the host is the
   * one waiting, and it gives up with an error turn of its own at 45 s. It
   * starts once the line in front is clear and the window is up, and then
   * it means what it always meant.
   *
   * `opening` is the desk's own payload saying it still has no window.
   */
  function bulkWait(entries, agent, opening = false) {
    const e = entries?.find((x) => x.agent === agent);
    if (!e || e.state !== 'line') return null;
    const ahead = aheadOf(entries, agent);
    if (ahead) return { hold: true, note: `in line — ${plural(ahead, 'desk')} ahead on ${e.host ?? 'its host'}` };
    if (e.opens && opening) return { hold: true, note: 'opening its window — the host waits up to 45 s for it' };
    // From whichever came last: the front of the line, or its window coming up.
    return { hold: false, since: Math.max(e.front ?? 0, e.opens ? e.readyAt ?? 0 : 0) };
  }

  /** A checked desk's word under its checkbox: what the last action did to it, or what is true of it before one. */
  function bulkTag(rec, agent, desk) {
    const e = rec?.entries?.find((x) => x.agent === agent);
    if (e) {
      if (rec.kind === 'nudge') {
        if (e.state === 'line') {
          // "opening" only at the front: behind others, its window has not
          // been asked for yet, and saying so would be a guess.
          const ahead = aheadOf(rec.entries, agent);
          if (ahead) return { text: 'in line', kind: 'wait', title: `Sent; ${plural(ahead, 'desk')} ahead of it on ${e.host ?? 'its host'}` };
          return e.opens && desk?.nudge?.opens
            ? { text: 'opening', kind: 'wait', title: 'Sent; the host is opening its window, and waits up to 45 s for it' }
            : { text: 'in line', kind: 'wait', title: 'Sent; the host has not typed it in yet' };
        }
        if (e.state === 'sent') return { text: 'nudged', kind: 'ok', title: 'The window took the nudge' };
        return { text: 'not nudged', kind: 'bad', title: e.words ?? '' };
      }
      // `sending` is a request still on its way: nothing to report yet, and
      // "not marked" would be a verdict before the answer.
      if (rec.kind === 'read') {
        if (e.state === 'sending') return { text: 'marking', kind: 'wait', title: '' };
        return e.state === 'done'
          ? { text: `read ${e.cleared ?? e.count}`, kind: 'ok', title: `Marked read up to message ${e.upTo}` }
          : { text: 'not marked', kind: 'bad', title: e.words ?? '' };
      }
      // A desk that was hidden is a pill; if it is drawn again, its pill
      // brought it back, and there is nothing left to say about the hide.
      if (rec.kind === 'hide') return e.state === 'failed' ? { text: 'not hidden', kind: 'bad', title: e.words ?? '' } : null;
    }
    if (desk && !desk.nudge?.ok) return { text: "can't nudge", kind: 'note', title: desk.nudge?.reason ?? '' };
    if (desk?.nudge?.opens) return { text: 'no window', kind: 'note', title: 'Nudging this desk opens its window first, resuming its conversation' };
    return null;
  }

  /** One action's result, for the toolbar's second line. Every desk is counted, and the ones it did not reach are named. */
  function bulkSummary(rec) {
    if (!rec?.entries?.length) return '';
    const n = (s) => rec.entries.filter((e) => e.state === s).length;
    const missed = rec.entries.filter((e) => e.state === 'refused' || e.state === 'failed');
    const named = missed.length ? ` — ${missed.map((e) => e.agent).join(', ')}` : '';
    if (rec.kind === 'nudge') {
      const parts = [n('sent') && `${n('sent')} nudged`, n('line') && `${n('line')} in line`, missed.length && `${missed.length} not nudged${named}`];
      return `nudge: ${parts.filter(Boolean).join(' · ')}`;
    }
    if (rec.kind === 'read') {
      const done = rec.entries.filter((e) => e.state === 'done');
      const cleared = done.reduce((s, e) => s + (e.cleared ?? e.count ?? 0), 0);
      const parts = [done.length && `${plural(cleared, 'message')} read on ${plural(done.length, 'desk')}`, missed.length && `${missed.length} not marked${named}`];
      return `mark read: ${parts.filter(Boolean).join(' · ')}`;
    }
    const parts = [n('done') && `${n('done')} hidden`, missed.length && `${missed.length} not hidden${named}`];
    return `hide: ${parts.filter(Boolean).join(' · ')}`;
  }

  /* ---------- bulk selection: the drawing ---------- */

  /* 11px mono advances about 6.6 units at the room's scale: what the header's
     right-hand controls are laid out by, the way deskPillWidth estimates. */
  const MONO_W = 6.6;

  /** What every action of this room last did, newest first, as one line. */
  function bulkLine(channel) {
    const b = ui.bulk.get(channel);
    if (!b) return '';
    return ['nudge', 'read', 'hide'].map((k) => b[k]).filter(Boolean)
      .sort((x, y) => y.at - x.at).map(bulkSummary).filter(Boolean).join('   ·   ');
  }

  /** The newest action of this room that touched `agent`: what its tag reports. */
  function bulkRecFor(channel, agent) {
    const b = ui.bulk.get(channel);
    if (!b) return null;
    // A nudge still in line outranks anything newer: it is the one thing
    // still happening, and the tag is how the operator sees it finish.
    const live = b.nudge?.entries.some((e) => e.agent === agent && e.state === 'line') ? b.nudge : null;
    return live ?? ['nudge', 'read', 'hide'].map((k) => b[k])
      .filter((r) => r?.entries.some((e) => e.agent === agent))
      .sort((x, y) => y.at - x.at)[0] ?? null;
  }

  /** A control in the toolbar: a chip the size of a word, disabled with its reason. */
  function selChip(x, act, chip, channel, y = 6) {
    const w = chip.text.length * MONO_W + 16;
    const g = el('g', {
      class: `selChip${chip.disabled ? ' disabled' : ''}`, transform: `translate(${x} ${y})`,
      'data-act': act, 'data-channel': channel, 'data-fk': `${channel}|${act}`,
      role: 'button', tabindex: '0', 'aria-disabled': chip.disabled ? 'true' : 'false',
    });
    g.appendChild(el('rect', { x: 0, y: 0, width: w, height: 21, rx: 10.5, class: 'selChipBox' }));
    g.appendChild(el('text', { x: 8, y: 14.5, class: 'selChipText' })).textContent = chip.text;
    g.appendChild(el('title')).textContent = chip.title;
    return { g, w };
  }

  /**
   * The toolbar, in its own band under the header: check all, the count,
   * the three actions, and on the line under them what the last of each
   * did. On the room and not on the desk track, so a collapsed storey
   * scrolling its desks does not scroll its controls away.
   */
  function selToolbar(c, drawn, geo) {
    const ch = c.channel;
    const checked = ui.select.get(ch) ?? new Set();
    const desks = checkedDesks(drawn, checked);
    const g = el('g', { class: 'selBar', transform: `translate(0 ${HEAD_BAND})` });
    g.appendChild(el('rect', { x: 0, y: 0, width: geo.w, height: SEL_BAND, class: 'selBand' }));

    // Check all / uncheck all, one control: all checked reads as checked,
    // some as mixed, and pressing it from either state goes to the other end.
    const all = desks.length > 0 && desks.length === drawn.length;
    const some = desks.length > 0 && !all;
    const box = el('g', {
      class: `selAll${all ? ' on' : ''}${some ? ' some' : ''}`, transform: `translate(${PAD - 6} 9)`,
      'data-act': 'sel-all', 'data-channel': ch, 'data-fk': `${ch}|sel-all`,
      role: 'checkbox', tabindex: '0', 'aria-checked': all ? 'true' : some ? 'mixed' : 'false',
      'aria-label': all ? 'Uncheck all desks on this floor' : 'Check all desks on this floor',
    });
    box.appendChild(el('rect', { x: 0, y: 0, width: 15, height: 15, rx: 3, class: 'selAllBox' }));
    if (all) box.appendChild(el('path', { d: 'M 3.5 7.8 L 6.4 10.6 L 11.6 4.6', class: 'selMark' }));
    else if (some) box.appendChild(el('path', { d: 'M 4 7.5 L 11 7.5', class: 'selMark' }));
    box.appendChild(el('text', { x: 21, y: 11.5, class: 'selText' })).textContent = all ? 'uncheck all' : 'check all';
    box.appendChild(el('title')).textContent = all ? 'Uncheck every desk on this floor' : `Check every desk drawn on this floor (${drawn.length})`;
    g.appendChild(box);

    let x = PAD - 6 + 21 + (all ? 11 : 9) * MONO_W + 14;
    const count = el('text', { x, y: 20.5, class: 'selText' });
    count.textContent = `${desks.length} of ${drawn.length}`;
    g.appendChild(count);
    x += `${desks.length} of ${drawn.length}`.length * MONO_W + 16;

    const busy = !!ui.bulk.get(ch)?.nudge?.entries.some((e) => e.state === 'line');
    for (const [act, chip] of [
      ['sel-nudge', nudgeChip(nudgePlan(desks), busy)],
      ['sel-read', readChip(readPlan(desks))],
      ['sel-hide', hideChip(desks)],
    ]) {
      const { g: cg, w } = selChip(x, act, chip, ch);
      g.appendChild(cg);
      x += w + 8;
    }
    // Meeting room (issue #44), after the three. When the row is already
    // full — a long Nudge label, a big unread count — it stands at the
    // right end of the line under them, and the summary gives it room.
    const meet = meetingChip(desks, outsNow(ui.outs, Date.now()), ch);
    const meetW = meet.text.length * MONO_W + 16;
    const right = geo.w - PAD + 6;
    const wrapped = x + meetW > right;
    g.appendChild(selChip(wrapped ? right - meetW : x, 'sel-meeting', meet, ch, wrapped ? 27 : 6).g);

    const said = [meetSelNote.get(ch), bulkLine(ch)].filter(Boolean).join('   ·   ');
    const sum = el('text', { x: PAD - 6, y: 43, class: 'selSum' });
    const room_ = Math.floor((geo.w - (PAD - 6) * 2 - (wrapped ? meetW + 8 : 0)) / 5.9);
    sum.textContent = said.length > room_ ? `${said.slice(0, room_ - 1)}…` : said || 'Click a desk to check it.';
    if (said) sum.appendChild(el('title')).textContent = said;
    g.appendChild(sum);
    return g;
  }

  /**
   * A desk's checkbox, over the space above the desk where the bell stands
   * (the issue's "roughly above the service bell"), large enough to hit at
   * floor zoom. Under it, what the last action did to this desk, or what is
   * true of it before one: no window, or can't be nudged.
   */
  function selBox(d, channel) {
    const on = !!ui.select.get(channel)?.has(d.agent);
    const g = el('g', {
      class: `selBox${on ? ' on' : ''}`,
      'data-act': 'sel-desk', 'data-channel': channel, 'data-agent': d.agent, 'data-fk': `${channel}|sel|${d.agent}`,
      role: 'checkbox', tabindex: '0', 'aria-checked': on ? 'true' : 'false',
      'aria-label': `${on ? 'Uncheck' : 'Check'} ${d.persona} (${d.agent})`,
    });
    g.appendChild(el('rect', { x: BELL_CX - 13, y: 2, width: 26, height: 26, rx: 5, class: 'selBoxRect' }));
    if (on) g.appendChild(el('path', { d: `M ${BELL_CX - 7} 15 L ${BELL_CX - 2} 20.5 L ${BELL_CX + 7.5} 9`, class: 'selMark' }));
    // A result stays on a desk that was acted on, checked or not. The
    // notes that come before an action are about what a click would do, so
    // they are for checked desks only.
    const rec = bulkRecFor(channel, d.agent);
    const tag = (rec ? bulkTag(rec, d.agent, d) : null) ?? (on ? bulkTag(null, d.agent, d) : null);
    if (tag) {
      const t = el('text', { x: BELL_CX, y: 40, 'text-anchor': 'middle', class: `selTag ${tag.kind}` });
      t.textContent = tag.text;
      if (tag.title) t.appendChild(el('title')).textContent = tag.title;
      g.appendChild(t);
    }
    return g;
  }

  function room(c) {
    const collapsed = inBuilding();
    const { drawn, pills } = deskRows(c);
    const tray = deskPillTray(pills);
    const selecting = ui.select.has(c.channel);
    const geo = roomGeometry(drawn.length, collapsed, tray.lines, selecting);
    const svg = el('svg', {
      class: `room${collapsed ? ' collapsed' : ''}${selecting ? ' selecting' : ''}`,
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

    // The way to put this floor away, from the list of floors: it opens the
    // board's channel dialog — the same Archive, with the same audit row —
    // so there is one archive, reached from two views. Only under "all
    // floors", which is the list; a floor you are standing on is reached by
    // its chip, and the list is where you put rooms away from. Under the
    // stats line rather than the name so it reads as a control, not a title.
    if (!ui.floorFilter) {
      const put = el('text', { x: geo.w - PAD + 6, y: 41, class: 'roomPut', 'text-anchor': 'end', 'data-act': 'archive-floor', 'data-channel': c.channel, role: 'button', tabindex: '0' });
      put.textContent = 'put away';
      put.appendChild(el('title')).textContent = `Archive ${c.channel} — off the board and the floor, kept as a pill below; agents on it keep working`;
      svg.appendChild(put);
    }

    // Bulk selection's own control (issue #23), on every room in both views
    // (Decided 1), left of put away when that is drawn. A room with nothing
    // drawn has nothing to check, so it has no control either. A room
    // already selecting keeps its control, so the way out is always there.
    if (drawn.length || selecting) {
      const putW = ui.floorFilter ? 0 : 'put away'.length * MONO_W + 16;
      const sel = el('text', {
        x: geo.w - PAD + 6 - putW, y: 41, class: `roomSel${selecting ? ' on' : ''}`, 'text-anchor': 'end',
        'data-act': 'select-room', 'data-channel': c.channel, 'data-fk': `${c.channel}|select-room`,
        role: 'button', tabindex: '0', 'aria-pressed': selecting ? 'true' : 'false',
      });
      sel.textContent = selecting ? 'done selecting' : 'select desks';
      sel.appendChild(el('title')).textContent = selecting
        ? 'Leave bulk selection. The checks are forgotten, and anything still on its way carries on.'
        : `Check desks on ${c.channel} to nudge, mark read or hide several at once`;
      svg.appendChild(sel);
    }
    if (selecting) svg.appendChild(selToolbar(c, drawn, geo));

    // Envelopes are appended to this layer so they sit above the furniture and
    // can be removed without touching anything that was drawn from data.
    const mail = el('g', { class: 'mailLayer' });

    // Desks and mail ride the same group, so a scrolled storey carries its
    // envelopes with it. deskXY() coordinates are track-local either way; in the
    // full-floor view the track simply never moves.
    const track = el('g', { class: 'deskTrack' });
    drawn.forEach((d, i) => track.appendChild(desk(d, i, geo, c.channel)));
    track.appendChild(mail);

    // The desks put away by hand, as pills under the last desk. On the room
    // and not on the track: a collapsed storey scrolls its desks, and the
    // pills are the way back, which must not scroll out of reach.
    const trayG = el('g', { class: 'deskPills', transform: `translate(0 ${geo.pillY})` });
    for (const it of tray.items) trayG.appendChild(deskPill(it, c.channel));

    if (!collapsed) {
      svg.appendChild(track);
      if (tray.items.length) svg.appendChild(trayG);
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
    if (tray.items.length) svg.appendChild(trayG);
    applyScroll(svg, drawn.length);
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
    // sends it to a desk that is not there. The same goes for which desks are
    // drawn: positions are among the desks on the storey, not the payload's
    // list, and a desk that is empty or put away is nowhere an envelope can
    // land, so it is skipped.
    const { drawn } = deskRows(c);
    // Selecting moves the desks down by the toolbar's band; ask the same way
    // room() did, or the envelope lands a band above the desk.
    const geo = roomGeometry(drawn.length, svg.classList.contains('collapsed'), 0, ui.select.has(channel));
    const idx = (a) => drawn.findIndex((d) => d.agent === a);
    const from = idx(fromAgent);
    if (from < 0) return;

    const targets = toAgent
      ? [idx(toAgent)].filter((i) => i >= 0)
      : drawn.map((_, i) => i).filter((i) => i !== from);
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

  // `desk` names whose turn this is, for a transcript holding several desks'
  // (a meeting room, issue #44): it stands where "agent" would, and ahead of
  // every quiet line. The panel and a popout hold one desk and pass none.
  function turnNode(t, desk = null) {
    const div = document.createElement('div');
    div.dataset.id = t.id;
    const by = desk ? `${desk} · ` : '';
    if (t.role === 'tool') {
      div.className = 't t-tool';
      // A subagent's tool call carries the subagent's description — the same
      // label the chat puts over its words, so the two read as one thread.
      div.innerHTML = `<span class="t-dot"></span><span class="t-text mono">${esc(by)}${esc(t.via ? `${t.via} · ` : '')}${esc(t.text ?? t.tool_name)}</span>`;
      return div;
    }
    if (t.role === 'context' && t.tool_name === 'task-notification') {
      const note = noteNode(t);
      if (note && desk) note.querySelector('.t-who')?.prepend(document.createTextNode(by));
      if (note) return note;
    }
    if (t.role === 'context' && t.tool_name === 'compact-summary') {
      // The summary a compaction leaves behind: a system record, 5–19k
      // characters, drawn closed — it is what the agent was handed, not
      // anything anyone said, and it used to arrive as "you:" (issue #15).
      const text = t.text ?? '';
      div.className = 't t-tool t-context t-compact';
      div.innerHTML = `<details><summary><span class="t-dot"></span><span class="t-text mono">${esc(by)}compaction summary · ${text.length.toLocaleString('en-US')} characters</span></summary><pre class="t-compact-body"></pre></details>`;
      div.querySelector('pre').textContent = text;
      return div;
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
      div.innerHTML = `<span class="t-dot"></span><span class="t-text mono">${esc(by)}${esc(t.tool_name ? `${t.tool_name} · ` : '')}${esc(inner)}</span>`;
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
      <div class="t-thought" role="note" aria-label="${esc(t.via ? `Thought from ${t.via}` : desk ? `Thought from ${desk}` : 'Thought')}">
        <div class="t-body">${esc(t.text ?? '')}</div>
        <div class="t-thought-meta mono">${esc(by)}${esc(t.via ? `${t.via} · ` : '')}<span class="t-when" data-at="${esc(t.created_at)}">${esc(ago(t.created_at))}</span></div>
      </div>`;
      return div;
    }
    // A subagent speaking is labeled as such. Its words are still the desk's —
    // the editor shows them under the Agent call for the same reason — but
    // "agent" alone would have the desk appear to change subject mid-thought.
    const speaker = desk ?? 'agent';
    const who = t.role === 'user' ? 'you' : t.role === 'assistant' ? (t.via ? `${speaker} · ${t.via}` : speaker) : `${by}${t.role}`;
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
  /**
   * The buttons at the right of the panel's header. On the floor: detach,
   * then close. In a popout: Re-attach in place of close (issue #19) — the
   * popout's own window close does the same, and a ✕ there would read as
   * closing the conversation rather than sending it back.
   */
  function panelEnds(channel, agent) {
    if (ui.popout) return '<button class="btn" data-act="reattach" title="Close this window and put the chat back in the floor\u2019s panel">Re-attach</button>';
    return `<button class="btn p-detach" data-act="detach" data-channel="${esc(channel)}" data-agent="${esc(agent)}" title="Open this chat in a window of its own, beside the floor" aria-label="Detach into its own window">\u29c9</button>
        <button class="btn" data-act="close-panel" title="Close">\u2715</button>`;
  }

  /**
   * The floor's panel for a desk whose chat is in a popout: the header as it
   * always is, and in place of the chat one way to bring it back. No
   * composer and no stream — one place types into a desk, and it is the
   * popout (issue #19). The detach button in the header brings the popout to
   * the front.
   */
  function outShell(wrap, channel, agent, meeting = false) {
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
        ${panelEnds(channel, agent)}
      </div>
      <div class="p-meta mono muted"></div>
      <div class="p-out">
        <p class="muted p-out-why"></p>
        <button class="btn primary" data-act="bring-back" data-channel="${esc(channel)}" data-agent="${esc(agent)}"${meeting ? ' title="Take this desk out of the meeting room; the room carries on with the others"' : ''}>${meeting ? 'Bring back from the meeting room' : 'Bring chat back here'}</button>
      </div>`;
  }

  /**
   * A popout whose chat has gone: re-attached to the floor (and the browser
   * would not let the page close its own window), or its desk left or gone
   * from the board. The header stays, so it is plain whose this was; the
   * window never goes blank and never shows another desk.
   */
  function endShell(wrap, channel, agent, why) {
    stashDraft();
    closePromptMenu();
    closeStream();
    wrap.dataset.channel = channel;
    wrap.dataset.agent = agent;
    wrap.dataset.ended = why;
    wrap.innerHTML = `
      <div class="p-head">
        <div class="p-id">
          <span class="p-persona-read"></span>
          <span class="mono muted">${esc(channel)}/${esc(agent)}</span>
        </div>
      </div>
      <div class="p-meta mono muted"></div>
      <div class="p-out">
        <p class="p-out-why"></p>
        <button class="btn primary" data-act="close-window">Close this window</button>
      </div>`;
  }

  /**
   * The desk itself, in a popout (issue #19): the floor's own desk(), from
   * the thought bubble down to the pill tray, in an SVG of its own. `room`
   * on it is what lets the one click handler reach its bell, pills, sign
   * and nameplate, so each does here exactly what it does on the floor. It
   * is not in a room, so no room's selection reaches it (#23: selection is
   * the floor's). Redrawn only when the desk changes, for the reason the
   * rooms are.
   */
  function drawPopDesk(wrap, d, channel) {
    const slot = wrap.querySelector('.p-deskslot');
    if (!slot) return;
    const sig = JSON.stringify([channel, d]);
    if (slot.dataset.sig === sig) return;
    slot.dataset.sig = sig;
    // deskXY puts desk 0 at (PAD, PAD + HEAD_H + top); this `top` makes that (PAD, 0).
    const geo = { cols: 1, rows: 1, collapsed: false, w: DESK_W, top: -(PAD + HEAD_H) };
    const x0 = PAD - 8;
    const y0 = -BUBBLE_ABOVE - 6;
    const w = DESK_W + 16;
    const h = DESK_BELOW + BUBBLE_ABOVE + 12;
    const svg = el('svg', { class: 'room popdesk', viewBox: `${x0} ${y0} ${w} ${h}`, 'data-channel': channel, preserveAspectRatio: 'xMidYMin meet' });
    svg.appendChild(el('rect', { x: x0, y: y0, width: w, height: h, rx: 10, class: 'roomFloor' }));
    svg.appendChild(desk(d, 0, geo, channel));
    // The desk only: in a wide popout the panel's foot lives in this slot
    // too (popLayout, #43), and replacing the slot's children would take it.
    const old = slot.querySelector('svg.popdesk');
    if (old) old.replaceWith(svg); else slot.prepend(svg);
    popLayout();
  }

  function panelShell(wrap, channel, agent) {
    // Whose panel this is, as a DOM fact. The shell is rebuilt in the same
    // synchronous pass that gates the links beneath it, so anything reading
    // the strip can wait on this instead of racing openDesk's async render —
    // which is exactly how a headless check read one desk's buttons against
    // the next desk's name.
    // The old shell's box goes with the old shell. File it first — under the
    // desk it was typed for, which is still what the dataset says.
    stashDraft();
    // A new box, drawn at no height yet: whatever fitBox last compared is
    // about the element going away.
    ui.boxSig = null;
    ui.boxPress = null;
    ui.boxDrawn = null;
    ui.popFree = null;
    ui.popSlack = 0;
    wrap.dataset.channel = channel;
    wrap.dataset.agent = agent;
    delete wrap.dataset.ended;
    wrap.innerHTML = `
      <div class="p-head">
        <div class="p-id">
          <button class="p-persona" data-act="rename" data-channel="${esc(channel)}" data-agent="${esc(agent)}"
                  title="Rename — everyone sees the same name"></button>
          <span class="mono muted">${esc(channel)}/${esc(agent)}</span>
        </div>
        ${panelEnds(channel, agent)}
      </div>
      <div class="p-meta mono muted"></div>
      ${ui.popout ? '<div class="p-deskslot"></div>' : ''}
      <div class="p-turns" id="p-turns"></div>
      <div class="p-compose">
        <!-- Where the question is, not where the panel begins. It used to sit up
             here under the meta line, above a scrolling transcript — so on any
             conversation longer than a screen the thing waiting on you was off
             the top while your eyes were at the bottom, in the box you type in.
             It belongs against the box. -->
        <div class="p-alert-slot"></div>
        <textarea id="p-text" class="input" rows="3"></textarea>
        <!-- The commands the floor offers, drawn while the box holds the
             start of one. Tab or a click completes; Enter sends what is
             typed, as it always has. -->
        <div class="p-slash hidden" role="listbox"></div>
        <div class="p-actions">
          <span class="muted p-hint"></span>
          <button class="btn stopbtn" data-act="stop" aria-label="Stop this turn"><svg class="stopGlyph" viewBox="${STOP_BOX}" aria-hidden="true"><polygon points="${STOP_PTS}" /></svg></button>
          <button class="btn promptbtn" data-act="prompts" aria-label="Saved prompts" aria-haspopup="menu" aria-expanded="false"><svg class="promptGlyph" viewBox="${PROMPT_BOX}" aria-hidden="true">${PROMPT_GLYPH}</svg></button>
          <button class="btn primary" data-act="send">Send</button>
        </div>
        <!-- The panel's foot, in two columns: the seat links down the left,
             the desk's own controls down the right. One row for both, so
             neither leaves a blank where the other's column starts — the
             links used to sit under a right-aligned button row, with an
             empty corner on each side of the fold. -->
        <div class="p-foot">
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
        <!-- Which of the folder's conversations the window is on, and whether
             the folder stays a desk at all. Buttons, not links: they act on
             the desk rather than move the seat, and six links in a column
             read as a menu nobody asked for. Two rows of two (#10 Decided 5):
             model and effort above, Sessions and Leave desk below; the grid
             is in styles.css and the order here is the reading order. -->
        <div class="p-desk">
          <!-- The model and the effort level, for this session only: the host
               drives the window's own picker and presses s. What the window
               confirmed is selected; what was asked for shows beside it until
               the picker says so. -->
          <span class="p-asked mono muted hidden"></span>
          <select class="input p-sel" data-act="set-model" title="Change the model for this session only — the window's own picker, with s" aria-label="Model for this session"></select>
          <select class="input p-sel" data-act="set-effort" title="Change the effort level for this session only — the window's own picker, with s" aria-label="Effort for this session"></select>
          <button class="btn" data-act="sessions" title="Pick another of this folder's conversations for the desk, or start a new one">${LINK_LABEL.sessions}</button>
          <!-- The reverse of taking a desk: the binding goes, the window
               closes, the seat stays. Always confirmed in a dialog first.
               Dims rather than vanishes, with the server's reason as its
               title. -->
          <button class="btn" data-act="leave-desk" title="Remove this desk's binding and close its window">Leave desk</button>
        </div>
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

  /* ---------- a conversation opened to read ---------- */

  /**
   * A past conversation, opened to read, in its own desk's panel.
   *
   * Reading is not resuming, and the panel has to say so before anybody
   * types: this is not the conversation the desk is on, nothing here is live,
   * and a message written under it would go to a different conversation. So
   * the shell is a different shell — a banner naming what is being read with
   * the way back to live in it, a different ground, and no message box, no
   * send, no stop, no seat links, no Sessions, no Leave: nothing that acts.
   * Not disabled controls, which invite the question of why; absent ones.
   *
   * The turns are the whole transcript, read by the host (`/api/floor/read`)
   * rather than the board's copy, which is a tail. They are drawn by the
   * same turnNode the live panel uses, so a tool call, a thought and a
   * subagent's words look here exactly as they did when they happened. The
   * live conversation keeps arriving underneath, into ui.turns, and is drawn
   * again the moment the person goes back — nothing is lost by reading.
   */
  function readingShell(wrap, channel, agent, r) {
    stashDraft();          // the live shell's box is about to go; what was typed in it is kept
    wrap.dataset.channel = channel;
    wrap.dataset.agent = agent;
    wrap.dataset.reading = r.sessionId;
    wrap.classList.add('reading');
    wrap.innerHTML = `
      <div class="p-head">
        <div class="p-id">
          <span class="p-persona-read"></span>
          <span class="mono muted">${esc(channel)}/${esc(agent)}</span>
        </div>
        <button class="btn" data-act="close-panel" title="Close">✕</button>
      </div>
      <div class="p-reading" role="status">
        <div class="p-reading-what"><span class="p-reading-tag">Reading</span> <b class="p-reading-title"></b></div>
        <div class="p-reading-state muted"></div>
        <button class="btn" data-act="read-back" title="Leave this conversation and show the one the desk is on now">Back to live</button>
      </div>
      <div class="p-turns" id="p-turns"></div>`;
    wrap.querySelector('.p-reading-title').textContent = r.title || '(untitled)';
  }

  function renderReading(wrap, d) {
    const r = ui.reading;
    const forKey = `${r.channel}|${r.agent}|read|${r.sessionId}`;
    if (ui.panelFor !== forKey) {
      readingShell(wrap, r.channel, r.agent, r);
      ui.panelFor = forKey;
      r.drawn = 0;
      closePromptMenu();
    }
    wrap.classList.remove('hidden');
    wrap.querySelector('.p-persona-read').textContent = d.persona;
    const n = r.rows.length;
    const turnsText = `${n} turn${n === 1 ? '' : 's'}`;
    wrap.querySelector('.p-reading-state').textContent = r.error ? r.error
      : r.done ? `A past conversation, as it was — the whole of it, ${turnsText}. Nothing here is live.`
        : n ? `Reading it off ${d.hosted?.host ?? 'the host'}… ${turnsText} so far.`
          : `Asking ${d.hosted?.host ?? 'the host'} to read it…`;
    wrap.querySelector('.p-reading').classList.toggle('failed', !!r.error);
    const box = $('p-turns');
    for (const t of r.rows.slice(r.drawn)) {
      const node = turnNode(t);
      // What a search found, marked — so a conversation of two thousand turns
      // opens on the turn that was looked for rather than at its first word.
      if (r.find && String(t.text ?? '').toLowerCase().includes(r.find)) node.classList.add('t-found');
      box.appendChild(node);
    }
    r.drawn = n;
    if (r.done && !r.settled) {
      r.settled = true;
      const hit = box.querySelector('.t-found');
      if (hit) hit.scrollIntoView({ block: 'center' });
      else box.scrollTop = 0;
    }
    for (const w of wrap.querySelectorAll('.t-when[data-at]')) w.textContent = ago(w.dataset.at);
  }

  /** Fetch one conversation whole: ask, then read pages until the host says that is all. */
  async function readWhole(r) {
    const mine = () => ui.reading === r;
    const q = `channel=${encodeURIComponent(r.channel)}&agent=${encodeURIComponent(r.agent)}&session=${encodeURIComponent(r.sessionId)}`;
    try {
      const asked = await fetch('./api/floor/read', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: r.channel, agent: r.agent, session_id: r.sessionId }),
      });
      const said = await asked.json().catch(() => ({}));
      if (!asked.ok) throw new Error(said.error ?? `HTTP ${asked.status}`);
      const started = Date.now();
      while (mine()) {
        const res = await fetch(`./api/floor/read?${q}&from=${r.rows.length}`);
        const got = await res.json().catch(() => ({}));
        if (!mine()) return;
        if (got.request_id === said.request_id) {
          if (got.error) throw new Error(got.error);
          if (got.rows?.length) r.rows = r.rows.concat(got.rows);
          // Done only once every row the board holds has been fetched.
          if (got.done && r.rows.length >= got.total) { r.done = true; renderPanel(); return; }
          if (got.at) r.heard = true;
          renderPanel();
        }
        if (!r.heard && Date.now() - started > 8000) throw new Error('The host did not answer in 8 s.');
        await new Promise((ok) => setTimeout(ok, got.rows?.length ? 0 : 400));
      }
    } catch (e) {
      if (!mine()) return;
      r.error = String(e.message ?? e);
      renderPanel();
    }
  }

  /** Leave the reading view: the live shell is rebuilt and every live turn drawn again. */
  function stopReading() {
    if (!ui.reading) return;
    ui.reading = null;
    ui.panelFor = null;
    ui.renderedTurn = 0;
    const wrap = $('floor-panel');
    wrap.classList.remove('reading');
    delete wrap.dataset.reading;
  }

  /** The panel's meta line: the window, the branch, the model, where it is, how many turns. One line for every shell that shows it. */
  function panelMeta(d) {
    const s = d.session ?? {};
    const h = d.hosted;
    const compacting = compactingLine(s.compacting);
    const presence = h
      ? (h.live ? `on ${h.host}${compacting ? ` · ${compacting}` : h.state === 'working' ? ' · working' : ''}` : `host ${h.host} offline`)
      : d.live ? 'live' : d.reporting ? 'away' : 'not reporting';
    const models = modelLine(s);
    return `${s.window ?? h?.window ?? 'no window seen'}${s.git_branch ? ` · ${s.git_branch}` : ''}${models ? ` · ${models}` : ''}` +
      ` · ${presence} · ${d.turns} turn${d.turns === 1 ? '' : 's'}`;
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
      delete wrap.dataset.reading;
      wrap.classList.remove('reading');
      ui.reading = null;
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
    // A popout that has ended, or whose desk left or went (issue #19), says
    // so where the chat was, under the header it had.
    const ended = ui.popout ? (ui.ended ? 'reattached' : fateShown()) : null;
    if (ended) {
      const last = d ?? ui.lastDesk;
      const forEnd = `${channel}|${agent}|end|${ended}`;
      if (ui.panelFor !== forEnd) {
        endShell(wrap, channel, agent, ended);
        ui.panelFor = forEnd;
      }
      wrap.classList.remove('hidden');
      wrap.querySelector('.p-persona-read').textContent = last?.persona ?? agent;
      wrap.querySelector('.p-meta').textContent = last ? panelMeta(last) : '';
      const who = last?.persona ?? agent;
      wrap.querySelector('.p-out-why').textContent = ended === 'reattached'
        ? `${who}\u2019s chat is back on the floor. This window has nothing more to show.`
        : ended === 'left'
          ? `${who} left this desk: its binding is gone, and its window with it. Nothing more will arrive here.`
          : `${channel}/${agent} is no longer on the board. Nothing more will arrive here.`;
      return;
    }
    if (!d) {
      wrap.classList.add('hidden');
      return;
    }
    // A desk in a meeting room can still be read from History here: reading
    // types into nothing, so it does not need the desk's composer, and the
    // room has no reading view of its own (issue #44).
    const inMeeting = outMeeting(channel, agent);
    if (inMeeting && ui.reading && ui.reading.channel === channel && ui.reading.agent === agent) {
      renderReading(wrap, d);
      return;
    }
    // The desk's chat is in a popout or a meeting room: the header, and the
    // way back. The floor holds no stream for it and draws no composer
    // (issue #19; #44 Decided 3).
    if (isOut(channel, agent)) {
      const forOut = `${channel}|${agent}|out|${inMeeting ? 'meeting' : 'popout'}`;
      if (ui.panelFor !== forOut) {
        stopReading();
        closeStream();
        closePromptMenu();
        outShell(wrap, channel, agent, !!inMeeting);
        ui.panelFor = forOut;
      }
      wrap.classList.remove('hidden');
      wrap.querySelector('.p-persona').textContent = d.persona;
      wrap.querySelector('.p-meta').textContent = panelMeta(d);
      wrap.querySelector('.p-out-why').textContent = inMeeting
        ? `${d.persona} is in a meeting room. Its chat is there, in one transcript with the room\u2019s other desks; the desk on the floor works as it always does.`
        : `${d.persona}\u2019s chat is in a window of its own. Everything in the chat works there; the desk on the floor works as it always does.`;
      return;
    }
    // Back from a popout or a meeting room with this desk open: started the
    // way any desk is opened, its turns read and its stream asked for.
    if (ui.panelFor?.startsWith(`${channel}|${agent}|out|`)) {
      ui.panelFor = null;
      openDesk(channel, agent);
      return;
    }
    // A past conversation is open to read on this desk: its own shell, and
    // none of what follows — no composer to gate, no alert, no live turns.
    if (ui.reading && ui.reading.channel === channel && ui.reading.agent === agent) {
      if (!ui.stream) ui.delivery = d.delivery ?? null;
      renderReading(wrap, d);
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

    if (ui.popout) drawPopDesk(wrap, d, channel);
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
    wrap.querySelector('.p-persona').textContent = d.persona;
    wrap.querySelector('.p-meta').textContent = panelMeta(d);
    // The model and effort controls: the window's confirmed value selected,
    // what was asked for beside it until the picker confirms. Both change
    // this session only (costmo, #10 Decided 4) — the host drives the
    // window's own picker and presses `s`, never the command that saves a
    // machine-wide default.
    const modelSel = wrap.querySelector('[data-act="set-model"]');
    const effortSel = wrap.querySelector('[data-act="set-effort"]');
    if (modelSel && effortSel) {
      const fam = modelFamily(s.model);
      const known = MODEL_CHOICES.some((m) => m.value === fam);
      modelSel.innerHTML = [
        ...(s.model && !known ? [`<option value="${esc(fam)}">${esc(s.model)}</option>`] : []),
        ...(!s.model ? ['<option value="">model…</option>'] : []),
        ...MODEL_CHOICES.map((m) => `<option value="${m.value}">${m.label}</option>`),
      ].join('');
      // While a change is asked for, the select shows it rather than snapping
      // back to the old value until the window confirms; the asked-for note
      // beside it says which it is.
      modelSel.value = modelSelectValue(s);
      modelSel.disabled = !canChat;
      effortSel.innerHTML = [
        ...(!s.effort ? ['<option value="">effort…</option>'] : []),
        ...EFFORT_LEVELS.map((l) => `<option value="${l}">${l}</option>`),
      ].join('');
      effortSel.value = effortSelectValue(s);
      effortSel.disabled = !canChat;
      const asked = wrap.querySelector('.p-asked');
      const askedText = [
        s.model_requested && modelFamily(s.model_requested) !== fam ? `${s.model_requested} asked` : '',
        s.effort_requested && s.effort_requested !== s.effort ? `${s.effort_requested} effort asked` : '',
      ].filter(Boolean).join(' · ');
      asked.textContent = askedText;
      asked.classList.toggle('hidden', !askedText);
    }

    drawAlert(wrap.querySelector('.p-alert-slot'), d, channel, agent, canChat);

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
    const toLeave = wrap.querySelector('[data-act="leave-desk"]');
    if (toLeave) {
      const cannotLeave = !h ? 'No host on this board is running that repo, so there is no binding here to remove.'
        : !h.live ? `The host for this desk (${h.host}) is offline.`
        : null;
      toLeave.disabled = !!cannotLeave;
      toLeave.title = cannotLeave ?? 'Remove this desk\'s binding and close its window';
    }
    const toSessions = wrap.querySelector('[data-act="sessions"]');
    // A reopen in flight is settled like a move, against the payload: the POST
    // is answered when the work is queued, and the conversation changes when
    // the host has closed one window and the next has registered. The desk's
    // `session_id` becoming the chosen id is that fact; for a new conversation
    // it is any real id that is not the one it left. Failing that, the
    // deadline — and what is said is what was seen, not why.
    let reopenFailed = null;
    const rp = ui.reopening && ui.reopening.channel === channel && ui.reopening.agent === agent ? ui.reopening : null;
    if (rp) {
      const sid = h?.session_id ?? null;
      const real = !!sid && !String(sid).startsWith('host:');
      const landed = rp.sessionId ? sid === rp.sessionId : (real && sid !== rp.from);
      if (landed) ui.reopening = null;
      else if (Date.now() - rp.since > MOVE_MS) {
        reopenFailed = rp.sessionId ? `not on that conversation after ${MOVE_MS / 1000}s` : `no new conversation after ${MOVE_MS / 1000}s`;
        ui.reopening = null;
      }
    }
    const reopening = ui.reopening === rp ? rp : null;
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
    // The picker wants a live host — the list and the reopen are its work —
    // and nothing else: an editor holding the conversation is a fact the
    // dialog shows on the rows, not a reason to hide the door. Held flat
    // while a move or another reopen is on its way.
    toSessions.classList.toggle('hidden', !h?.live || !!move);
    toSessions.disabled = !!reopening;
    setLinkBusy(toVsc, move?.act === 'handback');
    setLinkBusy(toFloor, move?.act === 'openhere');
    setLinkBusy(toTmux, !!attaching && attachAct === 'attach');
    setLinkBusy(toClaude, !!attaching && attachAct === 'claude');
    setLinkBusy(toSessions, !!reopening);
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
    if (reopenFailed) flash(toSessions, reopenFailed);
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
      // A nudge sent in bulk waits on the line in front of it before its
      // clock may run, and says what it is waiting on (bulkWait).
      const wait = !queued && p.bulk ? bulkWaitFor(ui.open.channel, ui.open.agent) : null;
      const held = wait?.hold ? { state: 'line', note: wait.note } : null;
      const stale = !queued && !held && Date.now() - Math.max(p.at ?? 0, wait?.since ?? 0) > SENDING_GRACE_MS;
      box.insertBefore(pendingNode(p.text, queued ?? held, stale), partialNode);
    }
    // A queued message this browser did not send — the bell struck with the
    // panel shut, the board's Nudge button, another tab, a reload — is still
    // the operator's, and the desk has said it holds it. Nothing in
    // `ui.sending` stands for it, so it is drawn from the server's note
    // instead: the same bubble, already queued, and gone the moment the note
    // is — a turn retires it there, exactly as a turn retires the others here.
    // Not for a command that is done: its bubble would read as a message
    // still waiting to go, with the receipt as its caption and "you" over it
    // (costmo, 2026-11-03: "an artifact outlined in white saying /model
    // opus"). What was typed and what happened are one line labeled `host`
    // in the conversation already; the bubble has nothing left to say.
    if (ui.delivery && ui.delivery.state !== 'done' && !ui.sending.some((p) => deliveredNow(p.text))) {
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
    // The box last: its room depends on the alert slot drawn above, and a
    // session that changed under an open desk is noticed here (issue #13).
    fitBox();
    if (ui.stick) box.scrollTop = box.scrollHeight;
  }

  /**
   * A desk's prompt box: what the window is asking, and the buttons that
   * answer it — a question form (#7), a permission menu, a startup question,
   * the two ways of saying the board could not read it, and the spinner while
   * answers are on their way. Drawn into `alertSlot` for the desk named, so
   * the floor's panel, a popout and a meeting room (issue #44, one box per
   * participant) all draw it with this one function, and every button in it
   * is answered by the one click handler, which reads the desk off the box
   * (targetOf). Rebuilt only when what it says changes.
   */
  function drawAlert(alertSlot, d, channel, agent, canChat) {
    const s = d.session ?? {};
    // The alert is rebuilt only when what it says changes; its age ticks in
    // place. On a hosted desk a permission prompt carries its answer buttons:
    // this is the human-in-the-middle, the same decision the window would have
    // asked for, answered from here.
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
    // no. Past it the box used to fall through to Approve / Deny / Cancel —
    // "at least something to press" — and only a question is ever `reading`,
    // so that was a question drawn as a menu. Now it says the question could
    // not be read and offers the window and Cancel: see promptOffer.
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
    // Which of the box's bodies is drawn — a form, the reading spinner, a
    // startup question's rows, the menu, or one of the two ways of saying the
    // board could not read what the window is asking. Decided in one place:
    // see promptOffer, and why a question is never the menu.
    const offer = promptOffer(req, reading);
    const unreadable = offer === 'unreadable';
    const kindKey = /^permission_(request|prompt)$/.test(s.awaiting_kind ?? '') ? 'permission' : s.awaiting_kind;
    const alertSig = sendingAnswers
      ? `sending|${answering.request_id}`
      : !s.awaiting_kind
      ? ''
      : req?.questions?.length
        ? `form|${req.request_id}|${req.questions.map((q) => `${q.kind}:${(q.options ?? []).length}`).join(';')}`
        : `${kindKey}|${s.awaiting_message ?? ''}|${req?.request_id ?? ''}` +
          `|${(req?.options ?? []).map((o) => o.n).join(',')}|${req?.options_error ?? ''}|${reading ? 'reading' : ''}|${offer}|${req?.form_unread ?? ''}|${req?.startup ? `startup:${req.request_id}` : ''}`;
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
             ${offer === 'question-unread' ? `<div class="p-unknown p-question-unread">
               <div class="p-unknown-why">This is a question, and the board could not read its choices
                 \u2014 ${esc(req.form_unread ?? 'the host has not sent back what the window is showing')}.
                 Nothing here would be an answer to it: open the window to answer it there, or cancel the question.</div>
               <div class="p-decide">
                 <button class="btn primary" data-act="ask-open" title="A terminal on this desk\u2019s own window, where the question is">Open the window</button>
                 <button class="btn" data-act="decide" data-choice="cancel" data-request="${esc(req.request_id)}" title="The same as pressing Escape in the window">Cancel the question</button>
               </div>
             </div>` : ''}
             ${req?.startup ? `<div class="p-startup">
               <div class="p-unknown-why">Nothing here is answered for you. Pick a row and that row is chosen in the window, the same as pressing it there.</div>
               <div class="p-more">${req.options.map((o) =>
                 `<button class="btn p-choice" data-act="decide" data-choice="${esc(String(o.n))}" data-request="${esc(req.request_id)}" title="${esc(o.text)}"><span>${esc(o.text)}</span></button>`).join('')}</div>
             </div>` : ''}
             ${offer === 'menu' ? `<div class="p-decide">
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
  }

  async function loadTurns(reset) {
    if (!ui.open || isOut(ui.open.channel, ui.open.agent)) return;
    if (reset) {
      ui.turns = [];
    ui.sending = [];
      ui.sinceTurn = 0;
    }
    // Not before the page has read /api/floor once: until then there is no
    // desk to scope to, and an unscoped fetch is the desk's whole tail. A
    // popout opens its desk before its first poll, and on a desk whose new
    // session has no turns yet that tail is entirely the session before it
    // (issue #46). The first poll loads the panel, scoped (tick).
    if (!floorRead) return;
    const { channel, agent } = ui.open;
    // A hosted desk shows the hosted session — the one you can talk to — even
    // if a window in the same repo is reporting turns of its own to this desk.
    const sess = sessionFilter();
    const url = `./api/floor/turns?channel=${encodeURIComponent(channel)}&agent=${encodeURIComponent(agent)}&since=${ui.sinceTurn}` +
      (sess ? `&session=${encodeURIComponent(sess)}` : '');
    const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
    if (!r.ok) return;
    const d = await r.json();
    if (!ui.open || ui.open.channel !== channel || ui.open.agent !== agent) return;
    // Asked for another session than the panel's now: tick has started the
    // panel over since, and these rows would be appended to the new one's
    // list for good, because nothing clears a list whose filter has not
    // changed again (#46: an answer landing after that reset).
    if (sessionFilter() !== sess) return;
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

  /* ---------- chat controls: what the page decides ---------- */
  // Pure, and lifted into test/floor.mjs by the two markers around this
  // section — see CLAUDE.md on page logic. Issues #9, #10 and #15 (0.10.9).

  /** The commands the composer offers. The same list as the server's
   *  FLOOR_COMMANDS; a floor list, versioned with the plugin. Anything else
   *  typed after a slash passes through as typed. */
  const FLOOR_COMMANDS = [
    { name: 'clear', args: '', hint: 'start a new conversation on this desk' },
    { name: 'compact', args: '', hint: 'summarise the conversation to free context' },
    { name: 'model', args: 'name', hint: 'change the model — this session only' },
    { name: 'effort', args: 'level', hint: 'change the effort level — this session only' },
    { name: 'btw', args: 'question', hint: 'a side question, answered in the window without tools' },
  ];
  const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
  /** The picker's rows the floor offers by name; the host matches the name
   *  against the window's own picker, so a model not here still works typed. */
  const MODEL_CHOICES = [
    { value: 'fable', label: 'Fable 5.1' },
    { value: 'opus', label: 'Opus 5.5' },
    { value: 'sonnet', label: 'Sonnet 5.5' },
    { value: 'haiku', label: 'Haiku 5.5' },
  ];

  /**
   * Which commands the composer's text is the start of: a single line, a
   * slash, and no space yet — once a space is typed the command is chosen
   * and the rest is its argument. Empty for anything else, including a
   * message that merely starts with "/" on its second line.
   */
  function slashMatches(text) {
    const t = String(text ?? '');
    if (!t.startsWith('/') || t.includes('\n') || /\s/.test(t)) return [];
    const prefix = t.slice(1).toLowerCase();
    return FLOOR_COMMANDS.filter((c) => c.name.startsWith(prefix));
  }

  /** A model id as the control names it: "claude-haiku-5-5" is "haiku". */
  function modelFamily(model) {
    const m = /^claude-([a-z]+)/i.exec(String(model ?? ''));
    return m ? m[1].toLowerCase() : String(model ?? '').toLowerCase().split(/[\s-]+/)[0];
  }

  /**
   * The header's model line: what the window confirmed, then what the floor
   * asked for and the window has not confirmed yet. Asked-for and confirmed
   * are shown apart on purpose — a /model typed into the window never
   * reached the header before (issue #10), and a change asked from here is
   * not a change until the picker says so.
   */
  function modelLine(s) {
    if (!s) return '';
    const parts = [];
    if (s.model) parts.push(s.model);
    if (s.effort) parts.push(`${s.effort} effort`);
    const asked = [];
    if (s.model_requested && modelFamily(s.model_requested) !== modelFamily(s.model)) asked.push(s.model_requested);
    if (s.effort_requested && s.effort_requested !== s.effort) asked.push(`${s.effort_requested} effort`);
    let line = parts.join(' · ');
    if (asked.length) line += `${line ? ' ' : ''}→ ${asked.join(', ')} asked`;
    return line;
  }

  /**
   * What the model select shows: the asked-for family while a change is
   * pending and the control has a row for it, else the confirmed model's
   * family, else nothing. Pure, so the rule is tested (QA, PR #32 info 4).
   */
  function modelSelectValue(s, choices = MODEL_CHOICES) {
    const fam = modelFamily(s?.model);
    const askedFam = s?.model_requested ? modelFamily(s.model_requested) : null;
    if (askedFam && choices.some((m) => m.value === askedFam)) return askedFam;
    return s?.model ? fam : '';
  }
  /** The effort select: the asked-for level while pending, else the confirmed one. */
  function effortSelectValue(s) {
    return s?.effort_requested ?? s?.effort ?? '';
  }

  /** The compacting line: which kind, and for how long. */
  function compactingLine(c, nowMs = Date.now()) {
    if (!c?.since) return '';
    const secs = Math.max(0, Math.round((nowMs - Date.parse(c.since)) / 1000));
    return `compacting${c.trigger ? ` (${c.trigger})` : ''} · ${secs}s`;
  }

  /**
   * What a pending bubble says. Three things the window can have said about
   * a message, and the difference between them is who has it: `queued` is the
   * window's own word (it took the message while working and reads it at its
   * next step — never stale, the desk said so); `held` is queued after a wait
   * for the window, or 'compacting' when it took the message and went off to
   * compact under it; `done` is a command's own receipt, in its own terms.
   */
  function deliveryNote(d, stale = false) {
    if (d?.state === 'done') return d.said || 'done';
    // A nudge from a selecting room, waiting on its host's line: the page's
    // own reading of facts it has (bulkWait), never stale while it holds.
    if (d?.state === 'line') return d.note || 'in line';
    if (d) {
      if (d.held === 'compacting') return 'held — the desk is compacting; it reads this when that ends';
      if (d.held) return 'queued — the window took it once it was free';
      return 'queued — the desk is working';
    }
    return stale ? 'not recorded — send again' : 'sending…';
  }
  /* ---------- chat controls: the drawing ---------- */

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
    const said = deliveryNote(queued, stale);
    node.classList.toggle('done', queued?.state === 'done');
    node.innerHTML = `<div class="t-who">you<span class="t-when mono">${esc(said)}</span></div>` +
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

  /* ---------- popouts: what the page decides ---------- */
  // Issue #19. Pure, and lifted into test/floor.mjs by the two markers around
  // this section — see CLAUDE.md on page logic.

  /* A popout's width: the floor panel's own widest (`.deskpanel` clamps it to
     460px), less the window's frame, so the chat reads at the size it has on
     the floor. As tall as the screen allows. */
  const POP_W = 440;
  /* Where the browser gives the page no Web Locks, a popout says it is out
     every POP_BEAT_MS and the floor counts it back in after POP_TTL_MS of
     silence, so a window that closed without its last word is not out for
     ever. With locks, the lock says it and these time only a window not yet
     heard from (see "Presence that no timer keeps"). */
  const POP_BEAT_MS = 2000;
  const POP_TTL_MS = 7000;
  /* How long a desk has to read as left or gone before its popout says so. A
     move reads as "left" for a moment on the way — the host re-registers
     without the old binding just before it reports the new one — and a
     popout that announced a leave the operator never asked for, then
     followed the desk a second later, would be saying something false. */
  const FATE_GRACE_MS = 4000;

  /** The window name a desk's popout is opened under: one per desk, so a second detach can never open a second window. */
  const popoutName = (channel, agent) => `orch-desk:${channel}|${agent}`;

  /** The page's own query string for a desk's popout. */
  const popoutQuery = (channel, agent) =>
    `?popout=1&channel=${encodeURIComponent(channel)}&agent=${encodeURIComponent(agent)}`;

  /** The desk a page is the popout of, from its query string, or null for the floor. */
  function popoutOf(search) {
    const q = new URLSearchParams(search ?? '');
    const channel = q.get('channel');
    const agent = q.get('agent');
    return q.get('popout') === '1' && channel && agent ? { channel, agent } : null;
  }

  /**
   * Where the nth popout opens: full height, against the right edge of the
   * screen, each further one to the left of the last, wrapping when the
   * screen is full. The browser keeps a popup on the screen whatever is
   * asked; this only keeps a fresh one from landing on top of the last.
   */
  function popoutPlace(scr, n = 0) {
    const availW = scr?.availWidth ?? scr?.width ?? 1280;
    const availH = scr?.availHeight ?? scr?.height ?? 800;
    const left0 = scr?.availLeft ?? 0;
    const top0 = scr?.availTop ?? 0;
    const fit = Math.max(1, Math.floor(availW / POP_W));
    const k = Math.max(0, n) % fit;
    return { width: POP_W, height: availH, left: Math.max(left0, left0 + availW - POP_W * (k + 1)), top: top0 };
  }

  /* How large the floor draws a desk, in pixels per drawing unit: a room is
     ROOM_W units wide, drawn at its container's width up to ROOM_MAX_W px.
     The floor tab records what it is drawing (deskScale in localStorage) and
     a popout draws its desk at that, so the person looks the same size in
     both. With nothing stored, or nonsense, `fallback`: the floor's widest. */
  function deskScaleOf(stored, fallback) {
    const n = Number(stored);
    return stored != null && stored !== '' && Number.isFinite(n) && n > 0.3 && n < 4 ? n : fallback;
  }
  /* The chat's narrowest, beside a desk column. Below it the desk goes back
     over the chat: a transcript of 300px or so is a column of single words. */
  const POP_CHAT_MIN = 420;
  /** Whether a popout this wide puts its desk in a column of its own, given the desk column's width in px. */
  const popWide = (windowW, deskColW) => windowW >= deskColW + POP_CHAT_MIN;

  /* The smallest a popout draws its desk, as a share of the floor's size. */
  const POP_DESK_MIN = 0.5;
  /**
   * The scale a popout draws its desk at: the floor's, unless the window is
   * too short for it, when the desk gives way, down to POP_DESK_MIN of the
   * floor's. `avail` is the height left for the drawing once the header, the
   * transcript's least and the composer at its smallest are on the panel; a
   * desk drawn taller pushed the send row out of a 700px window.
   */
  function popDeskScale(scale, drawH, avail) {
    if (!(drawH > 0) || !(avail >= 0)) return scale;
    return Math.min(scale, Math.max(scale * POP_DESK_MIN, avail / drawH));
  }

  /** A popup, not a tab: no tab strip, toolbar or navigation (Decided). */
  const popoutFeatures = (p) => `popup=yes,width=${p.width},height=${p.height},left=${p.left},top=${p.top}`;

  /**
   * The desks out now. A popout that holds its lock (`held`) is out until
   * the lock is released, however long it is quiet: its timers are the
   * browser's to throttle, and a minimized popout's were, to one wake-up a
   * minute (QA, PR #41 finding 1). Without a lock (a page the browser
   * gives no Web Locks, or a window not yet heard from), out means heard
   * within POP_TTL_MS.
   */
  function outsNow(outs, now) {
    return new Set([...outs].filter(([, o]) => o.held || now - o.at < POP_TTL_MS).map(([k]) => k));
  }

  /** The Web Lock a desk's popout holds for as long as it is open. */
  const popLockName = (channel, agent) => `orch.popout:${channel}|${agent}`;

  /** The folder and host a desk is bound to, which is what a move keeps, or null when nothing binds it. */
  function boundTo(d) {
    const h = d?.hosted;
    return h && h.state !== 'offline' && h.host && h.window ? { host: h.host, window: h.window } : null;
  }

  /**
   * What became of a popout's desk, read off one /api/floor payload.
   *
   *   here   — on its floor, as it was
   *   moved  — its folder is bound on another floor now, under the same
   *            agent (#18); the popout follows it there
   *   left   — still a seat on its floor, but the binding it had is gone
   *            (Leave desk); the popout says so and offers to close
   *   gone   — not on the board at all any more
   *
   * `mem` is the binding the popout last saw (`boundTo`), or null if it
   * never saw one — a desk that is live by its hooks alone has no binding to
   * lose, so it is never "left", and a move is only recognised by the
   * folder and host it was bound to.
   */
  function deskFate(channels, here, mem) {
    const all = channels ?? [];
    const d = all.find((c) => c.channel === here.channel)?.desks?.find((x) => x.agent === here.agent) ?? null;
    if (d && (boundTo(d) || !mem)) return { state: 'here', desk: d };
    if (mem) {
      for (const c of all) {
        if (c.channel === here.channel) continue;
        const t = c.desks?.find((x) => x.agent === here.agent && boundTo(x)?.host === mem.host && boundTo(x)?.window === mem.window);
        if (t) return { state: 'moved', channel: c.channel, desk: t };
      }
    }
    return d ? { state: 'left', desk: d } : { state: 'gone', desk: null };
  }

  /* ---------- meeting rooms: what the page decides ---------- */
  // Issue #44. Pure, and lifted into test/floor.mjs by the two markers around
  // this section (with the popouts section above, whose deskFate and
  // boundTo it reads, and the bulk-selection and chat-control sections,
  // whose nudgePlan, bulkWait and deliveryNote it reuses) — see CLAUDE.md on
  // page logic.
  //
  // A meeting room is several desks of one floor in one window. Its code
  // names are `meeting…`, never `room…`: in this file a room is a channel's
  // drawing (`room(c)`), and the issue's Decided 1 keeps the two apart.

  /* A meeting room's window: wider than a popout, because its transcript is
     several desks' and its participants stand in a row over it. */
  const MEET_W = 760;
  /* Two desks recording the same words within this long are one message the
     operator sent both — the fold for a user turn this window did not send
     (a reload lost its record; it was typed into the windows). */
  const MEET_GROUP_MS = 120_000;

  /** The window name a meeting room is opened under: one per room. */
  const meetingName = (key) => `orch-meeting:${key}`;

  /**
   * The page's own query string for a meeting room's window: a room the
   * board has (`id`), or a new one (`channel` and `agents`) that the window
   * creates as it opens. `resume` asks the window to reopen each desk on the
   * conversation it had — Resume, and nothing else, sets it.
   */
  function meetingQuery({ id = null, channel = null, agents = [], resume = false } = {}) {
    const q = new URLSearchParams();
    if (id) q.set('meeting', String(id));
    else {
      q.set('meeting', 'new');
      q.set('channel', channel ?? '');
      q.set('agents', agents.join(','));
    }
    if (resume) q.set('resume', '1');
    return `?${q}`;
  }

  /** The meeting room a page is the window of, from its query string, or null. */
  function meetingOf(search) {
    const q = new URLSearchParams(search ?? '');
    const m = q.get('meeting');
    if (!m) return null;
    if (m === 'new') {
      const channel = q.get('channel');
      const agents = [...new Set((q.get('agents') ?? '').split(',').map((a) => a.trim()).filter(Boolean))];
      return channel && agents.length ? { id: null, channel, agents, resume: false } : null;
    }
    const id = Number(m);
    return Number.isInteger(id) && id > 0 ? { id, channel: null, agents: [], resume: q.get('resume') === '1' } : null;
  }

  /** Where a meeting room's window opens: full height, against the right edge, as wide as MEET_W allows. */
  function meetingPlace(scr) {
    const availW = scr?.availWidth ?? scr?.width ?? 1280;
    const availH = scr?.availHeight ?? scr?.height ?? 800;
    const left0 = scr?.availLeft ?? 0;
    const width = Math.min(MEET_W, availW);
    return { width, height: availH, left: left0 + availW - width, top: scr?.availTop ?? 0 };
  }

  /**
   * The selection toolbar's Meeting room control. It takes the checked
   * desks that are on the floor now — not one already in its own popout or
   * in another meeting room (Decided 3: a desk is in one place at a time),
   * and those are named on hover. Two or more: a meeting of one is the
   * desk's own popout, which the panel's detach already opens.
   */
  function meetingChip(desks, outKeys, channel) {
    const free = desks.filter((d) => !outKeys.has(`${channel}|${d.agent}`));
    const out = desks.filter((d) => outKeys.has(`${channel}|${d.agent}`));
    const n = free.length;
    const title = [
      n >= 2
        ? `Opens one window with ${free.map((d) => `${d.persona} (${d.agent})`).join(', ')}: one transcript, one composer, and you choose who hears each message.`
        : 'Check two or more desks to put them in a meeting room.',
      ...out.map((d) => `${d.persona} (${d.agent}) is in a window already — its own, or another meeting room.`),
    ].join('\n');
    return { text: `Meeting room${n ? ` · ${n}` : ''}`, title, disabled: n < 2, agents: free.map((d) => d.agent) };
  }

  /**
   * What Add offers in a meeting room's window: the desks drawn on its floor
   * (`drawn`, deskRows' list) that are not in this room and not out in any
   * window (Decided 3), in drawn order.
   */
  function meetingAddable(drawn, inRoom, outKeys, channel) {
    return (drawn ?? []).filter((d) => !inRoom.has(d.agent) && !outKeys.has(`${channel}|${d.agent}`));
  }

  /** A participant's state at a glance — the desk's one-word state (deskState), in the room's words. */
  const MEET_STATE_WORD = { 'needs-you': 'needs you', working: 'working', here: 'idle', away: 'away' };

  const meetSquash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

  /**
   * Where a message from the room stands on one desk, read off what that
   * desk wrote — never off the room's own send (CLAUDE.md: a delivery is what
   * the window recorded). `e` is the desk's entry, the shape nudgePlan makes
   * (its `base` is the desk's newest turn when it was sent); `turns` the
   * desk's turns as the room holds them; `delivery` the desk's note.
   *
   *   line     — the board took it; the host has not typed it yet
   *   queued   — the window has it and reads it at its next step (sticky
   *              until the turn arrives: the note goes before the turn does)
   *   recorded — the desk's own user turn for it (`turn`)
   *   done     — a command's receipt, in the window's words
   *   refused  — the board would not take it, in the board's words
   *   failed   — an error turn came first (the panel's settle() rule, with
   *              its known limit: an error turn names no message)
   */
  function meetingEntry(e, text, turns, delivery) {
    if (!['line', 'queued'].includes(e.state)) return e;
    const words = meetSquash(text);
    for (const t of [...(turns ?? [])].sort((a, b) => a.id - b.id)) {
      if (t.id <= (e.base ?? 0)) continue;
      if (t.role === 'user' && meetSquash(t.text).includes(words)) return { ...e, state: 'recorded', turn: t.id };
      if (t.role === 'error') return { ...e, state: 'failed', words: t.text || 'the host could not deliver it' };
    }
    if (delivery && meetSquash(delivery.text).includes(words)) {
      if (delivery.state === 'done') return { ...e, state: 'done', words: delivery.said || 'done' };
      return { ...e, state: 'queued', note: delivery };
    }
    return e;
  }

  /**
   * One desk's word under a room message. While it is in its host's line it
   * waits on facts (bulkWait, the bulk nudge's rule: a desk behind others
   * can wait well past 30 s with nothing wrong), and only once nothing holds
   * it does the silence clock run.
   */
  function meetingEntryWord(e, entries, opening, sentAt, now, grace) {
    if (e.state === 'refused') return { text: `not sent — ${e.words}`, kind: 'bad' };
    if (e.state === 'failed') return { text: `not delivered — ${e.words}`, kind: 'bad' };
    if (e.state === 'recorded') return { text: 'delivered', kind: 'ok' };
    if (e.state === 'done') return { text: e.words || 'done', kind: 'ok' };
    if (e.state === 'queued') return { text: deliveryNote(e.note), kind: 'wait' };
    const wait = bulkWait(entries, e.agent, opening);
    if (wait?.hold) return { text: wait.note, kind: 'wait' };
    const since = Math.max(sentAt ?? 0, wait?.since ?? 0);
    return now - since > grace ? { text: 'not recorded — send again', kind: 'bad' } : { text: 'sending…', kind: 'wait' };
  }

  /**
   * The room's transcript, in order: every participant's turns from when it
   * joined, the room's own messages, and its notes (who joined, who left,
   * who could not be reopened, and why).
   *
   * A message the room sent is one item, however many desks recorded it:
   * each recipient's user turn for it is folded into it (an entry's `turn`)
   * and never drawn again, so three desks do not show the operator's words
   * three times. Its place is its first recorded turn; until one is
   * recorded it stands at the end, the way the panel's pending bubbles do.
   * A user turn the room did not send — typed into a window, a nudge struck
   * on the floor, a send whose record a reload lost — is folded with the
   * same words on other desks within `groupMs`, and drawn once.
   *
   * `parts` are { agent, turns } for everyone who has been in the room,
   * removed participants included: what they said while here stays.
   */
  function meetingItems(parts, sends, notes, groupMs = MEET_GROUP_MS) {
    const items = [];
    const used = new Set();
    for (const s of sends ?? []) {
      const hits = s.entries.filter((e) => e.turn).map((e) => e.turn);
      for (const e of s.entries) if (e.turn) used.add(`${e.agent}|${e.turn}`);
      items.push({ key: `send:${s.seq}`, kind: 'send', send: s, order: hits.length ? Math.min(...hits) : Infinity, tie: s.seq });
    }
    const loose = [];
    for (const p of parts ?? []) {
      for (const t of p.turns ?? []) {
        if (used.has(`${p.agent}|${t.id}`)) continue;
        if (t.role === 'user') loose.push({ agent: p.agent, t });
        else items.push({ key: `t:${t.id}`, kind: 'turn', agent: p.agent, turn: t, order: t.id, tie: 0 });
      }
    }
    const groups = [];
    for (const u of loose.sort((a, b) => a.t.id - b.t.id)) {
      const words = meetSquash(u.t.text);
      const at = Date.parse(u.t.created_at ?? '') || 0;
      const g = groups.find((x) => x.words === words && !x.agents.includes(u.agent) && Math.abs(at - x.at) <= groupMs);
      if (g) { g.agents.push(u.agent); g.turns.push(u.t); } else groups.push({ words, at, agents: [u.agent], turns: [u.t] });
    }
    for (const g of groups) {
      items.push({ key: `u:${g.turns[0].id}`, kind: 'user', agents: g.agents, turn: g.turns[0], order: g.turns[0].id, tie: 0 });
    }
    for (const n of notes ?? []) items.push({ key: `n:${n.seq}`, kind: 'note', note: n, order: n.after + 0.5, tie: n.seq });
    return items.sort((a, b) => a.order - b.order || a.tie - b.tie);
  }

  /**
   * What Resume does with each participant of a room as it ended
   * (`room.participants`, as the board recorded them), against the floor
   * now. `act`:
   *
   *   join   — on that conversation already, or none was recorded for it
   *   reopen — reopened on `session_id`, the way the Sessions picker does it
   *   skip   — not opened, and `why` says so; the rest open anyway
   *
   * The issue's four cases are here: a desk that has left (its binding
   * gone), that has moved floors (its folder on its host, bound under the
   * same agent on another floor — deskFate's test), whose window is busy
   * (refused by the reopen route itself, in its words: see reopenPart),
   * and whose conversation is gone (the host's list of them, asked first).
   * Two more fall out of the floor as it is: a desk out in another window,
   * and a desk nothing can reach — no host, a host offline, an editor
   * holding it.
   */
  function meetingResumePlan(room, channels, outKeys) {
    const all = channels ?? [];
    return (room?.participants ?? []).map((p) => {
      const c = all.find((x) => x.channel === room.channel);
      const d = c?.desks?.find((x) => x.agent === p.agent) ?? null;
      const who = d?.persona ?? p.persona ?? p.agent;
      const skip = (why) => ({ agent: p.agent, persona: who, act: 'skip', why });
      if (!d || !d.hosted) {
        const mem = p.host && p.window ? p : null;
        for (const o of mem ? all : []) {
          if (o.channel === room.channel) continue;
          const t = o.desks?.find((x) => x.agent === p.agent && x.hosted?.host === mem.host && x.hosted?.window === mem.window);
          if (t) return { ...skip(`${t.persona ?? who} has moved to ${o.channel}. A meeting room is one floor's desks.`), persona: t.persona ?? who };
        }
        if (!d) return skip(`${who} is no longer on ${room.channel}.`);
        return skip(mem ? `${who} has left its desk: nothing binds it to a folder now.` : `No host on this board runs ${who}'s folder, so its conversation cannot be reopened.`);
      }
      if (outKeys?.has(`${room.channel}|${p.agent}`)) return skip(`${who} is in a window already — its own, or another meeting room.`);
      if (!d.hosted.live) return skip(`${who}'s host (${d.hosted.host}) is offline.`);
      if (d.hosted.held === 'editor') return skip(`${who}'s conversation is open in your editor. One app holds a conversation at a time.`);
      const now = d.hosted.session_id ?? null;
      if (!p.session_id || now === p.session_id) return { agent: p.agent, persona: who, act: 'join', session_id: now };
      return { agent: p.agent, persona: who, act: 'reopen', session_id: p.session_id, from: now };
    });
  }

  /**
   * The room's Nudge button: the word typed into whoever the To chips
   * choose, in nudgePlan's order, the way a selecting room's Nudge does it.
   * Its label carries the unread count, which is the whole of "a nudge is
   * needed": messages waiting on the board for a desk that has not read
   * them (`board.unread`, the number the floor's ✉ pill shows). Desks that
   * cannot be nudged are named on hover with the board's reason.
   */
  function meetingNudgeChip(desks, everyone) {
    const plan = nudgePlan(desks);
    const waiting = desks.filter((d) => (d.board?.unread ?? 0) > 0);
    const n = waiting.reduce((sum, d) => sum + d.board.unread, 0);
    const who = everyone && desks.length > 1 ? 'everyone' : desks.map((d) => d.persona).join(', ');
    return {
      text: `Nudge ${who || 'nobody'}${n ? ` · ${n} unread` : ''}`,
      title: [
        plan.send.length
          ? `Types “nudge” into ${plural(plan.send.length, 'desk')}: each goes and reads what is waiting for it on the board.`
          : 'Nobody chosen can be nudged.',
        ...waiting.map((d) => `${d.persona}: ${plural(d.board.unread, 'unread message')}`),
        ...plan.blocked.map((b) => `Can't nudge ${b.persona}: ${b.reason}`),
      ].join('\n'),
      disabled: !plan.send.length,
      waiting: n > 0,
    };
  }

  /** Who a room message goes to: everyone in the room, or the ones chosen for this one message (Decided 2). */
  const meetingTo = (inRoom, chosen) => (chosen ? inRoom.filter((a) => chosen.has(a)) : [...inRoom]);

  /** The line over a room message: who it went to, by name. Everyone, while it was everyone in the room. */
  function meetingToLine(to, everyone, nameOf) {
    if (!to.length) return 'nobody';
    if (everyone && to.length > 1) return `everyone (${to.map(nameOf).join(', ')})`;
    return to.map(nameOf).join(', ');
  }

  /* ---------- meeting rooms: the decisions end ---------- */

  /* ---------- popouts: the windows ---------- */

  /*
   * How the windows agree on which desks are out (issue #19). A popout says
   * so on a BroadcastChannel — once it holds its lock, and when a
   * floor asks — and says when it goes. A floor keeps what it hears in
   * `ui.outs` and nowhere else, so nothing holds a list that can go stale
   * against the windows themselves, and a reloaded floor asks once and is
   * answered within milliseconds. Same origin only, which is the board.
   *
   *   popout → all : here   { channel, agent, id }       it is out
   *                  gone   { channel, agent, id, open }  it is going; `open`
   *                         when the chat should come back to the floor
   *                  rang   { channel, agent }            its bell rang
   *   floor → all  : who                                  say if you are out
   *                  back   { channel, agent }            close; the floor has it
   *                  read   { channel, agent, sessionId, title, find }  History
   *                  nudged { channel, agent, text, bulk, rec }  a nudge sent here
   *                  focus  { channel, agent }            come to the front
   */
  const POP_ID = Math.random().toString(36).slice(2);
  const outKey = (channel, agent) => `${channel}|${agent}`;
  const bc = (() => { try { return new BroadcastChannel('orch.popouts'); } catch { return null; } })();
  const say = (msg) => { try { bc?.postMessage(msg); } catch { /* the channel is gone with the page */ } };
  /** Is this desk's chat in a popout? Only ever asked on the floor: a popout is never "out" to itself. */
  const isOut = (channel, agent) => !ui.popout && !ui.meeting && outsNow(ui.outs, Date.now()).has(outKey(channel, agent));
  /** The meeting room a desk is out in, if that is where it is (issue #44). */
  const outMeeting = (channel, agent) => (isOut(channel, agent) ? ui.outs.get(outKey(channel, agent))?.meeting ?? null : null);
  const mine = (msg) => !!ui.popout && msg.channel === ui.popout.channel && msg.agent === ui.popout.agent;

  /* After a popout goes, how long the floor waits before taking the chat
     back: a popout being reloaded says `gone` and then `here` again a moment
     later, and must not bounce the floor's panel in between. */
  const REJOIN_MS = 1500;

  /*
   * Presence that no timer keeps (QA, PR #41 finding 1). A popout holds a
   * Web Lock named for its desk for as long as it is open, and the browser
   * releases it when the window goes: closed, crashed or reloaded. The
   * floor asks for the same lock once it hears the popout holds it, and is
   * granted it exactly when the popout is gone, so "out" never expires on a
   * clock. It used to be a 2 s beat heard within 7 s, and Chrome gives a
   * minimized window one timer wake-up a minute: measured by QA, the floor
   * drew bo's composer beside the popout's in 9 samples of 25. Web Locks
   * need a secure context (localhost is one). Elsewhere it is the beat, as
   * before, with the same throttling.
   */
  const LOCKS = (() => { try { return typeof navigator.locks?.request === 'function'; } catch { return false; } })();
  const watching = new Set();
  function watchOut(channel, agent, id) {
    const k = outKey(channel, agent);
    if (!LOCKS || watching.has(k)) return;
    watching.add(k);
    // Granted when the popout's lock is released, and given straight back.
    navigator.locks.request(popLockName(channel, agent), () => {
      watching.delete(k);
      const o = ui.outs.get(k);
      // A meeting room's window going takes no panel: which of its desks
      // would it be? Each is simply back on the floor.
      if (o?.held && o.id === id) takeGone({ channel, agent, id, open: !o.meeting });
    }).catch(() => watching.delete(k));
  }

  if (bc) bc.onmessage = (m) => {
    const msg = m.data ?? {};
    if (ui.meeting) { meetingHears(msg); return; }
    if (ui.popout) {
      if (ui.ended) return;
      if (msg.t === 'who') announce();
      else if (msg.t === 'back' && mine(msg)) endPopout(false);
      else if (msg.t === 'focus' && mine(msg)) window.focus();
      else if (msg.t === 'read' && mine(msg)) {
        window.floorRead(msg.channel, msg.agent, msg.sessionId, msg.title, { find: msg.find ?? null });
        window.focus();
      } else if (msg.t === 'nudged' && mine(msg)) {
        // A nudge struck on the floor for this desk: its pending bubble is
        // here, where the chat is. A bulk one brings the floor's record of
        // its line with it, which this page then follows the way the floor
        // does (followBulk), so the bubble waits on the same facts.
        if (msg.rec) ui.bulk.set(msg.channel, { ...(ui.bulk.get(msg.channel) ?? {}), nudge: msg.rec });
        nudged(msg.channel, msg.agent, msg.text, !!msg.bulk, false);
      }
      return;
    }
    const k = outKey(msg.channel, msg.agent);
    if (msg.t === 'here') {
      const was = isOut(msg.channel, msg.agent);
      // The same window under a new key is a popout that followed its desk
      // to another floor: the old key is not out any more. Not a meeting
      // room's window, which is out under one key per participant.
      if (!msg.meeting) for (const [ok, o] of ui.outs) if (o.id === msg.id && ok !== k) ui.outs.delete(ok);
      const held = LOCKS && msg.held === true;
      ui.outs.set(k, { at: Date.now(), id: msg.id, held, meeting: msg.meeting ?? null });
      if (held) watchOut(msg.channel, msg.agent, msg.id);
      if (!was && ui.open && outKey(ui.open.channel, ui.open.agent) === k) renderPanel();
    } else if (msg.t === 'gone') {
      takeGone(msg);
    } else if (msg.t === 'rang') {
      ring(msg.channel, msg.agent);
    }
  };

  /* The size a desk is drawn on the floor, shared with the popouts through
     localStorage: the floor writes it when it changes, and a popout reads it
     when it draws and again on the `storage` event, so dragging the floor
     window wider grows the desk in every popout with it. */
  const SCALE_KEY = 'orch.deskScale';
  const DESK_SCALE_DEFAULT = ROOM_MAX_W / ROOM_W;
  function recordDeskScale() {
    const r = document.querySelector('#floor-rooms svg.room');
    const w = r?.getBoundingClientRect().width;
    if (!w) return;
    const s = (w / ROOM_W).toFixed(3);
    try { if (localStorage.getItem(SCALE_KEY) !== s) localStorage.setItem(SCALE_KEY, s); } catch { /* a popout then draws at the default */ }
  }
  function deskScale() {
    let stored = null;
    try { stored = localStorage.getItem(SCALE_KEY); } catch { /* the default */ }
    return deskScaleOf(stored, DESK_SCALE_DEFAULT);
  }
  /**
   * Size a popout's desk to the floor's, and put it beside the chat when the
   * window is wide enough for both. In a window too short for it the desk
   * gives way (popDeskScale), never the send row.
   */
  function popLayout() {
    if (!ui.popout) return;
    const wrap = $('floor-panel');
    const slot = wrap?.querySelector('.p-deskslot');
    const svg = slot?.querySelector('svg.popdesk');
    const scale = deskScale();
    if (svg) {
      const vb = svg.viewBox.baseVal;
      // The column is the desk plus the slot's own padding in its wide form,
      // and the panel shares the window less main's padding.
      wrap.classList.toggle('pop-wide', popWide(window.innerWidth - 24, vb.width * scale + 2 * 18 + 1));
      const wide = wrap.classList.contains('pop-wide');
      const height = (el) => el?.getBoundingClientRect().height ?? 0;
      const ta = $('p-text');
      const compose = wrap.querySelector('.p-compose');
      const turns = $('p-turns');
      // Beside the chat, the desk's controls and the seat links stand under
      // the desk, and the composer is the box and the Send row alone, so the
      // transcript gets the rows they took (costmo, #43). The same element
      // moves, not a copy: every reader finds it through the panel, and the
      // change handlers are the document's. Over the chat it goes back to
      // the composer's foot.
      const foot = wrap.querySelector('.p-foot');
      const home = wide ? slot : compose;
      if (foot && home && foot.parentElement !== home) home.appendChild(foot);
      const slotPad = parseFloat(getComputedStyle(slot).paddingTop) + parseFloat(getComputedStyle(slot).paddingBottom) + 1;
      const head = height(wrap.querySelector('.p-head')) + height(wrap.querySelector('.p-meta')) + 2;
      // Beside the chat the desk has the panel's height under the header,
      // less the foot that now stands under it; over it, what the
      // transcript's least and the composer leave, with the box at the
      // height fitBox last drew it (its starting size before that). So the
      // box grows into the transcript first, down to its least, and then
      // into the desk, down to POP_DESK_MIN.
      const boxH = ta ? Math.max(boxMetrics(ta).base, ui.boxDrawn ?? 0) : 0;
      const avail = wide
        ? height(wrap) - head - slotPad - (foot ? height(foot) + (parseFloat(getComputedStyle(slot).rowGap) || 0) : 0)
        : height(wrap) - head - slotPad - (parseFloat(getComputedStyle(turns ?? wrap).minHeight) || 0)
          - (height(compose) - (ta?.offsetHeight ?? 0) + boxH);
      svg.style.width = `${Math.round(vb.width * popDeskScale(scale, vb.height, avail))}px`;
      // How much shorter the desk can still be drawn: fitBox's room for the
      // box over the chat. Beside it the desk is in a column of its own and
      // gives the box nothing.
      const drawn = height(svg);
      ui.popSlack = wide ? 0 : Math.max(0, Math.floor(drawn - Math.min(drawn, vb.height * scale * POP_DESK_MIN)));
    } else {
      wrap?.classList.remove('pop-wide');
      ui.popSlack = 0;
    }
    // The chat box's room changes with the layout (the desk above the chat
    // or beside it, and its size), and the box is fitted to its room (#13).
    fitBox();
  }
  if (popoutOf(location.search)) {
    window.addEventListener('resize', popLayout);
    window.addEventListener('storage', (e) => { if (e.key === SCALE_KEY) popLayout(); });
  } else {
    window.addEventListener('resize', recordDeskScale);
  }

  /** A popout going, by its own word (`gone`) or by its lock coming free. */
  function takeGone(msg) {
    const k = outKey(msg.channel, msg.agent);
    const o = ui.outs.get(k);
    if (o && o.id && o.id !== msg.id) return;    // another window's word, about one it does not hold
    if (!o) return;                              // already back: "Bring chat back here" took it
    ui.popWins.delete(k);
    // A meeting room's window closing for a reload (issue #44) says `here`
    // again in a moment, like a popout's; held out for REJOIN_MS so the
    // floor's panel does not flash a composer in between, and then simply
    // back — a room going takes no panel.
    if (msg.rejoin) {
      ui.outs.set(k, { at: Date.now() - POP_TTL_MS + REJOIN_MS, id: o.id, held: false, meeting: o.meeting ?? null });
      setTimeout(() => { if (!isOut(msg.channel, msg.agent)) renderPanel(); }, REJOIN_MS + 50);
      return;
    }
    // Its own Re-attach is the operator asking for it here now, and so is
    // a desk the popout let go of (it followed a move, or the desk left).
    if (msg.now || !msg.open) {
      ui.outs.delete(k);
      if (msg.open) openDesk(msg.channel, msg.agent);
      else renderPanel();
      return;
    }
    // A window that just closed may be a reload, which says `here` again
    // in a moment. Until REJOIN_MS has passed it is still out, so the
    // floor's panel does not open the chat and then put it away again.
    ui.outs.set(k, { at: Date.now() - POP_TTL_MS + REJOIN_MS, id: o.id, held: false });
    // Then the chat opens here only if the floor's panel is shut, or is
    // this desk's already (renderPanel takes it back there). A panel on
    // another desk is left as it is: closing a window is not asking for
    // this chat, and taking the panel would throw the operator out of
    // whatever they were typing to someone else (costmo, task 273). The
    // desk is simply no longer out, and opens normally when clicked.
    // Re-attach and "Bring chat back here" are the explicit asks, above
    // and in bringBack(), and always open it.
    setTimeout(() => {
      if (isOut(msg.channel, msg.agent)) return; // reloaded, and out again
      if (!ui.open) openDesk(msg.channel, msg.agent);
      else renderPanel();
    }, REJOIN_MS);
  }

  /** A popout handing the floor that opened it its window, so the floor can bring it to the front — again after the floor reloads. */
  window.floorAdopt = (channel, agent, w) => { if (!ui.popout && w) ui.popWins.set(outKey(channel, agent), w); };

  /* The popout's half of the lock: taken for its desk, and `here` said
     only once it is held, so a floor that then asks for it waits for this
     window to go rather than being granted it on the spot. */
  let heldFor = null;            // the desk key whose lock this window holds
  let letGo = null;              // releases it
  function holdPresence() {
    if (!ui.popout) return;
    if (!LOCKS) { announce(); return; }
    const { channel, agent } = ui.popout;
    const k = outKey(channel, agent);
    navigator.locks.request(popLockName(channel, agent), () => new Promise((release) => {
      heldFor = k;
      letGo = () => { if (heldFor === k) { heldFor = null; letGo = null; } release(); };
      announce();
    })).catch(() => announce());
  }

  function announce() {
    if (!ui.popout || ui.ended) return;
    const held = heldFor === outKey(ui.popout.channel, ui.popout.agent);
    say({ t: 'here', channel: ui.popout.channel, agent: ui.popout.agent, id: POP_ID, held });
    try { window.opener?.floorAdopt?.(ui.popout.channel, ui.popout.agent, window); } catch { /* another origin, or gone */ }
  }

  /**
   * Detach: the desk's chat into a popup window of its own. A desk already
   * out is brought to the front instead — there is never a second window for
   * one desk. The draft is filed first, so the popout opens on it.
   */
  function detach(channel, agent, btn = null) {
    if (isOut(channel, agent)) { focusPopout(channel, agent); return; }
    if (ui.open?.channel === channel && ui.open?.agent === agent) stashDraft();
    const at = popoutPlace(window.screen, outsNow(ui.outs, Date.now()).size);
    let w = null;
    try { w = window.open(`${location.pathname}${popoutQuery(channel, agent)}`, popoutName(channel, agent), popoutFeatures(at)); } catch { w = null; }
    if (!w) { flash(btn, 'the browser blocked the window'); return; }
    ui.popWins.set(outKey(channel, agent), w);
    // Out from this click, not from the popout's first word: the floor's
    // composer for this desk goes now, so nothing can be typed in two places.
    // If the window never speaks, the desk is counted back in at POP_TTL_MS.
    ui.outs.set(outKey(channel, agent), { at: Date.now(), id: null });
    renderPanel();
  }

  function focusPopout(channel, agent) {
    const w = ui.popWins.get(outKey(channel, agent));
    if (w && !w.closed) { try { w.focus(); return; } catch { /* fall through */ } }
    say({ t: 'focus', channel, agent });
  }

  /** "Bring chat back here", on the floor: the popout closes and the floor's panel is the chat again. */
  function bringBack(channel, agent) {
    const k = outKey(channel, agent);
    say({ t: 'back', channel, agent });
    ui.outs.delete(k);
    ui.popWins.delete(k);
    openDesk(channel, agent);
  }

  /**
   * A popout ending: by its own Re-attach (`open` — the floor takes the chat
   * back), or because the floor asked (it has already). The draft is filed
   * under the desk, which is how it comes back on the floor. A window the
   * browser will not let the page close says where the chat went instead,
   * and stops saying it is out.
   */
  function endPopout(open) {
    if (!ui.popout || ui.ended) return;
    stashDraft();
    ui.ended = { open };
    say({ t: 'gone', channel: ui.popout.channel, agent: ui.popout.agent, id: POP_ID, open, now: true });
    letGo?.();
    closeStream();
    window.close();
    renderPanel();
  }

  /**
   * A popout's desk went to another floor: follow it. Its draft goes with
   * it, under the new key; the window's name and address follow too, so a
   * detach of the desk from its new floor finds this window and a reload
   * reopens it here.
   */
  function followTo(channel) {
    const { agent } = ui.popout;
    const ta = $('p-text');
    if (ta?.value) saveDraft(channel, agent, ta.value);
    say({ t: 'gone', channel: ui.popout.channel, agent, id: POP_ID, open: false });
    letGo?.();
    ui.popout = { channel, agent };
    try { history.replaceState(null, '', `${location.pathname}${popoutQuery(channel, agent)}`); } catch { /* the address is only for a reload */ }
    try { window.name = popoutName(channel, agent); } catch { /* not ours to name */ }
    ui.fate = null;
    ui.panelFor = null;
    openDesk(channel, agent);
    holdPresence();
  }

  /** What became of this popout's desk, each poll: follow a move; hold a leave or a disappearance for FATE_GRACE_MS, then say it. */
  function readFate() {
    const now = Date.now();
    const f = deskFate(floor.channels, ui.popout, ui.mem);
    if (f.state === 'moved') { followTo(f.channel); return; }
    if (f.state === 'here') {
      ui.fate = null;
      ui.mem = boundTo(f.desk) ?? ui.mem;
      ui.lastDesk = f.desk;
      document.title = `${f.desk.persona} · ${ui.popout.channel}`;
      return;
    }
    if (ui.fate?.state !== f.state) ui.fate = { state: f.state, since: now };
    if (f.desk) ui.lastDesk = f.desk;
  }
  /** A desk left or gone for long enough to say so. */
  const fateShown = () => (ui.fate && Date.now() - ui.fate.since >= FATE_GRACE_MS ? ui.fate.state : null);

  /* ---------- meeting rooms: the window ---------- */

  /*
   * A meeting room (issue #44) is this page with ?meeting=, the popout's
   * sibling. It is out in exactly the popout's way — a Web Lock per
   * participant, under the same name a desk's popout takes (popLockName),
   * and `here` on the same BroadcastChannel, carrying `meeting` — so
   * everything that already steps aside for a popout steps aside for it:
   * the floor's panel draws no composer for the desk, the detach button
   * brings this window to the front, a nudge struck on the floor is drawn
   * here. The lock is taken `ifAvailable`, which is the whole of Decided 3's
   * "one place at a time": a desk whose popout or other meeting room holds
   * its lock is not taken, and says so.
   *
   *   meeting → all : here  { channel, agent, id, held, meeting }  per participant
   *                   gone  { channel, agent, id, open: false, now: true }
   *   floor → meeting: back { channel, agent }   "Bring back" on the floor: remove it
   *                   focus, nudged, who        as for a popout
   *
   * Each desk's turns are its own, read under its own conversation from the
   * turn it joined after, and every message the room sends is one
   * /api/floor/chat per recipient: the room adds no route that types into a
   * window. What the board keeps is the record Resume reads (src/floor.js,
   * "meeting rooms").
   */
  const deskIn = (channel, agent) => floor.channels.find((c) => c.channel === channel)?.desks.find((x) => x.agent === agent) ?? null;
  const meetPersona = (agent) => deskIn(ui.meeting?.channel, agent)?.persona ?? agent;
  const meetEveryone = () => [...(ui.meeting?.parts ?? []), ...(ui.meeting?.left ?? [])];

  /** This desk's lock, if nobody holds it: a release function, or null when a popout or another room has the desk. */
  function takeDeskLock(channel, agent) {
    if (!LOCKS) return Promise.resolve(() => {});
    return new Promise((resolve) => {
      navigator.locks.request(popLockName(channel, agent), { ifAvailable: true }, (lock) => {
        if (!lock) { resolve(null); return undefined; }
        return new Promise((release) => resolve(release));
      }).catch(() => resolve(() => {}));
    });
  }

  function meetingAnnounce(part = null) {
    const m = ui.meeting;
    if (!m || m.phase === 'ended') return;
    for (const p of part ? [part] : m.parts) {
      say({ t: 'here', channel: m.channel, agent: p.agent, id: POP_ID, held: LOCKS, meeting: m.id ?? 'new' });
      try { window.opener?.floorAdopt?.(m.channel, p.agent, window); } catch { /* another origin, or gone */ }
    }
  }

  /** A line in the room's own voice, placed after every turn on its floor so far — loaded into the room yet or not, so a resumed room's notes stand under the conversation it picks up. */
  function meetingNote(text, kind = 'info') {
    const m = ui.meeting;
    const desks = floor.channels.find((c) => c.channel === m.channel)?.desks ?? [];
    const after = Math.max(0, ...meetEveryone().flatMap((p) => p.turns.map((t) => t.id)), ...desks.map((d) => d.last_turn?.id ?? 0));
    m.notes.push({ seq: ++m.seq, after, text, kind });
  }

  /** The record Resume reads: who is in the room now. Best effort — the window holds the truth while it is open. */
  function meetingSave() {
    const m = ui.meeting;
    if (!m?.id || m.phase === 'ended') return;
    post('./api/floor/meeting/participants', { id: m.id, agents: m.parts.map((p) => p.agent) }).catch(() => {});
  }

  /** Put a desk in the room. `since` is where its part of the transcript starts; a new participant starts from now. */
  async function meetingJoin(agent, { since = null, reopen = null, quiet = false } = {}) {
    const m = ui.meeting;
    if (!m || m.parts.some((p) => p.agent === agent)) return true;
    const release = await takeDeskLock(m.channel, agent);
    if (!release) {
      meetingNote(`${meetPersona(agent)} is in a window already — its own, or another meeting room — so it is not in this one.`, 'bad');
      return false;
    }
    const d = deskIn(m.channel, agent);
    // Back after a Remove: what it said in the room the first time stays.
    const before = m.left.find((p) => p.agent === agent);
    const part = {
      agent,
      since: since ?? d?.last_turn?.id ?? 0,
      session: d?.hosted?.session_id ?? null,
      turns: before?.turns ?? [], partial: '', delivery: d?.delivery ?? null,
      release, mem: boundTo(d), fate: null, reopen,
    };
    part.cursor = part.since;
    m.left = m.left.filter((p) => p.agent !== agent);
    m.parts.push(part);
    meetingAnnounce(part);
    if (!quiet) meetingNote(`${meetPersona(agent)} joined the meeting room.`);
    return true;
  }

  /** Take a desk out of the room: back on the floor, its own chat working there again. What it said here stays. */
  function meetingRemove(agent, words) {
    const m = ui.meeting;
    const at = m?.parts.findIndex((p) => p.agent === agent) ?? -1;
    if (at < 0) return;
    const [p] = m.parts.splice(at, 1);
    say({ t: 'gone', channel: m.channel, agent, id: POP_ID, open: false, now: true });
    p.release?.();
    p.release = null;
    p.partial = '';
    m.left.push(p);
    m.to?.delete(agent);
    if (words) meetingNote(words);
    meetingSave();
    openMeetingStream();
    render();
  }

  /**
   * Reopen a participant on the conversation it had, the way the Sessions
   * picker does it — the same route, refused for the same reasons in its
   * words. The host's list of the folder's conversations is asked first,
   * so a conversation gone from disk is said rather than handed to the host,
   * which would open the folder's newest instead (resumable(),
   * host/window.js) and move the desk off whatever it was on for nothing.
   */
  async function meetingReopen(step, since) {
    const m = ui.meeting;
    const q = `channel=${encodeURIComponent(m.channel)}&agent=${encodeURIComponent(step.agent)}`;
    try {
      const asked = await post('./api/floor/sessions', { channel: m.channel, agent: step.agent });
      const before = asked.at ?? null;
      for (let i = 0; i < 16; i++) {
        const got = await fetch(`./api/floor/sessions?${q}`).then((r) => r.json());
        if (got.rows?.length && (got.at !== before || !asked.asked)) {
          if (!got.rows.some((r) => r.id === step.session_id)) {
            meetingNote(`${step.persona} was not reopened: its conversation is gone from its folder.`, 'bad');
            return;
          }
          break;
        }
        await new Promise((ok) => setTimeout(ok, 400));
      }
    } catch { /* no list: the reopen goes ahead, and the host says what it found */ }
    const d = deskIn(m.channel, step.agent);
    try {
      await post('./api/floor/reopen', { channel: m.channel, agent: step.agent, session_id: step.session_id });
    } catch (err) {
      meetingNote(`${step.persona} was not reopened: ${err.message ?? err}`, 'bad');
      return;
    }
    await meetingJoin(step.agent, {
      since, quiet: true,
      reopen: { sessionId: step.session_id, from: step.from ?? null, since: Date.now(), base: d?.last_turn?.id ?? 0 },
    });
  }

  /** A reopen in flight, against the payload: landed, refused by the host, the host opening another, or out of time. */
  async function meetingSettleReopen(p, d) {
    const r = p.reopen;
    const who = d?.persona ?? p.agent;
    const sid = d?.hosted?.session_id ?? null;
    if (sid === r.sessionId) {
      p.reopen = null;
      meetingNote(`${who} is back on its conversation.`);
      return;
    }
    // The host's refusal is an error turn, filed under whatever conversation
    // the desk had, so it is read unscoped rather than through the room's view.
    try {
      const got = await fetch(`./api/floor/turns?channel=${encodeURIComponent(ui.meeting.channel)}&agent=${encodeURIComponent(p.agent)}&since=${r.base}&limit=100`).then((x) => x.json());
      const err = (got.rows ?? []).find((t) => t.role === 'error');
      if (err) { meetingRemove(p.agent, `${who} was not reopened: ${err.text}`); return; }
    } catch { /* asked again next poll */ }
    const real = !!sid && !String(sid).startsWith('host:');
    if (real && sid !== r.from) {
      meetingRemove(p.agent, `${who}'s conversation could not be opened, and its host opened another one instead, so it is not in this meeting room.`);
      return;
    }
    if (Date.now() - r.since > MOVE_MS) meetingRemove(p.agent, `${who} was not back on its conversation after ${MOVE_MS / 1000}s, so it is not in this meeting room.`);
  }

  /** One participant's turns since the room last asked, under the conversation its desk is on. */
  async function meetingLoadTurns(p) {
    const m = ui.meeting;
    const url = `./api/floor/turns?channel=${encodeURIComponent(m.channel)}&agent=${encodeURIComponent(p.agent)}&since=${p.cursor}&limit=500` +
      (p.session ? `&session=${encodeURIComponent(p.session)}` : '');
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
      if (!r.ok) return;
      const got = await r.json();
      if (got.session !== (p.session ?? null) && (got.session || p.session)) return;   // asked under a conversation it has left since
      const known = new Set(p.turns.map((t) => t.id));
      const fresh = (got.rows ?? []).filter((t) => !known.has(t.id));
      if (fresh.length) p.turns = p.turns.concat(fresh).sort((a, b) => a.id - b.id).slice(-600);
      p.cursor = Math.max(p.cursor, ...(got.rows ?? []).map((t) => t.id));
      if (typeof got.partial === 'string' && !ui.stream) p.partial = got.partial;
    } catch { /* the next poll asks again */ }
  }

  /** Each room message, desk by desk, against what each desk wrote. */
  function meetingFollow() {
    const m = ui.meeting;
    for (const s of m.sends) {
      for (const e of s.entries) {
        const p = meetEveryone().find((x) => x.agent === e.agent);
        const d = deskIn(m.channel, e.agent);
        if (e.opens && e.readyAt == null && d?.nudge?.ok && !d.nudge.opens) e.readyAt = Date.now();
        Object.assign(e, meetingEntry(e, s.text, p?.turns, p?.delivery));
      }
      stampFronts(s);
      // Nothing the page does may cost somebody their own writing: a message
      // no desk took goes back into the box, as the panel's settle() does.
      if (!s.returned && s.entries.length && s.entries.every((e) => e.state === 'refused' || e.state === 'failed')) {
        s.returned = true;
        const box = $('p-text');
        if (box && s.fromBox) {
          box.value = box.value.trim() ? `${s.text}\n\n${box.value}` : s.text;
          stashDraft();
        }
      }
    }
  }

  /** Each poll, in the room's window: what became of each desk, then its turns and the room's messages. */
  async function meetingTick() {
    const m = ui.meeting;
    if (m?.phase !== 'live') return;
    const now = Date.now();
    for (const p of [...m.parts]) {
      const f = deskFate(floor.channels, { channel: m.channel, agent: p.agent }, p.mem);
      const who = f.desk?.persona ?? p.agent;
      // A host gone offline reads as "left" to deskFate (its binding is not
      // live), and a host restart is exactly that for a few seconds. The
      // room keeps such a desk: it reads "away" in the row, and a message to
      // it is refused in the board's words. Only a binding that is gone —
      // Leave desk — takes a desk out.
      if (f.state === 'here' || (f.state === 'left' && f.desk?.hosted)) { p.fate = null; p.mem = boundTo(f.desk) ?? p.mem; continue; }
      if (f.state === 'moved') { meetingRemove(p.agent, `${who} moved to ${f.channel}, so it has left the meeting room: a meeting room is one floor's desks.`); continue; }
      if (p.fate?.state !== f.state) p.fate = { state: f.state, since: now };
      else if (now - p.fate.since >= FATE_GRACE_MS) {
        meetingRemove(p.agent, f.state === 'left'
          ? `${who} left its desk — the binding is gone, and its window with it — so it has left the meeting room.`
          : `${p.agent} is no longer on the board, so it has left the meeting room.`);
      }
    }
    let moved = false;
    for (const p of m.parts) {
      const d = deskIn(m.channel, p.agent);
      const sid = d?.hosted?.session_id ?? null;
      // A conversation that changed under a participant (a /clear, a
      // reopen): its turns from here are the new one's, read from the turn
      // it joined after. What is on screen stays — it was said in the room.
      if (sid !== p.session) {
        p.session = sid;
        p.cursor = p.since;
        if (sid && !String(sid).startsWith('host:')) moved = true;
      }
      if (!ui.stream) p.delivery = d?.delivery ?? null;
      if (p.reopen) await meetingSettleReopen(p, d);
    }
    if (moved) meetingSave();
    await Promise.all(m.parts.map(meetingLoadTurns));
    meetingFollow();
  }

  /**
   * Open the room's window: create its record, or open the one named — a
   * reload, or a Resume, which then reopens each desk on its conversation.
   * The address becomes the room's own, so a reload opens this room again
   * and neither creates another nor reopens anything a second time.
   */
  async function startMeeting(spec) {
    const m = ui.meeting = {
      id: spec.id, channel: spec.channel, phase: 'starting', error: null,
      parts: [], left: [], sends: [], notes: [], seq: 0, to: null, nodes: new Map(), room: null, sig: null,
    };
    render();
    try {
      const got = spec.id
        ? await post('./api/floor/meeting/open', { id: spec.id })
        : await post('./api/floor/meeting', { channel: spec.channel, agents: spec.agents });
      m.room = got.room;
      m.id = got.room.id;
      m.channel = got.room.channel;
    } catch (err) {
      m.phase = 'failed';
      m.error = String(err.message ?? err);
      render();
      return;
    }
    try { history.replaceState(null, '', `${location.pathname}${meetingQuery({ id: m.id })}`); } catch { /* only for a reload */ }
    try { window.name = meetingName(m.id); } catch { /* not ours to name */ }
    document.title = `Meeting room · ${m.channel}`;
    // What is out in other windows, before any desk is taken: the popouts
    // and other rooms answer `who` within a moment.
    say({ t: 'who' });
    await new Promise((ok) => setTimeout(ok, 300));
    await tick();
    m.phase = 'joining';
    render();
    const outs = outsNow(ui.outs, Date.now());
    const steps = spec.resume
      ? meetingResumePlan(m.room, floor.channels, outs)
      : m.room.participants.map((p) => ({ agent: p.agent, persona: meetPersona(p.agent), act: 'join' }));
    const since = new Map(m.room.participants.map((p) => [p.agent, Number.isInteger(p.since) ? p.since : null]));
    for (const step of steps) {
      if (step.act === 'skip') meetingNote(`${step.persona} was not reopened: ${step.why}`, 'bad');
      else if (step.act === 'reopen') await meetingReopen(step, since.get(step.agent));
      else await meetingJoin(step.agent, { since: since.get(step.agent), quiet: true });
    }
    if (spec.resume) meetingNote(`Resumed. ${m.parts.length ? `${m.parts.map((p) => meetPersona(p.agent)).join(', ')} ${m.parts.length === 1 ? 'is' : 'are'} here.` : 'Nobody could be reopened.'}`);
    m.phase = 'live';
    meetingSave();
    openMeetingStream();
    await tick();
    $('p-text')?.focus();
  }

  /** End the meeting: every desk back on the floor, the record kept for Resume, and the window closed. */
  function endMeeting({ closing = false } = {}) {
    // `closing` is pagehide: the window may be reloading, and then says
    // `here` again in a moment (`rejoin`); End meeting and a closed window
    // both end the record, and the reload's `/open` takes it back.
    const m = ui.meeting;
    if (!m || m.phase === 'ended' || m.phase === 'failed') return;
    stashDraft();
    m.phase = 'ended';
    if (m.id) {
      try {
        fetch('./api/floor/meeting/end', {
          method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: m.id }),
        }).catch(() => {});
      } catch { /* the page is going */ }
    }
    for (const p of m.parts) {
      say({ t: 'gone', channel: m.channel, agent: p.agent, id: POP_ID, open: false, ...(closing ? { rejoin: true } : { now: true }) });
      p.release?.();
      p.release = null;
    }
    closeStream();
    closePromptMenu();
    if (closing) return;
    window.close();
    render();
  }

  /**
   * Send from the room: one /api/floor/chat per recipient, in the bulk
   * nudge's order (nudgePlan — the open windows first, so a window still
   * coming up keeps only itself waiting), each desk refused in the board's
   * own words and the rest sent anyway. The words leave the box once any
   * desk has them; who hears goes back to everyone for the next message.
   */
  async function sendMeeting(given = null, { nudge = false } = {}) {
    const m = ui.meeting;
    const box = $('p-text');
    const btn = document.querySelector('#floor-panel [data-act="send"]');
    const text = typeof given === 'string' ? given : (box?.value ?? '');
    if (m?.phase !== 'live' || !text.trim() || !btn || btn.disabled) return;
    const inRoom = m.parts.map((p) => p.agent);
    const to = meetingTo(inRoom, m.to);
    if (!to.length) { flash(btn, 'nobody is chosen to hear it'); return; }
    const desks = to.map((a) => deskIn(m.channel, a)).filter(Boolean);
    const plan = nudgePlan(desks);
    const s = {
      seq: ++m.seq, text, at: Date.now(), to, everyone: to.length === inRoom.length, fromBox: typeof given !== 'string',
      entries: [
        ...plan.send.map((e) => ({ ...e, state: 'line' })),
        ...plan.blocked.map((e) => ({ agent: e.agent, persona: e.persona, host: null, state: 'refused', words: e.reason })),
      ],
    };
    m.sends.push(s);
    btn.disabled = true;
    ui.stick = true;
    render();
    let taken = 0;
    for (const e of s.entries.filter((x) => x.state === 'line')) {
      try {
        await post('./api/floor/chat', { channel: m.channel, agent: e.agent, text });
        taken++;
        // A nudge rings the desk, here and on the floor, as the bell does.
        if (nudge) { ring(m.channel, e.agent); say({ t: 'rang', channel: m.channel, agent: e.agent }); }
      } catch (err) {
        e.state = 'refused';
        e.words = String(err.message ?? err);
      }
    }
    stampFronts(s);
    if (taken && s.fromBox) {
      box.value = '';
      m.to = null;
      stashDraft();
      drawSlash();
    }
    btn.disabled = false;
    render();
    box?.focus();
    tick();
  }

  /** A nudge struck on the floor for a participant: its pending line is drawn here, where its chat is. */
  function meetingNudged(agent, text) {
    const m = ui.meeting;
    const d = deskIn(m.channel, agent);
    if (!d || m.phase !== 'live') return;
    const plan = nudgePlan([d]);
    const e = plan.send[0] ? { ...plan.send[0], state: 'line' } : { agent, persona: d.persona, host: null, state: 'refused', words: plan.blocked[0]?.reason ?? '' };
    m.sends.push({ seq: ++m.seq, text, at: Date.now(), to: [agent], everyone: false, fromBox: false, entries: [e] });
    stampFronts(m.sends.at(-1));
    render();
  }

  /** What the room's window hears from the others. */
  function meetingHears(msg) {
    const m = ui.meeting;
    const part = msg.channel === m.channel ? m.parts.find((p) => p.agent === msg.agent) : null;
    if (msg.t === 'who') meetingAnnounce();
    else if (msg.t === 'back' && part) meetingRemove(part.agent, `${meetPersona(part.agent)} was brought back to the floor.`);
    else if (msg.t === 'focus' && part) window.focus();
    else if (msg.t === 'nudged' && part) meetingNudged(part.agent, msg.text);
    else if (msg.t === 'here' && msg.id !== POP_ID) {
      ui.outs.set(outKey(msg.channel, msg.agent), { at: Date.now(), id: msg.id, held: LOCKS && msg.held === true, meeting: msg.meeting ?? null });
    } else if (msg.t === 'gone' && msg.id !== POP_ID) {
      const o = ui.outs.get(outKey(msg.channel, msg.agent));
      if (o && (!o.id || o.id === msg.id)) ui.outs.delete(outKey(msg.channel, msg.agent));
    }
  }

  /** One stream event for one participant. */
  function meetingEvent(p, ev) {
    if (ev.type === 'turn' && ev.turn) {
      if (p.session && ev.turn.session_id && ev.turn.session_id !== p.session) return;
      if (ev.turn.id <= p.since || p.turns.some((t) => t.id === ev.turn.id)) return;
      p.turns = p.turns.concat([ev.turn]).slice(-600);
      if (ev.turn.role === 'assistant') p.partial = '';
      meetingFollow();
      render();
    } else if (ev.type === 'partial') {
      p.partial = ev.text ?? '';
      render();
    } else if (ev.type === 'delivery') {
      p.delivery = ev.delivery ?? null;
      meetingFollow();
      render();
    } else if (ev.type === 'permission' || ev.type === 'state' || ev.type === 'session' || ev.type === 'compacting') {
      tick();
    }
  }

  /** One stream for every participant: through the hub (one connection for every window), or one of its own. */
  function openMeetingStream() {
    closeStream();
    const m = ui.meeting;
    if (!m?.parts.length || m.phase === 'ended') return;
    const desks = m.parts.map((p) => [m.channel, p.agent]);
    const onEvent = (c, a, ev) => {
      const p = c === ui.meeting?.channel ? ui.meeting.parts.find((x) => x.agent === a) : null;
      if (p) meetingEvent(p, ev);
    };
    if (hub && !hubFailed) {
      ui.stream = { hub: true, desks, onEvent, close() { ui.stream = null; wantHub(); } };
      wantHub();
      return;
    }
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource(`./api/floor/stream?desks=${encodeURIComponent(JSON.stringify(desks))}`);
    es.onmessage = (msg) => {
      let ev;
      try { ev = JSON.parse(msg.data); } catch { return; }
      onEvent(ev.channel, ev.agent, ev);
    };
    ui.stream = es;
  }

  /* The room's window, drawn. The shell is built once; every part of it
     after that is a slot redrawn only when what it shows changed, for the
     panel's reasons: a box rebuilt under the operator loses their typing,
     and a list rebuilt under a click loses the click. */
  function meetingShell(wrap) {
    const m = ui.meeting;
    wrap.dataset.channel = m.channel;
    // Drafts and the box's height are filed under the panel's desk; the
    // room's are its own.
    wrap.dataset.agent = `meeting-${m.id}`;
    wrap.dataset.meeting = String(m.id);
    wrap.innerHTML = `
      <div class="p-head m-head">
        <div class="p-id">
          <span class="p-persona-read">Meeting room</span>
          <span class="mono muted">${esc(m.channel)}</span>
        </div>
        <span class="m-addslot"></span>
        <button class="btn" data-act="m-end" title="Every desk goes back to the floor. The room stays in Recent meeting rooms for Resume.">End meeting</button>
      </div>
      <div class="m-parts" role="list" aria-label="In this meeting room"></div>
      <div class="p-turns" id="p-turns"></div>
      <div class="p-compose">
        <div class="m-alerts"></div>
        <div class="m-to" role="group" aria-label="Who hears this message"></div>
        <textarea id="p-text" class="input" rows="3"></textarea>
        <div class="p-slash hidden" role="listbox"></div>
        <div class="p-actions">
          <span class="muted p-hint"></span>
          <button class="btn m-nudge-all" data-act="m-nudge-all"></button>
          <button class="btn promptbtn" data-act="prompts" aria-label="Saved prompts" aria-haspopup="menu" aria-expanded="false"><svg class="promptGlyph" viewBox="${PROMPT_BOX}" aria-hidden="true">${PROMPT_GLYPH}</svg></button>
          <button class="btn primary" data-act="send">Send</button>
        </div>
      </div>`;
    const box = $('p-turns');
    ui.stick = true;
    box.addEventListener('scroll', () => { ui.stick = box.scrollHeight - box.scrollTop - box.clientHeight < 12; });
    $('p-text').value = loadDraft(m.channel, `meeting-${m.id}`);
    m.nodes = new Map();
  }

  /** A participant's colour: its shirt, the one thing that tells two desks apart on the floor. */
  const meetColour = (agent) => deskIn(ui.meeting.channel, agent)?.shirt ?? 'var(--muted)';

  function meetingItemNode(it) {
    const m = ui.meeting;
    if (it.kind === 'turn') {
      const node = turnNode(it.turn, meetPersona(it.agent));
      node.classList.add('m-said');
      node.style.setProperty('--m-c', meetColour(it.agent));
      return node;
    }
    if (it.kind === 'note') {
      const div = document.createElement('div');
      div.className = `t t-tool t-context m-note${it.note.kind === 'bad' ? ' m-note-bad' : ''}`;
      div.innerHTML = '<span class="t-dot"></span><span class="t-text"></span>';
      div.querySelector('.t-text').textContent = it.note.text;
      return div;
    }
    const div = document.createElement('div');
    if (it.kind === 'user') {
      div.className = 't t-user m-msg';
      div.innerHTML = `<div class="t-who">you → ${esc(meetingToLine(it.agents, false, meetPersona))}<span class="t-when mono" data-at="${esc(it.turn.created_at)}">${esc(ago(it.turn.created_at))}</span></div><div class="t-body"></div>`;
      div.querySelector('.t-body').textContent = it.turn.text ?? '';
      return div;
    }
    // A message this room sent: who it went to, its words, and under them
    // where it stands on each desk — refusals and failures named, never
    // dropped (the issue's "said, never silently skipped").
    const s = it.send;
    const settled = s.entries.some((e) => e.state === 'recorded' || e.state === 'done');
    div.className = `t t-user m-msg${settled ? '' : ' t-pending'}`;
    const now = Date.now();
    const rows = s.entries.map((e) => {
      const d = deskIn(m.channel, e.agent);
      const w = meetingEntryWord(e, s.entries, !!d?.nudge?.opens, s.at, now, SENDING_GRACE_MS);
      return `<span class="m-deliv ${w.kind}" style="--m-c:${esc(meetColour(e.agent))}" title="${esc(w.text)}"><b>${esc(meetPersona(e.agent))}</b> ${esc(w.text)}</span>`;
    }).join('');
    div.innerHTML = `<div class="t-who">you → ${esc(meetingToLine(s.to, s.everyone, meetPersona))}</div><div class="t-body"></div><div class="m-delivs">${rows}</div>`;
    div.querySelector('.t-body').textContent = s.text;
    return div;
  }

  function meetingItemSig(it) {
    if (it.kind === 'send') {
      const now = Date.now();
      return JSON.stringify([it.send.entries.map((e) => [e.agent, meetingEntryWord(e, it.send.entries, !!deskIn(ui.meeting.channel, e.agent)?.nudge?.opens, it.send.at, now, SENDING_GRACE_MS).text]), it.send.to]);
    }
    if (it.kind === 'user') return JSON.stringify(it.agents);
    if (it.kind === 'turn') return meetPersona(it.agent);
    return '';
  }

  function renderMeeting() {
    const wrap = $('floor-panel');
    const m = ui.meeting;
    wrap.classList.remove('hidden');
    if (m.phase === 'starting' || m.phase === 'failed' || m.phase === 'ended') {
      const forKey = `meeting|${m.phase}`;
      if (ui.panelFor !== forKey) {
        ui.panelFor = forKey;
        const names = meetEveryone().filter((p) => m.parts.includes(p) || m.phase !== 'ended').map((p) => meetPersona(p.agent));
        wrap.innerHTML = `
          <div class="p-head"><div class="p-id"><span class="p-persona-read">Meeting room</span><span class="mono muted">${esc(m.channel ?? '')}</span></div></div>
          <div class="p-out">
            <p class="p-out-why"></p>
            ${m.phase === 'starting' ? '' : '<button class="btn primary" data-act="close-window">Close this window</button>'}
          </div>`;
        wrap.querySelector('.p-out-why').textContent = m.phase === 'starting'
          ? 'Opening the meeting room…'
          : m.phase === 'failed'
            ? `This meeting room could not be opened: ${m.error}`
            : `This meeting has ended.${names.length ? ` ${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} back on the floor.` : ''} It is in Recent meeting rooms on the floor, if you want it again.`;
      }
      return;
    }
    if (ui.panelFor !== 'meeting|live') {
      meetingShell(wrap);
      ui.panelFor = 'meeting|live';
    }
    const outs = outsNow(ui.outs, Date.now());
    const c = floor.channels.find((x) => x.channel === m.channel);
    const inRoom = new Set(m.parts.map((p) => p.agent));

    // Add: the floor's drawn desks that are free (Decided 3).
    const addable = c ? meetingAddable(deskRows(c).drawn, inRoom, outs, m.channel) : [];
    const addSig = JSON.stringify([m.phase, addable.map((d) => [d.agent, d.persona])]);
    const addSlot = wrap.querySelector('.m-addslot');
    if (addSlot.dataset.sig !== addSig) {
      addSlot.dataset.sig = addSig;
      addSlot.innerHTML = `<select class="input m-add" data-act="m-add" aria-label="Add a desk from this floor"${addable.length && m.phase === 'live' ? '' : ' disabled'}
          title="${addable.length ? 'Add a desk drawn on this floor' : 'Every other desk on this floor is out in a window already, or there is none'}">
        <option value="">${addable.length ? 'Add a desk…' : 'No desk to add'}</option>
        ${addable.map((d) => `<option value="${esc(d.agent)}">${esc(d.persona)} (${esc(d.agent)})</option>`).join('')}
      </select>`;
    }

    // Who is in it, each with its state at a glance, its stop sign and a way
    // back to the floor.
    const partsEl = wrap.querySelector('.m-parts');
    const parts = m.parts.map((p) => {
      const d = deskIn(m.channel, p.agent);
      const st = d ? deskState(d) : 'away';
      return {
        p, d, st, word: p.reopen ? 'reopening…' : MEET_STATE_WORD[st] ?? st, stop: stopBlock(d),
        pills: d ? signPills(d) : [], nudge: d?.nudge ?? null,
      };
    });
    const partsSig = JSON.stringify(parts.map((x) => [x.p.agent, x.d?.persona, x.d?.shirt, x.st, x.word, x.stop, x.pills, x.nudge]));
    if (partsEl.dataset.sig !== partsSig) {
      partsEl.dataset.sig = partsSig;
      // Two rows (costmo): the name, its state and the way out, then the
      // desk's badges. The badges are the desk's own pills — unread,
      // assigned, claimed — its bell and its stop sign:
      // what the floor draws on the desk, so a participant's waiting
      // messages and the way to nudge it are on the room's row too. A pill
      // opens the floor's own dialog (openPill), the bell is the floor's
      // own strike().
      const bellTitle = (who, n) => (!n?.ok ? `Can't nudge ${who}: ${n?.reason ?? 'nothing is known about this desk yet'}`
        : n.opens ? `Nudge ${who} — opens its window first, resuming its conversation` : `Nudge ${who}: type “nudge” into its window`);
      partsEl.innerHTML = parts.length ? parts.map(({ p, d, st, word, stop, pills, nudge }) => `
        <span class="m-part s-${esc(st)}${pills.some((x) => x.act === 'unread') ? ' has-unread' : ''}" role="listitem" data-for-channel="${esc(m.channel)}" data-for-agent="${esc(p.agent)}" style="--m-c:${esc(d?.shirt ?? 'var(--muted)')}">
          <span class="m-row m-row-name">
          <b>${esc(d?.persona ?? p.agent)}</b>
          <span class="m-state">${esc(word)}</span>
          <button class="btn m-remove" data-act="m-remove" title="Take ${esc(d?.persona ?? p.agent)} out of the meeting room: back on the floor, its own chat working there again" aria-label="Remove ${esc(d?.persona ?? p.agent)} from the meeting room">✕</button>
          </span>
          <span class="m-row m-row-badges">
          ${pills.map((x) => `<button type="button" class="m-pill m-pill-${esc(x.cls)}" data-act="m-pill" data-which="${esc(x.act)}" data-kind="${esc(x.kind ?? '')}" title="${esc(x.title)}">${esc(x.mark)} ${x.n}</button>`).join('')}
          <button class="btn m-bell" data-act="m-nudge" ${nudge?.ok ? '' : 'disabled'} title="${esc(bellTitle(d?.persona ?? p.agent, nudge))}" aria-label="${esc(bellTitle(d?.persona ?? p.agent, nudge))}"><svg class="m-bellGlyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2a.9.9 0 0 1 .9.9v.5a4.2 4.2 0 0 1 3.3 4.1v2.6l1.1 1.4v.8H2.7v-.8l1.1-1.4V7.7a4.2 4.2 0 0 1 3.3-4.1v-.5a.9.9 0 0 1 .9-.9zM6.6 13.3h2.8a1.4 1.4 0 0 1-2.8 0z"/></svg></button>
          <button class="btn stopbtn m-stop" data-act="stop" ${stop ? 'disabled' : ''} title="${esc(stop ?? `Stop ${d?.persona ?? p.agent}`)}" aria-label="${esc(stop ? `Cannot stop ${d?.persona ?? p.agent}` : `Stop ${d?.persona ?? p.agent}`)}"><svg class="stopGlyph" viewBox="${STOP_BOX}" aria-hidden="true"><polygon points="${STOP_PTS}" /></svg></button>
          </span>
        </span>`).join('') : '<span class="muted m-empty">Nobody is in this meeting room. Add a desk from the floor, or end it.</span>';
    }

    // Each participant's prompt, labelled with its desk: one box each, drawn
    // by the panel's own drawAlert and answered by the panel's own handlers.
    const alerts = wrap.querySelector('.m-alerts');
    for (const node of [...alerts.children]) if (!inRoom.has(node.dataset.forAgent)) node.remove();
    for (const { p, d } of parts) {
      if (!d) continue;
      let node = [...alerts.children].find((n) => n.dataset.forAgent === p.agent);
      if (!node) {
        node = document.createElement('div');
        node.className = 'm-alert';
        node.dataset.forChannel = m.channel;
        node.dataset.forAgent = p.agent;
        node.innerHTML = '<div class="m-alert-who"></div><div class="p-alert-slot"></div>';
        alerts.appendChild(node);
      }
      node.style.setProperty('--m-c', d.shirt ?? 'var(--muted)');
      node.querySelector('.m-alert-who').textContent = d.persona;
      const h = d.hosted;
      drawAlert(node.querySelector('.p-alert-slot'), d, m.channel, p.agent, !!h?.live && h?.held !== 'editor');
      const form = node.querySelector('.p-ask');
      if (form) askWarn(form);
    }

    // Who hears the next message: everyone, unless narrowed for this one.
    const to = meetingTo(m.parts.map((p) => p.agent), m.to);
    const everyone = to.length === m.parts.length;
    const toEl = wrap.querySelector('.m-to');
    const toSig = JSON.stringify([m.parts.map((p) => [p.agent, meetPersona(p.agent)]), to]);
    if (toEl.dataset.sig !== toSig) {
      toEl.dataset.sig = toSig;
      toEl.innerHTML = m.parts.length ? `<span class="muted m-to-label">To</span>
        <button type="button" class="chip${everyone ? ' on' : ''}" data-act="m-to-all" aria-pressed="${everyone}">everyone</button>
        ${m.parts.map((p) => `<button type="button" class="chip m-to-one${to.includes(p.agent) ? ' on' : ''}" data-act="m-to" data-agent="${esc(p.agent)}" aria-pressed="${to.includes(p.agent)}" style="--m-c:${esc(meetColour(p.agent))}">${esc(meetPersona(p.agent))}</button>`).join('')}` : '';
    }
    const ta = $('p-text');
    ta.placeholder = !to.length ? 'Choose who hears this…' : everyone ? 'Message everyone in the room…' : `Message ${to.map(meetPersona).join(', ')}…`;
    wrap.querySelector('[data-act="send"]').disabled = !to.length || m.phase !== 'live';
    const nudgeBtn = wrap.querySelector('[data-act="m-nudge-all"]');
    const nudgeChip = meetingNudgeChip(to.map((a) => deskIn(m.channel, a)).filter(Boolean), everyone);
    nudgeBtn.textContent = nudgeChip.text;
    nudgeBtn.title = nudgeChip.title;
    nudgeBtn.disabled = nudgeChip.disabled || m.phase !== 'live';
    nudgeBtn.classList.toggle('waiting', nudgeChip.waiting);
    wrap.querySelector('.p-hint').textContent = !m.parts.length ? ''
      : !to.length ? 'Nobody is chosen to hear the next message.'
        : everyone ? `Everyone in the room hears this. Enter sends, Shift+Enter for a new line.`
          : `Only ${to.map(meetPersona).join(', ')} ${to.length === 1 ? 'hears' : 'hear'} this one; the next goes to everyone again.`;

    // The transcript: keyed, so a turn on screen stays exactly where it is,
    // and a message's line of deliveries is redrawn in place as each lands.
    const box = $('p-turns');
    const items = meetingItems(meetEveryone(), m.sends, m.notes);
    const want = new Set(items.map((it) => it.key));
    for (const [k, node] of m.nodes) if (!want.has(k)) { node.remove(); m.nodes.delete(k); }
    box.querySelector('.q-empty')?.remove();
    for (const node of box.querySelectorAll('.t-partial')) node.remove();
    let prev = null;
    for (const it of items) {
      let node = m.nodes.get(it.key);
      const sig = meetingItemSig(it);
      if (!node || node.dataset.sig !== sig) {
        const fresh = meetingItemNode(it);
        fresh.dataset.sig = sig;
        fresh.dataset.key = it.key;
        if (node) node.replaceWith(fresh);
        m.nodes.set(it.key, fresh);
        node = fresh;
      }
      const at = prev ? prev.nextSibling : box.firstChild;
      if (node !== at) box.insertBefore(node, at);
      prev = node;
    }
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'q-empty';
      empty.textContent = m.parts.length ? 'Say something to the room. Each desk’s replies come back here, labelled with its name.' : '';
      box.appendChild(empty);
    }
    // Replies being written right now, one per desk, at the bottom.
    for (const p of m.parts) {
      if (!p.partial) continue;
      const node = document.createElement('div');
      node.className = 't t-assistant t-partial m-said';
      node.style.setProperty('--m-c', meetColour(p.agent));
      node.innerHTML = `<div class="t-who">${esc(meetPersona(p.agent))}<span class="t-when mono">typing…</span></div><div class="t-body"></div>`;
      node.querySelector('.t-body').textContent = p.partial;
      box.appendChild(node);
    }
    for (const w of wrap.querySelectorAll('.t-when[data-at]')) w.textContent = ago(w.dataset.at);
    fitBox();
    if (ui.stick) box.scrollTop = box.scrollHeight;
  }

  /* The floor's half: open a room from the selection toolbar, resume one
     from the Recent list. Both are clicks, so window.open runs inside them:
     the browser blocks a popup the page opens on its own. */
  const meetSelNote = new Map();   // channel -> what the last Meeting room click came to, for the toolbar's line
  function openMeetingRoom(channel) {
    const outs = outsNow(ui.outs, Date.now());
    const chip = meetingChip(checkedHere(channel), outs, channel);
    if (chip.disabled) return;
    const key = `new-${Math.random().toString(36).slice(2, 8)}`;
    let w = null;
    try { w = window.open(`${location.pathname}${meetingQuery({ channel, agents: chip.agents })}`, meetingName(key), popoutFeatures(meetingPlace(window.screen))); } catch { w = null; }
    if (!w) { meetSelNote.set(channel, 'meeting room: the browser blocked the window'); render(); return; }
    meetSelNote.set(channel, `meeting room: ${chip.agents.join(', ')}`);
    // Out from this click, as a detach is: the floor's composer for each
    // desk goes now. The window's own `here` replaces these within a moment.
    for (const a of chip.agents) {
      ui.outs.set(outKey(channel, a), { at: Date.now(), id: null, meeting: 'new' });
      ui.popWins.set(outKey(channel, a), w);
    }
    render();
  }

  /** The rooms open in a window now, by id: the Recent list leaves them out, and Resume of one brings it to the front. */
  window.floorOpenMeetings = () => {
    const open = new Map();
    for (const [k, o] of ui.outs) if (o.meeting && o.meeting !== 'new' && outsNow(new Map([[k, o]]), Date.now()).size) open.set(String(o.meeting), k);
    return open;
  };

  /** Resume, from the Recent list: a new window for the room, which reopens each desk on its conversation. */
  window.floorResumeMeeting = (id) => {
    const open = window.floorOpenMeetings().get(String(id));
    if (open) { const [channel, agent] = open.split('|'); focusPopout(channel, agent); return true; }
    let w = null;
    try { w = window.open(`${location.pathname}${meetingQuery({ id, resume: true })}`, meetingName(id), popoutFeatures(meetingPlace(window.screen))); } catch { w = null; }
    return !!w;
  };

  /* ---------- live updates for the open desk ---------- */

  /*
   * One stream for every window of this board (issue #19). A browser holds at
   * most six connections to the board, shared by all its windows, and an event
   * stream keeps one for as long as it is open — so the floor plus five
   * popouts, each streaming its own desk, would leave no connection for any
   * poll in any of them. Each window tells the SharedWorker in hub.js which
   * desk it shows, and the worker holds one stream for all of them. `HUB_P`
   * names the protocol: a worker outlives a deploy while any window is open,
   * and a page must not talk to one that speaks an older one.
   *
   * A browser with no SharedWorker gets the stream it always had, one per
   * window. It is the same handler either way.
   */
  const HUB_P = 2;     // 2: `hello`, a window's lock (PR #41)
  /* A window's want doubles as its heartbeat; the worker drops one silent for
     30 s. */
  const WANT_EVERY_MS = 5000;
  let hubFailed = false;
  const hub = (() => {
    try {
      if (typeof SharedWorker !== 'function') return null;
      const w = new SharedWorker(`./hub.js?p=${HUB_P}`, { name: `orch-hub-${HUB_P}` });
      w.port.onmessage = (m) => {
        const msg = m.data ?? {};
        if (msg.t === 'ev' && ui.stream?.hub) ui.stream.onEvent(msg.channel, msg.agent, msg.ev);
      };
      // A worker that could not start would leave the panel holding a
      // stream that never speaks — and a panel with a stream does not take
      // the delivery note from the poll. So it falls back to its own.
      w.onerror = () => {
        hubFailed = true;
        if (ui.stream?.hub) { if (ui.meeting) openMeetingStream(); else openStream(ui.stream.channel, ui.stream.agent); }
      };
      w.port.start();
      // This window's lock, held for as long as it is open. The worker asks
      // for it once told its name, and is granted it when this window goes:
      // that, and not a silence, is how it learns a window has closed (QA,
      // PR #41 finding 1 — a minimized window's want is throttled to once a
      // minute, and the 30 s silence dropped it from the stream every time).
      if (navigator.locks?.request) {
        const name = `orch.win:${Math.random().toString(36).slice(2)}`;
        navigator.locks.request(name, () => new Promise(() => { w.port.postMessage({ t: 'hello', lock: name }); })).catch(() => {});
      }
      return w;
    } catch { return null; }
  })();
  function wantHub() {
    const s = ui.stream;
    try { hub?.port.postMessage({ t: 'want', desks: s?.hub ? (s.desks ?? [[s.channel, s.agent]]) : [] }); } catch { /* the worker is gone; the poll carries on */ }
  }
  if (hub) {
    setInterval(wantHub, WANT_EVERY_MS);
    window.addEventListener('pagehide', () => { try { hub.port.postMessage({ t: 'bye' }); } catch { /* gone */ } });
  }

  /**
   * Server-sent events for the desk whose panel is open: turns as they land,
   * the reply as it streams, prompts as they open and close. The two-second
   * poll keeps running underneath, so if a proxy chokes on the stream the
   * panel is merely slower, never wrong.
   */
  function openStream(channel, agent) {
    closeStream();
    const onEvent = (c, a, ev) => {
      if (c !== channel || a !== agent) return;
      if (!ui.open || ui.open.channel !== channel || ui.open.agent !== agent) return;
      streamEvent(channel, agent, ev);
    };
    if (hub && !hubFailed) {
      ui.stream = { hub: true, channel, agent, onEvent, close() { ui.stream = null; wantHub(); } };
      wantHub();
      return;
    }
    if (typeof EventSource === 'undefined') return;
    const desks = encodeURIComponent(JSON.stringify([[channel, agent]]));
    const es = new EventSource(`./api/floor/stream?desks=${desks}`);
    es.onmessage = (m) => {
      let ev;
      try { ev = JSON.parse(m.data); } catch { return; }
      onEvent(ev.channel, ev.agent, ev);
    };
    ui.stream = es;
  }

  function streamEvent(channel, agent, ev) {
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
      // A command's receipt ends its send outright: there is no user turn
      // coming to retire the bubble, and the bubble is not kept — the
      // host's line in the conversation says what was typed and what
      // happened — so the grace clock never runs on it.
      if (ui.delivery?.state === 'done') ui.sending = ui.sending.filter((p) => !squash(ui.delivery.text).includes(squash(p.text)));
      renderPanel();
    } else if (ev.type === 'sessions') {
      // A host listed this desk's conversations: the picker, if open, reads
      // them now rather than at its next second.
      window.sessionsArrived?.();
    } else if (ev.type === 'permission' || ev.type === 'state' || ev.type === 'session' || ev.type === 'compacting') {
      // All change what the desk and the queue say; the cheapest correct
      // thing is to fetch the floor again rather than mirror the logic here.
      tick();
    }
  }

  function closeStream() {
    if (ui.stream) { try { ui.stream.close(); } catch { /* already closed */ } }
    ui.stream = null;
    ui.partial = '';
  }

  /* ---------- render ---------- */

  function render() {
    // A meeting room is its desks' chat: no rooms either (issue #44).
    if (ui.meeting) {
      renderDetails();
      renderMeeting();
      return;
    }
    // A popout is one desk and its chat: no rooms, no picker, no totals.
    if (ui.popout) {
      renderDetails();
      renderPanel();
      return;
    }
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
    // A floor this browser remembers standing on that has since been put away
    // lands the page on all floors — a put-away floor is not somewhere to stand.
    const names = here.map((c) => c.channel);
    if (ui.floorFilter && !names.includes(ui.floorFilter)) ui.floorFilter = null;
    const pickSig = JSON.stringify([names, ui.floorFilter]);
    if (pickSig !== ui.pickSig) {
      ui.pickSig = pickSig;
      const chip = (n) => `<button class="chip${ui.floorFilter === n ? ' on' : ''}" data-floor="${esc(n)}">${esc(n)}</button>`;
      // A picker with one choice is furniture. A put-away floor is not a choice
      // here at all: it is a pill under the building, and only there.
      $('floor-pick').innerHTML = names.length < 2 ? '' : [
        `<button class="chip${ui.floorFilter ? '' : ' on'}" data-floor="">all floors</button>`,
        ...here.map((c) => chip(c.channel)),
      ].join('');
    }
    // "all floors" means the floors in the building. Named, it is that one.
    const shown = ui.floorFilter ? here.filter((c) => c.channel === ui.floorFilter) : here;

    // Stacked floors are drawn inside a building; one floor on its own is just
    // that floor. The class carries the whole difference in the stylesheet.
    rooms.classList.toggle('building', inBuilding());

    // Selection is drawn from `ui`, so it is part of what the rooms depict:
    // a check, or a nudge moving from in line to nudged, rebuilds them like
    // any other change, and the focused control comes back focused (below).
    // Selecting with nothing checked is `[]`, not selecting is null. Both used
    // to be `[]` beside a kept result, so the toggle drew nothing either way.
    // The Meeting room control (issue #44) also reads which desks are out
    // in a window, and what its last click came to.
    const outNow = [...outsNow(ui.outs, Date.now())];
    const sel = shown.filter((c) => ui.select.has(c.channel) || ui.bulk.has(c.channel))
      .map((c) => [c.channel, ui.select.has(c.channel) ? [...ui.select.get(c.channel)] : null, ui.bulk.get(c.channel) ?? null,
        meetSelNote.get(c.channel) ?? null, outNow.filter((k) => k.startsWith(`${c.channel}|`))]);
    const sig = JSON.stringify([ui.floorFilter, shown, sel]);
    if (sig !== ui.roomsSig) {
      ui.roomsSig = sig;
      // Keyboard focus on a bulk control survives the rebuild. Space on a
      // checkbox changes what the room draws, so without this the next Space
      // landed on nothing.
      const fk = document.activeElement?.closest?.('#floor-rooms [data-fk]')?.dataset.fk ?? null;
      if (!shown.length) {
        // Two different empties. "Nothing here yet" is wrong when there are
        // rooms and every one of them has been put away — that sends someone
        // looking for a bug in the hook plugin over a decision they made
        // themselves. It says where the rooms went and how they come back.
        rooms.innerHTML = away.length
          ? `<div class="q-empty">Every floor is put away — ${away.length} archived, in the pills below. Nothing is deleted: click a pill to bring one back.</div>`
          : '<div class="q-empty">No desks yet. An agent gets a seat the moment it appears on the board or its window posts a hook event.</div>';
      } else {
        rooms.replaceChildren(...shown.map(room));
        if (fk) [...rooms.querySelectorAll('[data-fk]')].find((n) => n.dataset.fk === fk)?.focus();
      }
    }
    // The floors put away, under "all floors" and only there: a pill each, the
    // same pill the board draws, and clicking it restores. Redrawn only when
    // the list changes, for the same reason the rooms are.
    const awaySig = ui.floorFilter ? '' : JSON.stringify(away.map((c) => [c.channel, window.pillFacts?.(c) ?? null]));
    if (awaySig !== ui.awaySig) {
      ui.awaySig = awaySig;
      $('floor-away').innerHTML = ui.floorFilter ? '' : (window.pillBar?.(floor.channels) ?? '');
    }
    // How large a desk is drawn here, for the popouts to match.
    recordDeskScale();
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

  /* One poll at a time (task 264). The interval used to start a new one every
     2 s whatever the last was doing, so a board that answered late collected
     a stack of them, each waiting behind the first — measured: with one
     /api/floor held, the next went out 22 s later (Chrome's lock on a second
     identical GET fits that; the gap is what was measured, not the lock). A
     tick asked for while one runs is not dropped: it runs once more straight
     after, and a caller that awaits it gets that later poll — two do. */
  let pollRun = null;
  function tick() {
    if (!ui.on) return Promise.resolve();
    if (pollRun) { ui.pollAgain = true; return pollRun; }
    pollRun = (async () => {
      try {
        do { ui.pollAgain = false; await pollOnce(); } while (ui.pollAgain && ui.on);
      } finally { pollRun = null; }
    })();
    return pollRun;
  }

  async function pollOnce() {
    try {
      const r = await fetch('./api/floor', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
      if (r.ok) { floor = await r.json(); floorRead = true; }
    } catch { /* the board's own dot already reports the connection */ }
    // What happened to bulk nudges still in line, against the payload just read.
    if (ui.bulk.size) await followBulk();

    // What became of a popout's desk: followed to another floor, or held
    // and then said to have left or gone (issue #19).
    if (ui.popout && !ui.ended) readFate();
    // A meeting room's desks: what became of each, their turns, the room's messages.
    if (ui.meeting) await meetingTick();

    // Envelopes come from the activity feed, which is the same source the log
    // panel reads — one shared definition of "a message happened". A popout
    // draws no rooms for one to fly across, so it does not ask.
    if (!ui.popout && !ui.meeting) try {
      const r = await fetch('./api/activity?limit=40', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
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
        // Not while a past conversation is being read: the box on screen is
        // the reading view's then, and the live turns are redrawn from zero
        // when the person goes back to them.
        if (!ui.reading) $('p-turns')?.replaceChildren();
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
    // Opening a desk is opening its live conversation: a past one being read
    // here, or on the desk before, is put away.
    stopReading();
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
    // A desk whose chat is in a popout opens on the floor as its header and
    // a way back: nothing to read and nothing to stream (issue #19).
    if (isOut(channel, agent)) { closeStream(); render(); return; }
    loadTurns(true).then(() => {
      render();
      if (ui.open?.channel === channel && ui.open?.agent === agent && !isOut(channel, agent)) openStream(channel, agent);
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ui.details) { ui.details = null; renderDetails(); }
  });

  // The card is positioned against a rectangle captured at click time, so any
  // scroll leaves it pointing at nothing. Closing beats chasing.
  //
  // Not a scroll inside the chat panel: its transcript follows each new turn
  // down, and that moves no desk. In a popout the card sits over that very
  // transcript, and the first turn to arrive closed it under the reader's
  // pointer (issue #19, seen in check-popout.mjs). On the floor the same
  // scroll closed a card on a desk across the room.
  window.addEventListener('scroll', (e) => {
    if (e.target instanceof Element && e.target.closest('#floor-panel')) return;
    if (ui.details) { ui.details = null; renderDetails(); }
    // Same reason: it is placed against a rectangle captured at click time.
    closePromptMenu();
  }, true);

  /**
   * The desk a control acts on: the one named by the box it sits in, or the
   * open desk. A meeting room draws a box per participant (issue #44), each
   * carrying `data-for-channel` / `data-for-agent`; the panel and a popout
   * have one desk, which is ui.open. One handler answers both, so a form,
   * a permission menu or a stop sign is the same code wherever it is drawn.
   */
  function targetOf(node) {
    const box = node?.closest?.('[data-for-agent]');
    return box ? { channel: box.dataset.forChannel, agent: box.dataset.forAgent } : ui.open;
  }

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
        // In a popout the conversation is the one already open under the card.
        if (!ui.popout) openDesk(openBtn.dataset.channel, openBtn.dataset.agent);
        return;
      }
      // "Move to another floor" (#18). The card closes first, as Hide desk's
      // does: the desk it describes is about to leave this floor, and the
      // dialog would otherwise sit over a card for a desk that has gone. A
      // disabled button is read off the button, because a dispatched click
      // reaches this handler whether or not a person could have pressed it.
      const moveBtn = e.target.closest?.('[data-act="move-desk"]');
      if (moveBtn) {
        if (moveBtn.disabled || typeof window.moveDeskDialog !== 'function') return;
        const c = floor.channels.find((x) => x.channel === moveBtn.dataset.channel);
        const d = c?.desks.find((x) => x.agent === moveBtn.dataset.agent);
        ui.details = null;
        renderDetails();
        window.moveDeskDialog(moveBtn.dataset.channel, moveBtn.dataset.agent,
          { persona: d?.persona ?? null, host: d?.hosted?.host ?? null, folder: d?.hosted?.window ?? null });
        return;
      }
      // "Hide desk" (#20). The card closes now rather than on the next poll:
      // it is about to describe a desk that is not drawn, and the click
      // should read as having worked.
      const hideBtn = e.target.closest?.('[data-act="hide-desk"]');
      if (hideBtn && ui.on) {
        ui.details = null;
        renderDetails();
        setDeskHidden(hideBtn.dataset.channel, hideBtn.dataset.agent, true);
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
      applyScroll(svg, c ? deskRows(c).drawn.length : 0);
      return;
    }

    // So does the put-away control, for the same reason: it sits inside the
    // storey, and riding to a floor is not what pressing "put away" asked for.
    const put = e.target.closest?.('svg.room .roomPut');
    if (put && ui.on) {
      window.channelDialog?.(put.dataset.channel);
      return;
    }

    // And a hidden desk's pill, which restores it (#20): inside the storey
    // too, and the one way back for a desk put away by hand.
    const deskPillEl = e.target.closest?.('svg.room .deskPill');
    if (deskPillEl && ui.on) {
      setDeskHidden(deskPillEl.dataset.channel, deskPillEl.dataset.agent, false, deskPillEl);
      return;
    }

    // Bulk selection (issue #23): the room's own control, then everything
    // inside a room that is selecting. Inside the storey, so ahead of the
    // ride, for the reason the arrows are.
    const selCtl = e.target.closest?.('svg.room [data-act="select-room"]');
    if (selCtl && ui.on) {
      toggleSelecting(selCtl.dataset.channel);
      return;
    }
    // While a room is selecting, a click on a desk checks or unchecks it,
    // wherever it lands: the bell, the nameplate, the sign, a pill. Nothing
    // rings, no card or conversation opens, and in the building nothing
    // rides to the floor. A selecting room is being operated on, and one
    // click doing two things there is how a nudge goes out by accident.
    // A click on the carpet or the header does nothing at all.
    const selRoom = e.target.closest?.('svg.room.selecting');
    if (selRoom && ui.on) {
      const ch = selRoom.dataset.channel;
      const ctl = e.target.closest('[data-act^="sel-"]');
      if (ctl?.dataset.act === 'sel-all') { checkAll(ch); return; }
      if (ctl && ['sel-nudge', 'sel-read', 'sel-hide'].includes(ctl.dataset.act)) {
        if (ctl.getAttribute('aria-disabled') !== 'true') bulkAct(ch, ctl.dataset.act.slice(4));
        return;
      }
      // A meeting room (issue #44): a window, so opened in this click.
      if (ctl?.dataset.act === 'sel-meeting') {
        if (ctl.getAttribute('aria-disabled') !== 'true') openMeetingRoom(ch);
        return;
      }
      const cell = e.target.closest('.desk');
      if (cell) toggleChecked(ch, cell.dataset.agent);
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
      if (!openPill(channel, agent, which, pill.dataset.kind ?? null)) openDesk(channel, agent);
      return;
    }

    const deskEl = e.target.closest?.('svg.room .desk');
    if (deskEl && ui.on) {
      // A popout's desk is the chat beneath it, already open.
      if (!ui.popout) openDesk(deskEl.dataset.channel, deskEl.dataset.agent);
      return;
    }

    const pick = e.target.closest?.('#floor-pick [data-floor]');
    if (pick && ui.on) {
      setFloor(pick.dataset.floor || null);
      return;
    }

    const act = e.target.closest?.('[data-act]');
    if (!act || !ui.on) return;

    if (act.dataset.act === 'unarchive') {
      // A pill restores — the board's own restore, then this view's next poll
      // at once, so the room is back before the interval would have asked.
      Promise.resolve(window.restoreChannel?.(act.dataset.channel)).then(() => tick());
    } else if (act.dataset.act === 'open') {
      openDesk(act.dataset.channel, act.dataset.agent);
    } else if (act.dataset.act === 'close-panel') {
      ui.open = null;
      render();
    } else if (act.dataset.act === 'detach') {
      detach(act.dataset.channel, act.dataset.agent, act);
    } else if (act.dataset.act === 'bring-back') {
      bringBack(act.dataset.channel, act.dataset.agent);
    } else if (act.dataset.act === 'reattach') {
      endPopout(true);
    } else if (act.dataset.act === 'close-window') {
      window.close();
    } else if (act.dataset.act === 'm-end') {
      endMeeting();
    } else if (act.dataset.act === 'm-pill') {
      const to = targetOf(act);
      if (to) openPill(to.channel, to.agent, act.dataset.which, act.dataset.kind || null);
    } else if (act.dataset.act === 'm-nudge') {
      // The floor's bell, for one participant. A refusal is said in the
      // room: there is no drawn bell here to show it on.
      const to = targetOf(act);
      if (!to || act.disabled) return;
      act.disabled = true;
      const why = await strike(to.channel, to.agent);
      if (why) meetingNote(`${meetPersona(to.agent)} was not nudged: ${why}`, 'bad');
      render();
    } else if (act.dataset.act === 'm-nudge-all') {
      if (!act.disabled) await sendMeeting(NUDGE_WORD, { nudge: true });
    } else if (act.dataset.act === 'm-remove') {
      const to = targetOf(act);
      if (to) meetingRemove(to.agent, `${meetPersona(to.agent)} went back to the floor.`);
    } else if (act.dataset.act === 'm-to-all') {
      if (ui.meeting) { ui.meeting.to = null; render(); }
    } else if (act.dataset.act === 'm-to') {
      // Who hears the next message: each desk a toggle, everyone to start.
      const m = ui.meeting;
      if (m) {
        const now = new Set(meetingTo(m.parts.map((p) => p.agent), m.to));
        if (now.has(act.dataset.agent)) now.delete(act.dataset.agent); else now.add(act.dataset.agent);
        m.to = now.size === m.parts.length ? null : now;
        render();
      }
    } else if (act.dataset.act === 'read-back') {
      stopReading();
      ui.stick = true;
      renderPanel();
    } else if (act.dataset.act === 'meetings') {
      // app.js owns the dialogs on this page; Resume comes back here through
      // window.floorResumeMeeting.
      window.meetingsDialog?.();
    } else if (act.dataset.act === 'history') {
      // app.js owns the dialogs on this page; a row in it comes back here
      // through window.floorRead.
      window.historyDialog?.();
    } else if (act.dataset.act === 'send') {
      await sendChat();
    } else if (act.dataset.act === 'ask-tab') {
      askShow(act.closest('.p-ask'), act.dataset.q);
    } else if (act.dataset.act === 'ask-submit') {
      const form = act.closest('.p-ask');
      const answers = askAnswers(form);
      // A form with a question unanswered is never sent: Submit shows the
      // first one instead. The server refuses the same form by the same rule
      // (`unansweredOf`), so this is the short way round, not the gate.
      const open = askUnanswered(askShape(form), answers);
      if (open.length) {
        askShow(form, open[0]);
        askWarn(form);
        flash(act, 'this one has no answer yet');
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
      const to = targetOf(act);
      if (!to) return;
      for (const b of form.querySelectorAll('button')) b.disabled = true;
      try {
        const r = await fetch('./api/floor/answer', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ channel: to.channel, agent: to.agent, request_id: form.dataset.request, answers }),
        });
        if (r.ok) {
          // The count as it stands now, because what retires the spinner is this
          // desk gaining a turn — the window having taken the answers and moved
          // on. Captured here rather than in renderPanel so a poll landing
          // between the click and the first draw cannot settle it early.
          const now = floor?.channels?.find((c) => c.channel === to.channel)
            ?.desks?.find((x) => x.agent === to.agent);
          ui.answering = { channel: to.channel, agent: to.agent, request_id: form.dataset.request, since: Date.now(), turns: now?.turns ?? 0 };
          render();
        } else {
          const body = await r.json().catch(() => ({}));
          flash(act, String(body.error ?? `that didn't send (${r.status})`).slice(0, 60));
          for (const b of form.querySelectorAll('button')) b.disabled = false;
          // The board found a question unanswered that this page did not —
          // a page older than the server, say. It names which; show it.
          if (body.code === 'unanswered' && Number.isInteger(body.question)) askShow(form, body.question);
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
      const to = targetOf(act);
      if (!to) return;
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
          body: JSON.stringify(choice === 'interrupt' ? { channel: to.channel, agent: to.agent } : { channel: to.channel, agent: to.agent, choice }),
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
      // The desk is the one whose box this is (targetOf): the open desk in
      // the panel and a popout, a participant's own box in a meeting room.
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
        await decide(act.dataset.request, act.dataset.choice, why, targetOf(act));
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
      const to = targetOf(act);
      if (to && !act.disabled && typeof window.stopDialog === 'function') {
        // This payload's name for the desk, not the board's — both read the same
        // rows, but the panel is open on a desk this one is guaranteed to hold.
        const open = floor.channels.find((c) => c.channel === to.channel)
          ?.desks.find((x) => x.agent === to.agent);
        window.stopDialog(to.channel, to.agent, open?.persona ?? to.agent);
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
    } else if (act.dataset.act === 'ask-open') {
      // The same door as "Open in Claude" below the box, offered where the
      // unread question is. One implementation: its spinner and its refusals
      // are the link's.
      await attachTmux('claude', targetOf(act), act);
    } else if (act.dataset.act === 'take-desk') {
      // app.js owns the dialogs on this page. The channel comes from the
      // button when a room's control opened it, else from the floor being
      // looked at, else the dialog asks.
      window.deskDialog?.({ channel: act.dataset.channel ?? (ui.floorFilter || null) });
    } else if (act.dataset.act === 'sessions') {
      if (!ui.open) return;
      const open = floor.channels.find((c) => c.channel === ui.open.channel)
        ?.desks.find((x) => x.agent === ui.open.agent);
      window.sessionDialog?.(ui.open.channel, ui.open.agent, open?.persona ?? ui.open.agent);
    } else if (act.dataset.act === 'leave-desk') {
      if (!ui.open) return;
      const open = floor.channels.find((c) => c.channel === ui.open.channel)
        ?.desks.find((x) => x.agent === ui.open.agent);
      window.leaveDeskDialog?.(ui.open.channel, ui.open.agent, open?.persona ?? ui.open.agent, open?.hosted?.scope ?? null);
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


  /**
   * A desk's pill, pressed: its backlog (Mark all read, read to here,
   * reassign, Nudge agent) or its tasks, in app.js's own dialogs. One
   * function for the floor's pills and a meeting room's (issue #44), so a
   * pill means one thing wherever it is clicked. The third argument tells
   * the task dialog which pill was pressed, so it shows claims or
   * assignments rather than both under one heading. The backlog dialog is
   * told the newest message this pill was drawn from, so a board copy older
   * than the pill is read again before it opens (issue #23 Decided 5,
   * backlogBehind in app.js). False when the board half is not loaded.
   */
  function openPill(channel, agent, which, kind = null) {
    const dlg = which === 'unread' ? window.backlogDialog : window.taskDialog;
    if (typeof dlg !== 'function') return false;
    if (which === 'unread') dlg(channel, agent, roomOf(channel)?.desks.find((x) => x.agent === agent)?.board?.unread_max_id ?? null);
    else dlg(channel, agent, kind);
    return true;
  }

  /** A short note on the send button, then back to normal. */
  /**
   * Put a desk away by hand, or bring it back (#20): the server's flag, by
   * the board's admin route, then this view's next poll at once so the storey
   * redraws before the interval would have asked. Two callers — the card's
   * "Hide desk" and the pill — and no third: the auto-hide of an empty desk
   * is a drawing decision (deskRows) and writes nothing anywhere.
   *
   * A refusal is said on the pill, where the click was; the card has already
   * closed by the time a hide could fail, and the next poll draws the desk
   * back, which is the truth of what happened.
   */
  async function setDeskHidden(channel, agent, hidden, at = null) {
    try {
      const r = await fetch(`./api/admin/desk/${hidden ? 'hide' : 'show'}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel, agent }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
    } catch (err) {
      const t = at?.querySelector?.('title');
      if (t) t.textContent = `could not ${hidden ? 'hide' : 'restore'} ${agent}: ${err.message ?? err}`;
    }
    tick();
  }

  /* ---------- bulk selection: the actions ---------- */

  const roomOf = (channel) => floor.channels.find((x) => x.channel === channel) ?? null;
  const checkedHere = (channel) => {
    const c = roomOf(channel);
    return c ? checkedDesks(deskRows(c).drawn, ui.select.get(channel)) : [];
  };
  const post = async (path, body) => {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const got = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(got.error ?? `HTTP ${r.status}`);
    return got;
  };

  /** A room's results are kept while it selects, and while a nudge from it is still in line. */
  function pruneBulk(channel) {
    const b = ui.bulk.get(channel);
    if (!b || ui.select.has(channel)) return;
    if (!b.nudge?.entries.some((e) => e.state === 'line')) ui.bulk.delete(channel);
  }

  function toggleSelecting(channel) {
    if (ui.select.has(channel)) ui.select.delete(channel);
    else {
      ui.select.set(channel, new Set());
      // The card describes one desk, and the room is about to be about many.
      ui.details = null;
      renderDetails();
    }
    pruneBulk(channel);
    render();
  }

  function toggleChecked(channel, agent) {
    const set = ui.select.get(channel);
    if (!set) return;
    if (set.has(agent)) set.delete(agent); else set.add(agent);
    render();
  }

  /** Check every desk drawn in the room, or, when they all are, uncheck them. */
  function checkAll(channel) {
    const set = ui.select.get(channel);
    const c = roomOf(channel);
    if (!set || !c) return;
    const drawn = deskRows(c).drawn;
    if (drawn.length && drawn.every((d) => set.has(d.agent))) set.clear();
    else for (const d of drawn) set.add(d.agent);
    render();
  }

  /** When each entry first stood at the front of its host's line: where its silence clock may start (bulkWait). */
  function stampFronts(rec) {
    const now = Date.now();
    for (const e of rec.entries) if (e.state === 'line' && e.front == null && !aheadOf(rec.entries, e.agent)) e.front = now;
  }

  /**
   * One of the three, on the checked desks. Each desk gets the request its
   * one-desk control sends today: the chat route the bell posts to, the
   * advance the backlog dialog's Mark all read (operator) posts, the hide
   * the card's Hide desk posts. So each desk gets the same audit row,
   * written by `operator` (src/web.js, src/floor.js). One desk's refusal is
   * that desk's: it is recorded against it, shown on it, and the next desk
   * is sent its own.
   *
   * The mode stays on afterwards, with the same desks checked (the issue's
   * Not established line, the developer's call). The results are drawn on
   * the checked desks, which would go with the mode. The actions also
   * chain: mark a backlog read, then nudge the same desks to look again.
   * The one guard is a second Nudge while the first is still in line, which
   * would queue every desk twice.
   */
  async function bulkAct(channel, kind) {
    if (!ui.select.has(channel)) return;
    const desks = checkedHere(channel);
    const b = ui.bulk.get(channel) ?? {};
    ui.bulk.set(channel, b);

    if (kind === 'nudge') {
      const plan = nudgePlan(desks);
      if (!plan.send.length || b.nudge?.entries.some((e) => e.state === 'line')) return;
      const rec = {
        kind: 'nudge', at: Date.now(),
        entries: [
          ...plan.send.map((e) => ({ ...e, state: 'line' })),
          ...plan.blocked.map((e) => ({ agent: e.agent, persona: e.persona, host: null, state: 'refused', words: e.reason })),
        ],
      };
      b.nudge = rec;
      render();
      // In plan order, one after another: the host's line is the order the
      // board took them in, and the plan's order is the measured one.
      for (const e of rec.entries.filter((x) => x.state === 'line')) {
        try {
          await post('./api/floor/chat', { channel, agent: e.agent, text: NUDGE_WORD });
          nudged(channel, e.agent, NUDGE_WORD, true);
        } catch (err) {
          // Refused by the board, in its words (deliverable(), src/floor.js),
          // or not answered at all. Either way this desk was not nudged and
          // the rest still are.
          e.state = 'refused';
          e.words = String(err.message ?? err);
        }
      }
      stampFronts(rec);
      render();
      tick();
      return;
    }

    if (kind === 'read') {
      const plan = readPlan(desks);
      if (!plan.total) return;
      const rec = { kind: 'read', at: Date.now(), entries: plan.rows.map((r) => ({ ...r, state: 'sending' })) };
      b.read = rec;
      render();
      for (const e of rec.entries) {
        try {
          const got = await post('./api/admin/agent/advance', { channel, agent: e.agent, up_to_id: e.upTo });
          e.state = 'done';
          e.cleared = got.cleared ?? e.count;
        } catch (err) {
          e.state = 'failed';
          e.words = String(err.message ?? err);
        }
      }
      render();
      tick();
      return;
    }

    if (kind === 'hide') {
      if (!desks.length) return;
      const rec = { kind: 'hide', at: Date.now(), entries: desks.map((d) => ({ agent: d.agent, persona: d.persona, state: 'sending' })) };
      b.hide = rec;
      render();
      const set = ui.select.get(channel);
      for (const e of rec.entries) {
        try {
          await post('./api/admin/desk/hide', { channel, agent: e.agent });
          e.state = 'done';
          // A hidden desk is a pill, and its check goes with it. Restored
          // from the pill later, it comes back unchecked, not still lined up
          // for whatever this room does next.
          set?.delete(e.agent);
        } catch (err) {
          e.state = 'failed';
          e.words = String(err.message ?? err);
        }
      }
      render();
      tick();
    }
  }

  /**
   * Each poll, what happened to the nudges still in line: the word on the
   * desk as a turn, an error turn instead, or the window's own note that it
   * holds the word behind a running turn. These are facts, read where they
   * are written, and nothing here goes on a clock (task 267 step 1: a desk
   * can wait 45 s in a line with nothing wrong).
   */
  async function followBulk() {
    for (const [ch, b] of ui.bulk) {
      const rec = b.nudge;
      const c = roomOf(ch);
      const line = rec?.entries.filter((e) => e.state === 'line') ?? [];
      await Promise.all(line.map(async (e) => {
        const d = c?.desks.find((x) => x.agent === e.agent);
        if (e.opens && e.readyAt == null && d?.nudge?.ok && !d.nudge.opens) e.readyAt = Date.now();
        if (d?.delivery && d.delivery.state !== 'done' && bulkSquash(d.delivery.text).includes(NUDGE_WORD)) {
          e.state = 'sent';
          return;
        }
        try {
          const r = await fetch(`./api/floor/turns?channel=${encodeURIComponent(ch)}&agent=${encodeURIComponent(e.agent)}&since=${e.base}&limit=500`,
            { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
          if (!r.ok) return;
          const got = nudgeOutcome((await r.json()).rows, NUDGE_WORD);
          if (got) Object.assign(e, got);
        } catch { /* the next poll asks again */ }
      }));
      if (rec) stampFronts(rec);
      pruneBulk(ch);
    }
  }

  /** The open desk's bulk nudge, if it has one in line: what its pending bubble says (bulkWait). */
  function bulkWaitFor(channel, agent) {
    const rec = ui.bulk.get(channel)?.nudge;
    if (!rec) return null;
    const d = roomOf(channel)?.desks.find((x) => x.agent === agent);
    return bulkWait(rec.entries, agent, !!d?.nudge?.opens);
  }

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
  /** Land on a desk: the floor it is on, and its panel. Called by app.js
   *  after "Take desk", so the operator watches the desk come up — not
   *  hosted, then hosted, then its window's first question — rather than
   *  hunting for it. */
  /**
   * The picker queued a reopen: spin the link until the desk's conversation
   * is the chosen one. `from` is the id it is leaving, which is how a new
   * conversation — no id until its window registers — is told from the old.
   */
  window.floorReopen = (channel, agent, sessionId, from) => {
    ui.reopening = { channel, agent, sessionId: sessionId ?? null, from: from ?? null, since: Date.now() };
    renderPanel();
    tick();
  };

  // `follow`: go to the desk's floor whatever is being shown, all floors
  // included — the card's move (#18 Decided 3), which is the operator
  // sending an agent somewhere and going with it. The payload is fetched
  // first because the floor may be one this page has not seen yet (a new
  // one by name), and a floor filter naming a floor the payload lacks is
  // dropped back to all floors by render(). Take a desk's call is as it was:
  // from all floors it opens the panel and leaves the view where it is.
  window.floorOpenDesk = async (channel, agent, { follow = false } = {}) => {
    // A popout has one desk. A move made from its own card lands here once
    // the desk is seated on the new floor; the popout goes with it (#19).
    if (ui.popout) {
      if (agent === ui.popout.agent && channel !== ui.popout.channel) followTo(channel);
      return;
    }
    if (follow) {
      await tick();
      if (ui.floorFilter !== channel) setFloor(channel);
    } else if (ui.floorFilter && ui.floorFilter !== channel) setFloor(channel);
    openDesk(channel, agent);
  };
  /**
   * Open one of a desk's conversations to read, in that desk's panel — from
   * the History dialog. The desk's panel is opened if it is not already (its
   * live conversation loads underneath, as it would), and the reading view
   * goes over it. `find` is what a search was for: the turns that contain it
   * are marked, and the view opens on the first of them.
   */
  window.floorRead = (channel, agent, sessionId, title, { find = null } = {}) => {
    // A desk that is out reads in its popout, which is its panel now (#19).
    // A desk in a meeting room reads here: the room has no reading view.
    if (isOut(channel, agent) && !outMeeting(channel, agent)) {
      say({ t: 'read', channel, agent, sessionId, title: title ?? null, find });
      focusPopout(channel, agent);
      return;
    }
    if (ui.floorFilter && ui.floorFilter !== channel) setFloor(channel);
    if (!ui.open || ui.open.channel !== channel || ui.open.agent !== agent) openDesk(channel, agent);
    else stopReading();
    ui.reading = {
      channel, agent, sessionId, title: title ?? null,
      find: typeof find === 'string' && find.trim() ? find.trim().toLowerCase() : null,
      rows: [], done: false, error: null, heard: false, drawn: 0, settled: false,
    };
    renderPanel();
    readWhole(ui.reading);
  };
  // `bulk` marks a nudge sent from a selecting room, whose pending bubble
  // waits on the line in front of it rather than on the clock alone — see
  // bulkWait.
  function nudged(channel, agent, text, bulk = false, tell = true) {
    // Whichever surface sent it, the desk rings. The board's dialog has already
    // had its "ok" from the same endpoint strike() posts to, so the evidence
    // the ring stands for is the same evidence either way.
    ring(channel, agent);
    // Issue #19. A desk that is out has its chat in its popout, so the
    // pending bubble is drawn there — with this room's record of a bulk
    // nudge's line, which the bubble waits on. A popout's own nudge rings
    // the desk on the floor too: one desk, one ring, wherever it was struck.
    const out = isOut(channel, agent);
    if (out) say({ t: 'nudged', channel, agent, text, bulk, rec: bulk ? ui.bulk.get(channel)?.nudge ?? null : null });
    else if ((ui.popout || ui.meeting) && tell) say({ t: 'rang', channel, agent });
    // In a meeting room, a participant's pending line is drawn in the
    // room's transcript (its bell, or Nudge agent in its backlog dialog).
    if (ui.meeting) meetingNudged(agent, text);
    if (!out && ui.open && ui.open.channel === channel && ui.open.agent === agent) {
      ui.sending = ui.sending.concat([{ text, at: Date.now(), ...(bulk ? { bulk: true } : {}) }]);
      ui.stick = true;
      renderPanel();
    }
    // Even with no panel open on that desk, its sign is about to change.
    tick();
  }
  window.floorNudged = (channel, agent, text) => nudged(channel, agent, text);

  /**
   * Send: a user turn in the hosted session. The server refuses, with the
   * reason, if nothing is there to receive it — and the reason is shown, not a
   * generic failure, because "the host is offline" is something the person can
   * act on and "failed" is not.
   */
  async function sendChat(given = null) {
    // A meeting room's composer is #p-text too, so Enter and the saved
    // prompts are this file's; what Send does there is the room's.
    if (ui.meeting) return sendMeeting(given);
    const text = typeof given === 'string' ? given : ($('p-text')?.value ?? '');
    const btn = document.querySelector('#floor-panel [data-act="send"]');
    if (!text.trim() || !btn || !ui.open || btn.disabled) return;
    const fromBox = typeof given !== 'string';
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
      if (fromBox) {
        $('p-text').value = '';
        stashDraft();   // handed over: no longer a draft
        drawSlash();
      }
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

  async function decide(requestId, decision, reason = null, to = ui.open) {
    if (!to || !requestId) return;
    const r = await fetch('./api/floor/permission', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: to.channel, agent: to.agent, request_id: requestId, decision,
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
  async function attachTmux(act = 'attach', to = ui.open, clicked = null) {
    if (!to) return;
    const { channel, agent } = to;
    // The link under the box, or — from a box with no links under it, a
    // participant's in a meeting room — the button that was pressed.
    const btn = (to === ui.open ? $('floor-panel').querySelector(`[data-act="${act}"]`) : null) ?? clicked;
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
        // From a box with no seat links under it (a meeting room's), the
        // flash is the only place the refusal can be read.
        if (to !== ui.open) flash(btn, String(body.error ?? 'could not open a terminal').slice(0, 60));
      } else if (to !== ui.open) {
        // Nothing here settles a spinner for a desk that is not the open
        // one (renderPanel watches the open desk's `clients`), so the click
        // is answered by what is known: the host was asked.
        ui.attaching = null;
        flash(btn, 'terminal asked for');
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
    const other = q.querySelector('input[data-other="1"]');
    const field = q.querySelector('.p-other');
    if (field) {
      field.disabled = !other?.checked;
      if (!field.disabled) field.focus();
      else field.value = '';
    }
    // After the field, not before: whether a free-text choice counts as an
    // answer depends on what is typed in it.
    askWarn(box.closest('.p-ask'));
  });

  // Every keystroke into the box is filed under its desk as it happens, so no
  // moment — a click on another desk, a reload, a closed tab — can be the one
  // that loses it. See the drafts note above stashDraft.
  /** The slash menu, drawn from what the box holds right now. */
  function drawSlash() {
    const box = $('p-text');
    const menu = document.querySelector('#floor-panel .p-slash');
    if (!box || !menu) return;
    const matches = slashMatches(box.value);
    menu.classList.toggle('hidden', !matches.length);
    menu.innerHTML = matches.map((c, i) => `<button type="button" class="p-slash-row${i === 0 ? ' is-first' : ''}" role="option" data-slash="${esc(c.name)}">` +
      `<span class="mono">/${esc(c.name)}${c.args ? ` <i>${esc(c.args)}</i>` : ''}</span><span class="muted">${esc(c.hint)}</span></button>`).join('');
  }
  /** Put a command in the box: `/name ` for one that takes an argument, `/name` for one that does not. */
  function takeSlash(name) {
    const box = $('p-text');
    const c = FLOOR_COMMANDS.find((x) => x.name === name);
    if (!box || !c) return;
    box.value = `/${c.name}${c.args ? ' ' : ''}`;
    stashDraft();
    drawSlash();
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }
  document.addEventListener('click', (e) => {
    const row = e.target?.closest?.('.p-slash-row');
    if (row) { e.preventDefault(); takeSlash(row.dataset.slash); }
  });
  document.addEventListener('change', (e) => {
    const act = e.target?.dataset?.act;
    if (act === 'm-add' && ui.meeting && e.target.value) {
      const agent = e.target.value;
      e.target.value = '';
      meetingJoin(agent).then((ok) => { if (ok) { meetingSave(); openMeetingStream(); } render(); tick(); });
      return;
    }
    if (act !== 'set-model' && act !== 'set-effort') return;
    const v = e.target.value;
    if (!v) return;
    sendChat(act === 'set-model' ? `/model ${v}` : `/effort ${v}`);
  });

  document.addEventListener('input', (e) => {
    if (e.target?.id === 'p-text') { stashDraft(); drawSlash(); }
    // Typing into a free-text choice is what turns it into an answer, so the
    // count under the form follows the words.
    const form = e.target?.classList?.contains('p-other') ? e.target.closest('.p-ask') : null;
    if (form) askWarn(form);
  });

  document.addEventListener('keydown', (e) => {
    if (!ui.on) return;
    // Tab completes the first command the box is the start of.
    if (e.target?.id === 'p-text' && e.key === 'Tab' && !e.shiftKey) {
      const first = slashMatches(e.target.value)[0];
      if (first) { e.preventDefault(); takeSlash(first.name); return; }
    }
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
    // A popout is its desk's chat; there is no panel in it to close.
    if (e.key === 'Escape' && ui.open && !ui.popout) {
      ui.open = null;
      render();
    }
    if (e.key !== 'Enter' && e.key !== ' ') return;

    // Keyboard has to mean what the pointer means, or the two surfaces teach
    // different things about what a desk is.
    // Bulk selection's controls, and a desk in a selecting room, which the
    // pointer checks rather than opens.
    const selEl = document.activeElement?.closest?.('svg.room [data-act="select-room"], svg.room.selecting [data-act^="sel-"], svg.room.selecting .desk');
    if (selEl) {
      e.preventDefault();
      selEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return;
    }
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
    const deskPillEl = document.activeElement?.closest?.('svg.room .deskPill');
    if (deskPillEl) {
      e.preventDefault();
      deskPillEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return;
    }
    const deskEl = document.activeElement?.closest?.('svg.room .desk');
    if (!deskEl) return;
    e.preventDefault();
    if (deskEl.closest('svg.room.collapsed')) setFloor(deskEl.closest('svg.room').dataset.channel);
    else if (!ui.popout) openDesk(deskEl.dataset.channel, deskEl.dataset.agent);
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

  ui.popout = popoutOf(location.search);
  const meetingSpec = meetingOf(location.search);
  if (meetingSpec) {
    // A meeting room's window (issue #44): the floor's view, like a
    // popout, and none of the floor tab's remembered choices.
    ui.popout = null;
    document.body.classList.add('popout', 'meeting', 'view-floor');
    document.title = 'Meeting room';
    ui.on = true;
    start();
    startMeeting(meetingSpec);
    if (!LOCKS) setInterval(() => meetingAnnounce(), POP_BEAT_MS);
    // Closing the window ends the meeting (the issue's 7), and so does a
    // reload, which then opens the room again from its address.
    window.addEventListener('pagehide', () => endMeeting({ closing: true }));
  } else if (ui.popout) {
    // A desk's popout (issue #19): the floor's view, always, and none of the
    // floor's remembered choices — a popout writes neither the view nor the
    // floor this browser stands on, which belong to the floor tab.
    document.body.classList.add('popout', 'view-floor');
    document.title = `${ui.popout.agent} · ${ui.popout.channel}`;
    ui.on = true;
    openDesk(ui.popout.channel, ui.popout.agent);
    start();
    // The lock is what keeps this desk out on the floor. The beat is for a
    // browser with no Web Locks only; with them, nothing here runs on a
    // timer that a hidden window would have throttled.
    holdPresence();
    if (!LOCKS) setInterval(announce, POP_BEAT_MS);
    // Closed, or reloaded: either way the draft is filed under the desk and
    // the floor is told. A floor waits REJOIN_MS before taking the chat
    // back, so a reload that says `here` again is not a re-attach.
    window.addEventListener('pagehide', () => {
      if (ui.ended || !ui.popout) return;
      stashDraft();
      say({ t: 'gone', channel: ui.popout.channel, agent: ui.popout.agent, id: POP_ID, open: !fateShown() });
    });
  } else {
    try { ui.floorFilter = localStorage.getItem('orch.floor') || null; } catch { /* default: all floors */ }
    /* First visit lands on the floor, all floors — the less technical face of the
       board. A stored choice (either one) always wins; only the absence of a
       choice defaults here. */
    let initial = 'floor';
    try { initial = (localStorage.getItem('orch.view') ?? 'floor') === 'floor' ? 'floor' : 'board'; } catch { /* default */ }
    setView(initial);
    // Which desks are out, from the popouts themselves: a reloaded floor
    // knows within a moment, without any of them having to be reopened.
    say({ t: 'who' });
  }
})();
