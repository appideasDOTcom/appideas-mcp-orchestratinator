/**
 * What Electron does with a board page's raise of a window it opened: the
 * measurement behind contract orchestratinator.window_moves (2026-11-19,
 * Electron 45.2.3). Run it again whenever the app's Electron moves.
 *
 *   APP=…/orchestratinator-desktop
 *   cd <a scratch dir> && cp <this file> main.cjs
 *   "$APP/node_modules/.bin/electron" main.cjs | grep probe          # Electron alone
 *   FIX=1 "$APP/node_modules/.bin/electron" main.cjs | grep probe    # with the app's handler
 *
 * It opens two small windows on the screen for about ten seconds, and
 * takes the front once with FIX=1. Four cases: a covered window raised
 * through the opener's handle (A), a minimized one (B), the room moving
 * itself (C), and a move to the spot it already stands on (D).
 *
 * On 45.2.3, alone: focused false in every case, a minimized window moved
 * while minimized, no `activate` or other event for focus(), and
 * `content-bounds-updated` on every move, D included. With FIX=1 (restore,
 * setBounds, show, focus, app.focus steal, on content-bounds-updated):
 * focused true and minimized false in all four. If Electron starts
 * honouring focus(), "focused true" shows without FIX=1; if it stops
 * sending content-bounds-updated for a page's move, the app's raise is
 * broken and the contract needs another signal.
 */
const { app, BrowserWindow } = require('electron');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[probe]', ...a);
app.whenReady().then(async () => {
  const parent = new BrowserWindow({ width: 400, height: 300, x: 50, y: 50 });
  await parent.loadURL('data:text/html,<title>opener</title>parent');
  let child;
  parent.webContents.on('did-create-window', (w) => { child = w; });
  await parent.webContents.executeJavaScript(`window.w = window.open('about:blank', 'room', 'width=300,height=200'); 1`, true);
  await wait(800);
  const ev = [];
  child.webContents.on('content-bounds-updated', (e, b) => {
    ev.push(['content-bounds-updated', JSON.stringify(b)]);
    if (process.env.FIX) setImmediate(() => { if (child.isMinimized()) child.restore(); child.setBounds(b); child.show(); child.focus(); app.focus({ steal: true }); });
  });
  child.webContents.on('activate', () => ev.push(['wc activate']));
  child.on('focus', () => ev.push(['win focus']));
  child.on('restore', () => ev.push(['win restore']));
  child.on('move', () => ev.push(['win move']));
  const state = (label) => log(label, 'minimized', child.isMinimized(), 'focused', child.isFocused(), 'bounds', JSON.stringify(child.getBounds()));

  // Case A: not minimized, behind the parent.
  parent.focus(); await wait(500); state('A before');
  await parent.webContents.executeJavaScript(`w.moveTo(500, 400); w.focus(); 1`, true);
  await wait(800); state('A after page focus+move'); log('A events', JSON.stringify(ev)); ev.length = 0;

  // Case B: minimized.
  child.minimize(); await wait(1200); parent.focus(); await wait(300); state('B before');
  await parent.webContents.executeJavaScript(`w.focus(); w.moveTo(200, 200); w.focus(); 1`, true);
  await wait(1200); state('B after page focus+move'); log('B events', JSON.stringify(ev)); ev.length = 0;

  // Case C: the room's own window moving and focusing itself (floor tab with no handle).
  child.minimize(); await wait(1200); parent.focus(); await wait(300);
  await child.webContents.executeJavaScript(`window.moveTo(300, 300); window.focus(); 1`, true);
  await wait(1200); state('C after self focus+move'); log('C events', JSON.stringify(ev));
  // Case D: the same place again (a second click where the window already stands), covered and minimized.
  child.minimize(); await wait(1200); parent.focus(); await wait(300); ev.length = 0;
  await parent.webContents.executeJavaScript(`w.moveTo(300, 300); w.focus(); 1`, true);
  await wait(1200); state('D after same-place move'); log('D events', JSON.stringify(ev));
  app.exit(0);
});
