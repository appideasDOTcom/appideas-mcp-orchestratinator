/*
 * Drive the real page over CDP, without rewriting the boilerplate every time.
 *
 * This file exists because the same thirty lines — connect, surface
 * exceptionDetails, do the localStorage-then-renavigate dance, read a probe file
 * — got written from scratch six times in one session before anyone noticed.
 * None of it is the interesting part of a UI check and all of it is a place to
 * make a silent mistake: a thrown handler with no exceptionDetails reads as "the
 * click did nothing", and a sleep that is too short reads as "the feature does
 * not work".
 *
 *   node --experimental-websocket <your-check>.mjs
 *
 *   import { open } from '<repo>/.claude/skills/verify-ui-change/drive.mjs';
 *
 *   const page = await open({ base: 'http://localhost:8905', view: 'floor' });
 *   console.log(await page.probe('probe.js'));       // a file of browser code
 *   await page.click('#floor-pick .chip.archived');
 *   await page.waitFor(`document.querySelectorAll('#floor-rooms .room').length === 1`);
 *   console.log(await page.probe('probe.js'));
 *   await page.shot('out.png', '#floor-pick');
 *   await page.close();
 *
 * Put the browser code in its own file and pass its path. Nested backticks
 * inside a heredoc inside a shell command break in ways that look like a page
 * bug — that is the reason for `probe(file)` rather than `probe(string)`.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = Number(process.env.ORCH_CDP_PORT ?? 9222);
/** How long any single CDP command may go unanswered before it throws. See cmd(). */
const CMD_TIMEOUT_MS = Number(process.env.ORCH_CDP_TIMEOUT_MS ?? 30_000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Is a headless Chrome already listening? Reuse it rather than piling them up. */
async function browserUp(port) {
  try { return (await fetch(`http://localhost:${port}/json/version`)).ok; } catch { return false; }
}

/**
 * A browser, launched if one is not already there.
 *
 * The profile goes in tmpdir rather than the repo — a --user-data-dir inside the
 * working tree turns up in `git status` as a few thousand untracked files, which
 * is a genuinely alarming thing to hand someone whose review method is the diff.
 */
export async function browser({ port = DEBUG_PORT } = {}) {
  if (await browserUp(port)) return { port, launched: false };
  const profile = mkdtempSync(join(tmpdir(), 'orch-cdp-'));
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, '--disable-gpu',
    '--no-first-run', `--user-data-dir=${profile}`, '--window-size=1500,1000', 'about:blank',
  ], { stdio: 'ignore', detached: true });
  proc.unref();
  for (let i = 0; i < 60; i++) {
    if (await browserUp(port)) return { port, launched: true, profile };
    await sleep(150);
  }
  throw new Error(`Chrome never answered on :${port} — is it at ${CHROME}?`);
}

/** What "the page has finished its first render" means, per view. */
const READY = {
  floor: `!!document.querySelector('#floor-rooms .room, #floor-rooms .q-empty')`,
  board: `!!document.querySelector('.channel, .min-pill, main .empty')`,
};

/**
 * Open the board or the floor and hand back something to drive it with.
 *
 * `view` and `floor` are written to localStorage — which cannot be
 * done from about:blank (no origin: "SecurityError: Access is denied for this
 * document"), so this navigates to get an origin, writes, and navigates again.
 * That dance is the single most-repeated mistake in driving this page.
 */
