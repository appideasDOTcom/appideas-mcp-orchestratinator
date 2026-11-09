// The probe try-dep.sh uses for better-sqlite3, with or without --live-db: open the board's database read-only with
// the better-sqlite3 under test and say what it reads. Nothing is written;
// the volume is mounted read-only and the handle is opened read-only too.
//
// The database is in WAL mode, so a read-only open needs the -shm file the
// running board keeps beside it. With the board stopped and no -shm on the
// volume this fails to open, and that is not a verdict on the dependency.
const Database = require('better-sqlite3');
if (!process.env.DB_PATH) {
  // The rows for this machine's own Nodes: the live data is mounted only
  // inside Docker, so here the probe says the module loaded and stops.
  new Database(':memory:').close();
  console.log('loaded better-sqlite3 ' + require('better-sqlite3/package.json').version + ' (no DB_PATH here; the live data is read inside Docker only)');
  process.exit(0);
}
const db = new Database(process.env.DB_PATH, { readonly: true });
const out = {
  better_sqlite3: require('better-sqlite3/package.json').version,
  sqlite: db.prepare('select sqlite_version() v').get().v,
  tables: db.prepare("select count(*) c from sqlite_master where type = 'table'").get().c,
  journal_mode: db.pragma('journal_mode', { simple: true }),
  quick_check: db.pragma('quick_check', { simple: true }),
  counts: {},
};
for (const t of ['messages', 'tasks', 'agents', 'turns', 'hosts', 'hosted_desks', 'settings', 'contracts']) {
  try { out.counts[t] = db.prepare(`select count(*) c from ${t}`).get().c; } catch (e) { out.counts[t] = e.message; }
}
console.log('loaded ' + JSON.stringify(out));
