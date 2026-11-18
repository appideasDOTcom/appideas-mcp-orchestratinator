#!/usr/bin/env python3
"""Put the operator's settings.json back after a probe's /model or /effort.

    cp -p ~/.claude/settings.json "$SP/settings.json.before"; shasum -a 256 ~/.claude/settings.json
    # … measure …
    python3 .claude/skills/measure-a-real-window/restore-settings.py "$SP/settings.json.before"
    # differs before restore: {"model": ["claude-fable-5-2", "haiku"]}
    # restored byte for byte — sha256 d4fc2d75…

A probe runs on the operator's own profile, so each /model and /effort it
is sent rewrites `model`, `modelSettings` and `effortLevel` in his file.
Copying the saved file back whole also undoes whatever else changed in it
meanwhile, and he changes his own settings from his own windows while a
measurement runs (he had, minutes before the 2026-11-15 one). So this puts
back those three keys alone, and:

  - when nothing else differs, writes the saved file's bytes, so the hash
    after is the hash before;
  - when another key differs, keeps that key as it is now, says which, and
    writes the rest as JSON. The hash is then a new one, and that is right.

A second argument names the file to restore (default ~/.claude/settings.json);
it is there so this can be run on two throwaway files first.
Exit 0 either way; 2 on a file that is not JSON, with nothing written.
"""
import hashlib, json, os, sys

KEYS = ('model', 'modelSettings', 'effortLevel')

def main():
    if len(sys.argv) not in (2, 3):
        print('usage: restore-settings.py <settings.json.before> [<settings.json>]', file=sys.stderr); return 2
    saved = sys.argv[1]
    path = sys.argv[2] if len(sys.argv) == 3 else os.path.expanduser('~/.claude/settings.json')
    try:
        raw = open(saved, 'rb').read(); before = json.loads(raw); now = json.load(open(path))
    except (OSError, ValueError) as e:
        print(f'restore-settings.py: {e} — nothing written', file=sys.stderr); return 2
    differs = lambda: sorted(k for k in set(before) | set(now) if before.get(k) != now.get(k))
    print('differs before restore:', json.dumps({k: [before.get(k), now.get(k)] for k in differs()}))
    for k in KEYS:
        if k in before: now[k] = before[k]
        else: now.pop(k, None)
    left = differs()
    if not left:
        open(path, 'wb').write(raw)
        print('restored byte for byte — sha256', hashlib.sha256(raw).hexdigest())
    else:
        with open(path, 'w') as f: json.dump(now, f, indent=2); f.write('\n')
        print('other keys changed meanwhile and were kept as they are now:', ', '.join(left))
        print('the three a probe writes are back — sha256', hashlib.sha256(open(path, 'rb').read()).hexdigest())
    return 0

sys.exit(main())
