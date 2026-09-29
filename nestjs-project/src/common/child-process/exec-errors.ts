import type { ExecFileException } from 'child_process';

// `execFile`'s callback error is a genuine Error, but Node's `child_process`
// module constructs it in its own realm — `err instanceof Error` can come
// back false for it under Jest's sandboxed test globals even though
// `err.constructor.name === 'Error'`. Classification below relies on shape
// (`code`/`killed`) rather than prototype identity, so it works both in
// production and under Jest.
export function isExecNonZeroExit(err: unknown): boolean {
  if (err === null || typeof err !== 'object') {
    return false;
  }
  const execErr = err as ExecFileException;
  return typeof execErr.code === 'number' && !execErr.killed;
}
