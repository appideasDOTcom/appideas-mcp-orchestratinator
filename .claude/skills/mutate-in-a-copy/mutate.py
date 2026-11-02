#!/usr/bin/env python3
"""Replace exactly one occurrence of a string in a file, or fail loudly.

    mutate.py <file> <old> <new>

A mutation that silently does not apply is a mutant that "survives" for no
reason at all — the suite runs against unchanged code and passes. So this
refuses unless <old> occurs exactly once, and says how many times it did.
It also refuses a path inside a git checkout: the copy has no .git, the
repo does, and that is the whole difference between the two.
"""
import os
import sys

path, old, new = sys.argv[1:4]
probe = os.path.abspath(path)
while probe != os.path.dirname(probe):
    probe = os.path.dirname(probe)
    if os.path.isdir(os.path.join(probe, '.git')):
        sys.exit(f'refusing: {path} is inside a git checkout ({probe}) — mutate the copy, never the working tree')
text = open(path).read()
count = text.count(old)
if count != 1:
    sys.exit(f'not applied: the text occurs {count} times in {path}, wanted exactly 1')
open(path, 'w').write(text.replace(old, new))
