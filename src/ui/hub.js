/* The one event stream every window of the floor shares (issue #19).
 *
 * A SharedWorker: one instance per origin, alive while any window of the board
 * is open — the floor tab, a popout, or both — and gone with the last of them.
 *
 * Why it exists. The board is served over HTTP/1.1, and a browser holds at most
 * six connections to one host, shared by every window it has open. An event
 * stream holds one for as long as it is open. Measured in the issue: at six open
 * streams the next fetch had no answer within four seconds, so the floor plus
 * five popouts each streaming its own desk would hang every poll in every window
 * until POLL_TIMEOUT_MS gave up on it. So no window opens a stream of its own.
 * Each tells this worker which desk it is showing, and the worker holds one
 * stream for the union (`/api/floor/stream?desks=…`) and hands each window the
 * events for its desk. However many windows are open, the board sees one
 * connection.
 *
 * The protocol, window → worker:
 *   { t: 'want', desks: [[channel, agent], …] }   what this window shows, all of
 *       it; sent on every change and again every WANT_EVERY_MS as its heartbeat
 *   { t: 'bye' }                                  this window is going
 * worker → window:
 *   { t: 'ev', channel, agent, ev }               one event for one of its desks
 *
 * A window that closes without saying bye (a crash, a killed renderer) is
 * dropped once it has been silent for PORT_TTL_MS. A window whose timers are
 * throttled (a hidden tab) can be dropped too, and is back on its next want —
 * its poll covers the gap, as it covers any gap in a stream.
 */

const PORT_TTL_MS = 30_000;
const SWEEP_MS = 5_000;
/* A change of desks reopens the stream. Several windows changing in one breath
   (a floor reloading, its popouts answering) is one reopen, not several. */
const SETTLE_MS = 60;

const ports = new Map();      // port → { desks: Map<key, [channel, agent]>, at }
// The streams open now, oldest first. The last is the current one; any before
// it are on their way out, closed the moment a newer one is answering.
const streams = [];
let settling = null;

const keyOf = (c, a) => `${c}|${a}`;

function union() {
  const all = new Map();
  for (const p of ports.values()) for (const [k, pair] of p.desks) all.set(k, pair);
  return [...all.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
}

function deliver(m) {
  let ev;
  try { ev = JSON.parse(m.data); } catch { return; }
  const k = keyOf(ev.channel, ev.agent);
  for (const [port, p] of ports) {
    if (p.desks.has(k)) {
      try { port.postMessage({ t: 'ev', channel: ev.channel, agent: ev.agent, ev }); } catch { /* gone */ }
    }
  }
}

/* Open the stream for what is wanted now. The new one is opened before the old
   is closed, and the old goes once the new is answering, so an event published
   in between is on one or the other. Both may carry it for that moment; every
   event a window acts on is safe to see twice (a turn is taken by id, the rest
   say what is true now). */
function reconcile() {
  settling = null;
  const desks = union();
  const key = desks.map(([k]) => k).join('\n');
  if ((streams.at(-1)?.key ?? '') === key) return;
  if (!desks.length) {
    for (const s of streams.splice(0)) s.es.close();
    return;
  }
  const pairs = JSON.stringify(desks.map(([, pair]) => pair));
  const es = new EventSource(`./api/floor/stream?desks=${encodeURIComponent(pairs)}`);
  const entry = { es, key };
  streams.push(entry);
  es.onopen = () => {
    const at = streams.indexOf(entry);
    if (at > 0) for (const s of streams.splice(0, at)) s.es.close();
  };
  es.onmessage = deliver;
}

const soon = () => { if (!settling) settling = setTimeout(reconcile, SETTLE_MS); };

onconnect = (e) => {
  const port = e.ports[0];
  ports.set(port, { desks: new Map(), at: Date.now() });
  port.onmessage = (m) => {
    const msg = m.data ?? {};
    if (msg.t === 'bye') { ports.delete(port); soon(); return; }
    if (msg.t !== 'want') return;
    const desks = new Map();
    for (const pair of Array.isArray(msg.desks) ? msg.desks : []) {
      if (Array.isArray(pair) && pair[0] && pair[1]) desks.set(keyOf(pair[0], pair[1]), [String(pair[0]), String(pair[1])]);
    }
    ports.set(port, { desks, at: Date.now() });
    soon();
  };
  port.start();
};

setInterval(() => {
  const now = Date.now();
  let dropped = false;
  for (const [port, p] of ports) if (now - p.at > PORT_TTL_MS) { ports.delete(port); dropped = true; }
  if (dropped) soon();
}, SWEEP_MS);
