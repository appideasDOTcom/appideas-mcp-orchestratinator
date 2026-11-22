// What a stand-in host has to say to be let in.
//
// Since 0.12.5 the board refuses a registration that does not carry its
// protocol number, a missing one included (protocolRefusal in src/floor.js;
// CLAUDE.md, "The host under the desktop app"). Every script here that plays
// a host by hand sends this with its registration:
//
//   import { boardProtocol } from './board-protocol.mjs';
//   … body: JSON.stringify({ host_id, name, protocol: await boardProtocol(base), … })
//
// It is read off the board the script is pointed at, not off a package.json,
// because a check is also run against a copy holding another commit's src/:
// a board from before the number reports none, wants none and gets none
// (undefined is dropped from the JSON).
//
// Six stand-ins sent nothing for two days after the check went in
// (2026-11-07 → 11-08): the ones behind the update, backdrop, popout, redraw
// and meeting checks and the README shots. check-update.mjs was run in that
// state and read 15 of 19, "got []" and "waitFor timed out", over a 409
// that nothing printed; with the number it reads 42 of 42. A new stand-in
// that registers takes this line, and prints what its registration answers.
const seen = new Map();
export async function boardProtocol(base) {
  if (seen.has(base)) return seen.get(base);
  try {
    const p = (await (await fetch(`${base}/health`)).json()).protocol ?? undefined;
    seen.set(base, p);        // only an answer is kept: a board not up yet is asked again
    return p;
  } catch { return undefined; }
}
