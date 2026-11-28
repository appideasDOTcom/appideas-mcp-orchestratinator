/**
 * An agent handing a file to another agent (contract board.files, M3;
 * costmo's decision 21). The MCP tool (src/tools.js, send_file) and the
 * floor's routes (src/floor.js, /api/host/file) meet here: the tool asks, the
 * floor router does the work, because only it holds the hosts' queue and can
 * wake a host. A broker with nothing of its own but the waits.
 *
 * Why the sender's HOST reads the file, not the board or the tool: the file
 * is on the sender's computer, and the board may be on another one (the
 * owner's, for a guest's agent). The host is the one thing of the sender's
 * that the board can ask, and it is asked only for the transfer the board
 * made for that sender's own call.
 */
export const SEND_WAIT_MS = 60_000;

export function createFiles({ waitMs = SEND_WAIT_MS } = {}) {
  let impl = null;
  return {
    waitMs,
    /** The floor router hands its half over when it is built. */
    attach(floorImpl) { impl = floorImpl; },
    /** The tool's call: {channel, agent, to, path, note} → {sent, …} or {sent:false, code, error}. */
    async send(args) {
      if (!impl) return { sent: false, code: 'no_board', error: 'This board cannot move files yet.' };
      return impl.send(args, waitMs);
    },
  };
}
