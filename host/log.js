// What the host writes down, and the words a failed request is written in.
//
// A module of its own so the host suite can read both without starting a host:
// host/index.js runs main() the moment it is imported.
//
// Issue #5 is why either exists. The host log is one append-only file under
// launchd, and on 2026-11-03 it held 7,379 failure lines in 11,745 with not one
// time among them, so a burst could be counted but never lined up against the
// board's own log for the same minutes. And every failure read `fetch failed`
// or "The operation was aborted due to timeout": which request, of which
// board, and after how long were all gone, because request() named its method
// and path only on a non-2xx reply.
import { inspect } from 'node:util';

export const TAG = '[host]';

/**
 * One call's words as the lines it writes, each tagged and timed in UTC.
 *
 * The tag stays first and the time comes second, on purpose. The file still
 * holds every line written before the time was added, and what reads it
 * anchors on the tag: deploy-both-halves's status.sh tells a desk line from a
 * message by `^\[host\]` and the indent after it. With the tag first, a
 * reader anchored on it reads both shapes; with the time in front, no line
 * written from now on would start with the tag at all.
 *
 * Every line of a message gets both, not only the first: a stack trace after
 * `fatal:` is otherwise a run of lines that belong to no one and no moment.
 * Arguments are joined the way console.log joins them after its first, so a
 * `%` in a folder name is never read as a format directive.
 */
export function stamp(args, now = new Date()) {
  const text = args.map((a) => (typeof a === 'string' ? a : inspect(a))).join(' ');
  const at = now.toISOString();
  return text.split('\n').map((line) => `${TAG} ${at} ${line}`).join('\n');
}

export const log = (...a) => console.log(stamp(a));
export const warn = (...a) => console.warn(stamp(a));
export const error = (...a) => console.error(stamp(a));

/**
 * What became of a request that got no answer, in the words the failure
 * itself carries — never a guessed reason. "refused" is said only for
 * ECONNREFUSED, which is the socket saying so; anything else is named by its
 * own code and message, because a socket the far side closed (UND_ERR_SOCKET)
 * and a name that did not resolve (ENOTFOUND) are different faults that both
 * arrive as `fetch failed`. A timeout is fetch's own TimeoutError, raised by
 * the AbortSignal whether the wait was for the reply or for its body.
 */
export function failureOf(err) {
  if (err?.name === 'TimeoutError') return 'timed out';
  const cause = err?.cause;
  if (cause?.code === 'ECONNREFUSED') return 'refused (ECONNREFUSED)';
  if (cause?.code) return `failed (${cause.code}${cause.message && cause.message !== cause.code ? `: ${cause.message}` : ''})`;
  return `failed (${err?.name ?? 'Error'}: ${err?.message ?? err})`;
}

/**
 * A failed host→board request as one sentence: the method, the whole URL —
 * the board and the path in one token, so a count by route or by board is one
 * grep — what failed, and how long it waited. The limit is beside the wait
 * whenever it timed out, because the two disagreeing is evidence too: the
 * timer that ends the wait runs on the host's own event loop, so a timeout
 * that waited well past its limit is a host that could not get to it for the
 * difference, not only a board that answered late.
 */
export function requestFailed({ method, url, what, waitedMs, limitMs }) {
  const limit = /timed out/.test(what) && limitMs != null ? ` (limit ${limitMs}ms)` : '';
  return `${method} ${url} ${what} after ${Math.round(waitedMs)}ms${limit}`;
}
