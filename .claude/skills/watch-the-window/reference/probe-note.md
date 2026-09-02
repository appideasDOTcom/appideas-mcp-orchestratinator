# Reproducing the skill-write prompt

Writing a file under `.claude/skills/` raises Claude Code's own permission
prompt. That makes it the cheapest reliable way to get a *real* prompt on the
pane on demand, which is what any measurement of the answer path needs.

Use it with the pane recorder already running:

```bash
./grab-fast.sh live.txt orch:0.0 &
# then write any file under .claude/skills/
```

The prompt this raises is the one that defeated `answerPrompt` on 2026-08-31 —
the host read the pane, decided no question was standing, and refused to send
the operator's Approve. Keep this note as the fixture source: whatever the
capture shows that dialog looks like belongs in `test/window.mjs`, so the shape
is pinned rather than rediscovered.
