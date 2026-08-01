/**
 * Single source of truth for the version string.
 *
 * Deliberately a literal rather than a `require('../package.json')`: reading
 * package.json at runtime breaks under bundlers, breaks when the package is
 * vendored, and forces `resolveJsonModule` on every consumer. The release
 * script keeps this in lockstep with package.json and CI asserts they match.
 */
export const VERSION = '0.1.0';

export const NAME = 'fibonacci';
export const BIN = 'fib';
export const REPO_URL = 'https://github.com/hispeedtransmission/fibonacci-code';
