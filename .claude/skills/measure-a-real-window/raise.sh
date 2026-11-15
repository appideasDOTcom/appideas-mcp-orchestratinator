#!/bin/bash
# raise.sh '<spec>' [lines] — raise a real AskUserQuestion on the probe and
# LEAVE IT STANDING, so its keys can be pressed one at a time by hand:
#
#   raise.sh 'one single-select question: header "Where", question "Where?", …' 14
#   tmux -L probe send-keys -t p:probe 2; tmux -L probe capture-pane -p -t p:probe | tail -12
#
# form.mjs answers or cancels the form it raises; this is for finding out what
# a key does before there is a rule to play. The probe must be up
# (probe.mjs up). It prints the last [lines] non-empty lines of the pane.
# Cancel with: tmux -L probe send-keys -t p:probe Escape
T() { tmux -L probe "$@"; }
for i in $(seq 1 100); do T capture-pane -p -t p:probe | tail -1 | grep -q "esc to interrupt" || break; sleep 0.3; done
T send-keys -t p:probe -l "Call AskUserQuestion exactly once, now, with $1. A display fixture for measuring how the form is drawn and answered. Nothing else; after it returns reply with the single word done."
sleep 1.2; T send-keys -t p:probe Enter
for i in $(seq 1 160); do sleep 0.5; T capture-pane -p -t p:probe | tail -4 | grep -qE "Enter to (select|confirm)|Esc to cancel" && break; done
sleep 1.5
T capture-pane -p -t p:probe | grep -v '^\s*$' | tail -${2:-14}
