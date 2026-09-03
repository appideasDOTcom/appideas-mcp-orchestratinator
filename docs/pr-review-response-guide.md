# Responding to a QA review: the developer's role

The canonical version of this document lives in the QA repo, not here:

**[appideas-qa-agent/docs/pr-review-response-guide.md](https://github.com/appideasDOTcom/appideas-qa-agent/blob/main/docs/pr-review-response-guide.md)**

It started as a draft in this repo (2026-09-03, written after the PR #2
review round), and QA curated it into the canonical copy — same text and
structure, with five things added that this draft got right in practice but
never wrote down as rules: leaving QA's threads open (reply, never resolve —
QA is the only resolver, after re-measuring), stating precisely where a fix
is (pushed at a named SHA, or uncommitted in a working tree — QA only
re-measures at a pushed SHA), shipping every fix with a test that would
notice its reversal or saying why no tier can hold one, driving two sessions
(not just asking about them) for anything keyed by desk/agent/channel rather
than session, and a "reproducing QA's measurements" section pointing at
where the mutation-testing tools actually live.

This file stays a pointer rather than a second copy on purpose: two copies of
one process drift, which is exactly the failure a written process exists to
prevent. If this project's own practice ever needs to diverge from the
canonical version, say so to QA rather than editing this file directly — that
keeps one process instead of two.