export async function open({
  base = 'http://localhost:8787',
  view = null,          // 'floor' | 'board' | null to leave whatever is stored
  floor = undefined,    // channel name, or '' for all floors
  ready = undefined,    // a JS expression to wait for; defaults per view
  port = DEBUG_PORT,
} = {}) {
  if (typeof WebSocket === 'undefined') {
    throw new Error('no WebSocket — run node with --experimental-websocket (node 20)');
  }
  await browser({ port });
  const target = await (await fetch(`http://localhost:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const page = await connect(target);
  await page.goto(base);
  const sets = [];
  if (view) sets.push(`localStorage.setItem('orch.view', ${JSON.stringify(view)})`);
  if (floor !== undefined) sets.push(`localStorage.setItem('orch.floor', ${JSON.stringify(floor)})`);
  // There is no `minimized` any more: putting a floor away is the server's
  // archive flag (issue #21), so a check seeds it with POST /api/admin/channel/archive.
  if (sets.length) { await page.evalJs(`${sets.join(';')};'ok'`); await page.goto(base); }
  await page.waitFor(ready ?? READY[view] ?? `document.readyState === 'complete'`, { timeout: 15000 });
  return page;
}

/**
 * A window the page opened itself — a desk's popout (issue #19) — as its own
 * target, driven like any page. `match` is a test on the target's URL; the
 * wait is for the window to exist, since window.open returns before it does.
 * A popup is only opened on real input (`press()`), never a dispatched click:
 * the browser blocks window.open without a user gesture, and returns null.
 */
export async function attach(match, { port = DEBUG_PORT, timeout = 8000 } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const list = await (await fetch(`http://localhost:${port}/json/list`)).json();
    const t = list.find((x) => x.type === 'page' && match(x.url));
    if (t) {
      const page = await connect(t);
      await page.waitFor(`document.readyState === 'complete'`, { timeout: 15000 });
      return page;
    }
    if (Date.now() > until) throw new Error(`no window matching ${match} within ${timeout}ms — open: ${list.map((x) => x.url).join(', ')}`);
    await sleep(100);
  }
}

/** The pages open now, by URL — for asserting a window closed, or that a second was never opened. */
export async function targets({ port = DEBUG_PORT } = {}) {
  return (await (await fetch(`http://localhost:${port}/json/list`)).json()).filter((x) => x.type === 'page').map((x) => x.url);
}

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  };
  await new Promise((res) => { ws.onopen = res; });
  /* Every command carries a deadline, because the failure without one is silent
     and total.

     `evalJs` sends `awaitPromise: true`, so Runtime.evaluate does not answer
     until the injected expression's promise settles. Injected code that never
     settles therefore hangs this socket for ever — no error, no output, no
     exceptionDetails, just a script that never returns. Measured 2026-09-04
     against a real page: a shot script stubbed `window.fetch` to freeze the
     poll while it measured element rects, and the overlay it then injected
     began with `await fetch('./styles.css')`. That deadlock reads exactly like
     a slow page, and it cost most of an hour and three wrong theories about
     Chrome before anyone suspected the driver.

     Generous, because a legitimate evaluation may sit on a deliberate settle
     (`new Promise(r => setTimeout(r, 1800))`) and a navigation may be slow. The
     point is a floor under "for ever", not a tight bound. */
  const cmd = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id;
    const timer = setTimeout(() => {
      waiting.delete(i);
      rej(new Error(
        `CDP ${method} never answered after ${CMD_TIMEOUT_MS}ms. What is observed is silence, ` +
        `not a page error. The usual cause is injected code returning a promise that never ` +
        `settles — check whether the page's fetch/XHR was stubbed before the code that uses it.`));
    }, CMD_TIMEOUT_MS);
    waiting.set(i, (m) => { clearTimeout(timer); res(m); });
    ws.send(JSON.stringify({ id: i, method, params }));
  });

  /* Throwing rather than returning undefined on a page-side exception. A
     handler that threw otherwise reads exactly like a handler that ran and did
     nothing, and that difference has cost whole rounds here. */
  const evalJs = async (expression) => {
    const m = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    const ex = m.result?.exceptionDetails;
    if (ex) throw new Error(`page threw: ${ex.exception?.description ?? ex.text}`);
    return m.result?.result?.value;
  };

  const waitFor = async (expression, { timeout = 8000, every = 100 } = {}) => {
    // An observable, not a timer — see the floor's own spinner rules. A fixed
    // sleep is either slower than it needs to be or shorter than it needs to be,
    // and the second one is indistinguishable from a broken feature.
    const until = Date.now() + timeout;
    for (;;) {
      if (await evalJs(`!!(${expression})`)) return true;
      if (Date.now() > until) throw new Error(`waitFor timed out after ${timeout}ms: ${expression}`);
      await sleep(every);
    }
  };

  await cmd('Page.enable');
  const goto = async (url) => {
    await cmd('Page.navigate', { url });
    await waitFor(`document.readyState === 'complete'`, { timeout: 15000 });
  };

  return {
    targetId: target.id,
    evalJs,
    waitFor,
    goto,
    /**
     * Force the viewport size for this tab, whatever the browser was launched with.
     *
     * `browser()` reuses any Chrome already on the port, so its `--window-size`
     * is whoever-got-there-first — fine for a pass/fail check, not fine for a
     * picture. A documentation shot that needs room (a legend beside the room,
     * say) must state its own width or it silently composes against someone
     * else's. Overriding here rather than at launch is what makes that work on
     * a reused browser.
     */
    resize: async (width, height, { dpr = 1 } = {}) => {
      // `dpr` is the device pixel ratio the page is told it has. A landing-page
      // capture is asked for at DPR 2 (3200x2000 from a 1600x1000 viewport);
      // the clip `scale` on shot() is a different thing — it scales the
      // capture, not what the page believes about itself.
      await cmd('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false });
      return { width, height, dpr };
    },
    /** Run a file of browser code and return whatever it evaluates to. */
    probe: (file) => evalJs(readFileSync(file, 'utf8')),
    /**
     * Click, the way this page's delegated handlers expect. Floor pills read the
     * event target, so a bare .click() on some of them does nothing at all.
     */
    click: async (selector) => evalJs(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('no element for ' + ${JSON.stringify(selector)});
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()`),
    /**
     * A real press, move and release, through the browser's own input
     * pipeline rather than a dispatched event.
     *
     * `click()` above builds a MouseEvent and so names its own target. Where
     * the browser decides the target — a click dispatched on the nearest
     * common ancestor of where the button went down and where it came up, so
     * a drag out of a text field onto a modal's backdrop is a click on the
     * `<dialog>` (issue #11) — only real input says what a person gets.
     * `from` and `to` are each a selector (its centre) or `{ x, y }` in CSS
     * pixels; the same point for both is a plain click there.
     *
     * A plain click sends no moves unless `steps` asks for them. With the
     * drag's six it took 300–600 ms from press to release, because each move
     * is a CDP round trip. A dialog that redraws its body in that time, like
     * Take a desk when its folder listing arrives, replaced the button under
     * the held mouse. The release then landed on `#dlg-body` and no click
     * fired: 14 of 26 trials, against 0 of 20 with no moves (QA, PR #36 N1).
     * A drag keeps its moves, because the moves are the gesture.
     * `held` is a function run before the release, with the button down.
     */
    press: async (from, to = from, { steps, held } = {}) => {
      const at = async (p) => (typeof p === 'string'
        ? JSON.parse(await evalJs(`(() => {
            const el = document.querySelector(${JSON.stringify(p)});
            if (!el) throw new Error('no element for ' + ${JSON.stringify(p)});
            const r = el.getBoundingClientRect();
            return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
          })()`))
        : p);
      const a = await at(from);
      // One read for a click: a second could land after a layout shift and
      // turn the click into a short drag.
      const b = to === from ? a : await at(to);
      steps ??= a.x === b.x && a.y === b.y ? 0 : 6;
      const mouse = (type, { x, y }, buttons) => cmd('Input.dispatchMouseEvent',
        { type, x, y, button: 'left', buttons, clickCount: 1 });
      await mouse('mouseMoved', a, 0);
      await mouse('mousePressed', a, 1);
      for (let i = 1; i <= steps; i++) {
        await mouse('mouseMoved', { x: a.x + (b.x - a.x) * i / steps, y: a.y + (b.y - a.y) * i / steps }, 1);
      }
      // `held` runs with the button still down at the end point: what a
      // drag looks like before the page hears it end (issue #13's handle,
      // whose limit is only visible mid-drag).
      const during = held ? await held() : undefined;
      await mouse('mouseReleased', b, 0);
      return { from: a, to: b, during };
    },
    /**
     * A real key press — `key` as KeyboardEvent.key names it ('Escape', 'Enter').
     *
     * `shift` holds Shift for it. `text` is what the key types if nothing
     * prevents it: a `rawKeyDown` alone types nothing, so Shift+Enter in a
     * textarea adds its newline only as `key('Enter', { shift: true, text: '\r' })`.
     */
    key: async (key, { shift = false, text = undefined } = {}) => {
      const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
      const vk = { Escape: 27, Enter: 13, Tab: 9 }[key] ?? key.toUpperCase().charCodeAt(0);
      const modifiers = shift ? 8 : 0;
      await cmd('Input.dispatchKeyEvent', text === undefined
        ? { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, modifiers }
        : { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers, text, unmodifiedText: text });
      await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
    },
    /** Text typed at the focus through the browser's own input, as a
     *  keystroke or a paste arrives: one `input` event, `.value` changed. */
    type: async (text) => cmd('Input.insertText', { text }),
    /** A PNG of one element, with a little air around it. `scale` to read pixels. */
    shot: async (path, selector = null, { pad = 8, scale = 3, full = false } = {}) => {
      // `full` captures the whole document rather than the viewport, at the
      // page's own DPR: for a view taller than the window (the building). The
      // clip is the document's size; `captureBeyondViewport` is what lets the
      // clip reach past the bottom of the window.
      if (full && !selector) {
        const size = JSON.parse(await evalJs(`JSON.stringify({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })`));
        const png = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: size.w, height: size.h, scale: 1 } });
        writeFileSync(path, Buffer.from(png.result.data, 'base64'));
        return path;
      }
      const clip = selector
        ? JSON.parse(await evalJs(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) throw new Error('no element for ' + ${JSON.stringify(selector)});
            const r = el.getBoundingClientRect();
            return JSON.stringify({ x: Math.max(0, r.x - ${pad}), y: Math.max(0, r.y - ${pad}), width: r.width + ${pad * 2}, height: r.height + ${pad * 2} });
          })()`))
        : null;
      const png = await cmd('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale } } : {}) });
      writeFileSync(path, Buffer.from(png.result.data, 'base64'));
      return path;
    },
    /* Closes this tab's socket, not the browser: leaving Chrome up is what makes
       the next check start in a second rather than three. `pkill -f orch-cdp`
       when you are done with all of them. */
    close: async () => { await cmd('Target.closeTarget', { targetId: target.id }); ws.close(); },
  };
}
