/*
 * Which commit this code was built from (issue #40).
 *
 * The board compares builds by commit, not by version number: 2 of the last
 * 11 merges to main kept their package.json version, and develop's last five
 * first-parent commits all read 0.10.18, so a version compare would have
 * missed every one of them. That needs the running build to know its commit,
 * and the image has no .git and no git binary.
 *
 * So the commit is resolved by reading .git directly — HEAD, then the ref it
 * names as a loose file or in packed-refs — with nothing but the filesystem.
 * The same function runs in three places:
 *   - at image build, against the clone's .git bind-mounted as a build
 *     context of its own (Dockerfile, docker-compose.yml `additional_contexts`),
 *     writing BUILD_COMMIT into the image. The main context's .dockerignore
 *     excludes .git, and an additional context is not subject to it, so the
 *     directory reaches the RUN step and never reaches a layer;
 *   - in the server at startup, which reads that file — or, run bare from a
 *     clone (`npm start`, the suites), the clone's .git;
 *   - in the host at startup, against the clone it runs from.
 * A build from a dirty tree records HEAD and not the edits on top of it.
 * Nothing here can see those; the update refuses a dirty clone for that
 * reason among others.
 *
 *   node src/build-info.js <git dir>     prints the commit, or nothing
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;

/** The commit HEAD names in `gitDir`, or null when it cannot be read. */
export function gitHeadOf(gitDir) {
  try {
    if (!gitDir || !existsSync(gitDir)) return null;
    // A worktree or submodule has a `.git` *file* pointing at the real one.
    if (statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, 'utf8'));
      if (!m) return null;
      const target = m[1].trim();
      return gitHeadOf(isAbsolute(target) ? target : join(dirname(gitDir), target));
    }
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    if (SHA.test(head)) return head; // detached
    const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
    if (!ref) return null;
    const loose = join(gitDir, ref);
    if (existsSync(loose)) {
      const sha = readFileSync(loose, 'utf8').trim();
      return SHA.test(sha) ? sha : null;
    }
    // A worktree keeps its refs in the common dir.
    const common = existsSync(join(gitDir, 'commondir'))
      ? join(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim())
      : gitDir;
    if (common !== gitDir && existsSync(join(common, ref))) {
      const sha = readFileSync(join(common, ref), 'utf8').trim();
      return SHA.test(sha) ? sha : null;
    }
    const packed = join(common, 'packed-refs');
    if (!existsSync(packed)) return null;
    for (const line of readFileSync(packed, 'utf8').split('\n')) {
      const [sha, name] = line.trim().split(' ');
      if (name === ref && SHA.test(sha)) return sha;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The commit of the server's own build: ORCH_BUILD_COMMIT if set (the suites
 * use it to stand in for a build), else the BUILD_COMMIT the image build
 * wrote beside src/, else the .git of the clone this is running from.
 */
export function buildCommit(env = process.env) {
  const given = (env.ORCH_BUILD_COMMIT ?? '').trim();
  if (given) return SHA.test(given) ? given : null;
  const root = fileURLToPath(new URL('../', import.meta.url));
  try {
    const baked = readFileSync(join(root, 'BUILD_COMMIT'), 'utf8').trim();
    if (SHA.test(baked)) return baked;
  } catch { /* not an image build */ }
  return gitHeadOf(join(root, '.git'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const sha = gitHeadOf(process.argv[2]);
  if (sha) process.stdout.write(`${sha}\n`);
}
