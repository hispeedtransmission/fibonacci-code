/**
 * The boundary that stops a model-supplied path from touching anything
 * outside the workspace. Every other fs tool routes through this first.
 *
 * A naive implementation does `path.resolve(root, candidate).startsWith(root)`.
 * That fails in three separate ways, all of which a real agent will hit:
 *
 * 1. String-prefix comparison is not segment-aware: `/work` "starts with"
 *    `/workspace-other` is false, sure, but the reverse — treating `/work`
 *    as containing `/workspace-other` — is a real bug shape when roots share
 *    a prefix. `path.relative` and checking for a leading `..` is the only
 *    correct containment test.
 * 2. It never resolves symlinks, so a symlink placed inside the workspace
 *    that points outside it sails straight through. The fix is `realpath`,
 *    but the candidate may be a file that doesn't exist yet (a write to a
 *    brand-new path must still be allowed), so we realpath the deepest
 *    existing ancestor instead of demanding the full path exist.
 * 3. It compares an unresolved root against a resolved candidate. On macOS,
 *    `/tmp` is a symlink to `/private/tmp` — a workspace rooted at `/tmp/x`
 *    then rejects every single path inside it, because the candidate's
 *    realpath starts with `/private/tmp/x` and the raw root does not. Root
 *    has to go through the identical realpath treatment as candidate.
 *
 * Also case-correct: macOS is case-insensitive but case-preserving, so a
 * `.toLowerCase()` "fix" for that is actively wrong on a case-sensitive
 * volume (Linux, or a sensitive APFS volume). We never fold case; `realpath`
 * already returns the on-disk casing for whatever portion of the path exists.
 */

import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { UsageError } from '../errors.ts';

/**
 * Realpath the deepest existing ancestor of `p`, then re-append whatever
 * trailing segments don't exist yet. Those segments can't be symlinks (they
 * aren't on disk), so this is a full, correct resolution of every symlink
 * that *is* on disk without requiring `p` itself to exist.
 */
function realpathOfDeepestExisting(p: string): string {
  let cur = p;
  const remainder: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(cur);
      return remainder.length === 0 ? real : join(real, ...remainder);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = dirname(cur);
      if (parent === cur) throw err; // hit the fs root and even that is missing
      remainder.unshift(basename(cur));
      cur = parent;
    }
  }
}

/**
 * Resolve `candidate` against `root` and guarantee the result is inside
 * `root`. Throws `UsageError` if it isn't.
 *
 * Known limitation: this is a point-in-time check, not a held lock. A
 * symlink created between this call and the caller's actual fs operation
 * (TOCTOU) isn't defended against — that needs O_NOFOLLOW-style openat
 * loops Node doesn't expose portably. Fine for an interactive agent; not a
 * substitute for OS-level sandboxing if that's ever the threat model.
 */
export function resolveInWorkspace(root: string, candidate: string): string {
  const rootAbs = resolve(root);
  const candidateAbs = isAbsolute(candidate) ? resolve(candidate) : resolve(rootAbs, candidate);

  const realRoot = realpathOfDeepestExisting(rootAbs);
  const realCandidate = realpathOfDeepestExisting(candidateAbs);

  const rel = relative(realRoot, realCandidate);
  const escapes = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (escapes) {
    throw new UsageError(`Path escapes the workspace: ${candidate}`, `Paths must resolve inside ${root}.`);
  }

  // Return the logical (pre-realpath) path, not the canonicalized one: the
  // check above already proves it's safe, and callers expect paths rooted
  // at the `root` string they passed in, not wherever that root's own
  // symlink chain happens to physically live.
  return candidateAbs;
}

/** Non-throwing form of {@link resolveInWorkspace}. */
export function isWithin(root: string, candidate: string): boolean {
  try {
    resolveInWorkspace(root, candidate);
    return true;
  } catch {
    return false;
  }
}

/** One sensitive-path rule, matched against the path's `/`-or-`\`-split segments. */
export interface SensitivePattern {
  /** Human-readable description, surfaced in the thrown error and enumerable by docs/tests. */
  readonly description: string;
  readonly test: (segments: readonly string[]) => boolean;
}

function pathSegments(p: string): string[] {
  return p.split(sep).filter((s) => s !== '');
}

/**
 * Paths an agent should never read or write, even inside the workspace.
 * Exported so tests and docs can enumerate exactly what's blocked instead of
 * re-deriving it from the implementation.
 */
export const SENSITIVE_PATTERNS: readonly SensitivePattern[] = [
  {
    description: '.env and .env.* files (.env.example is explicitly allowed)',
    test: (segs) => {
      const base = segs[segs.length - 1] ?? '';
      if (base === '.env') return true;
      return base.startsWith('.env.') && base !== '.env.example';
    },
  },
  {
    description: '.git/config',
    test: (segs) => segs.length >= 2 && segs[segs.length - 2] === '.git' && segs[segs.length - 1] === 'config',
  },
  {
    description: 'SSH/TLS private keys (id_rsa, id_ed25519, *.pem, *.key)',
    test: (segs) => {
      const base = segs[segs.length - 1] ?? '';
      return base === 'id_rsa' || base === 'id_ed25519' || base.endsWith('.pem') || base.endsWith('.key');
    },
  },
  {
    description: '.npmrc',
    test: (segs) => (segs[segs.length - 1] ?? '') === '.npmrc',
  },
  {
    description: '.pypirc',
    test: (segs) => (segs[segs.length - 1] ?? '') === '.pypirc',
  },
  {
    description: '.aws/credentials',
    test: (segs) => segs.length >= 2 && segs[segs.length - 2] === '.aws' && segs[segs.length - 1] === 'credentials',
  },
  {
    description: 'anything inside a .ssh directory',
    test: (segs) => segs.includes('.ssh'),
  },
  {
    description: 'anything inside a .fibonacci or .codex directory (credential stores)',
    test: (segs) => segs.includes('.fibonacci') || segs.includes('.codex'),
  },
];

/** Throws `UsageError` if `absPath` matches any rule in {@link SENSITIVE_PATTERNS}. */
export function assertNotSensitive(absPath: string): void {
  const segs = pathSegments(resolve(absPath));
  const hit = SENSITIVE_PATTERNS.find((p) => p.test(segs));
  if (hit) {
    throw new UsageError(`Refusing to touch a sensitive path: ${absPath}`, `Matches rule: ${hit.description}.`);
  }
}
