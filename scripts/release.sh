#!/usr/bin/env bash
#
# Publish fibonacci-code to npm and PyPI.
#
# Everything here is verifiable before anything irreversible happens: a package
# name, once published, can never be reused even after `npm unpublish`. So the
# script checks lockstep, runs the full suite, builds, inspects the tarball, and
# only then asks for confirmation.
#
# Usage:
#   scripts/release.sh            # publish both
#   scripts/release.sh --dry-run  # verify everything, publish nothing
#   scripts/release.sh --npm-only
#   scripts/release.sh --pypi-only

set -euo pipefail

cd "$(dirname "$0")/.."

DRY_RUN=0
DO_NPM=1
DO_PYPI=1
for arg in "$@"; do
  case "$arg" in
    --dry-run)   DRY_RUN=1 ;;
    --npm-only)  DO_PYPI=0 ;;
    --pypi-only) DO_NPM=0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

bold "1. Version lockstep"
PKG=$(node -p "require('./package.json').version")
SRC=$(grep -oE "VERSION = '[^']+'" src/version.ts | cut -d"'" -f2)
PY=$(grep -oE '^version = "[^"]+"' python/pyproject.toml | cut -d'"' -f2)
[ "$PKG" = "$SRC" ] || die "package.json ($PKG) != src/version.ts ($SRC)"
[ "$PKG" = "$PY" ]  || die "package.json ($PKG) != pyproject.toml ($PY)"
ok "all three agree on $PKG"

bold "2. Clean tree"
[ -z "$(git status --porcelain)" ] || die "uncommitted changes — commit or stash first"
ok "working tree clean"

bold "3. Already published?"
if curl -sf "https://registry.npmjs.org/fibonacci-code/$PKG" >/dev/null 2>&1; then
  die "npm already has fibonacci-code@$PKG — bump the version"
fi
ok "npm has no $PKG yet"

bold "4. Tests"
npm run typecheck >/dev/null && ok "typecheck"
npm test >/dev/null 2>&1 && ok "node tests"
if [ -x python/.venv/bin/pytest ]; then
  (cd python && .venv/bin/pytest -q >/dev/null) && ok "python tests"
else
  printf '  \033[33m!\033[0m python venv missing — skipping pytest\n'
fi

bold "5. Build"
npm run clean >/dev/null 2>&1 || true
npm run build >/dev/null && ok "dist/ built"
node dist/cli.js --version >/dev/null && ok "dist/cli.js runs"

bold "6. Tarball contents"
npm pack --silent >/dev/null
TARBALL="fibonacci-code-$PKG.tgz"
tar tzf "$TARBALL" > /tmp/fib-files.txt
grep -q 'package/dist/cli.js' /tmp/fib-files.txt || die "dist/cli.js missing from tarball"
grep -q 'package/README.md'   /tmp/fib-files.txt || die "README missing"
grep -q 'package/LICENSE'     /tmp/fib-files.txt || die "LICENSE missing"
if grep -qE 'package/(test/|src/|auth\.json|\.env)' /tmp/fib-files.txt; then
  die "tarball contains sources, tests, or credentials"
fi
ok "$(wc -l < /tmp/fib-files.txt | tr -d ' ') files, no sources or secrets"

bold "7. Python distributions"
(cd python && rm -rf dist && python3 -m build >/dev/null 2>&1 && python3 -m twine check dist/* >/dev/null) \
  && ok "sdist + wheel build and pass twine check" \
  || printf '  \033[33m!\033[0m python build/twine unavailable — install with: pip install build twine\n'

if [ "$DRY_RUN" = "1" ]; then
  bold "Dry run complete — nothing published."
  rm -f "$TARBALL"
  exit 0
fi

echo
bold "About to publish fibonacci-code@$PKG publicly. This cannot be undone."
read -r -p "Type the version to confirm: " CONFIRM
[ "$CONFIRM" = "$PKG" ] || die "confirmation did not match"

if [ "$DO_NPM" = "1" ]; then
  bold "Publishing to npm"
  npm publish --access public
  ok "https://www.npmjs.com/package/fibonacci-code"
fi

if [ "$DO_PYPI" = "1" ]; then
  bold "Publishing to PyPI"
  (cd python && python3 -m twine upload dist/*)
  ok "https://pypi.org/project/fibonacci-code/"
fi

rm -f "$TARBALL"

bold "Tagging"
git tag -a "v$PKG" -m "v$PKG"
git push origin "v$PKG"
ok "tagged v$PKG"

echo
bold "Done. Verify with:"
echo "  npm view fibonacci-code version"
echo "  pip index versions fibonacci-code"
