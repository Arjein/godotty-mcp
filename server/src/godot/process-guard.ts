/**
 * The process guard: a tiny Node program that runs between the server and a long-lived Godot
 * process (a game, the headless LSP editor). It holds a stdin pipe from the server that is never
 * written to. The OS closes that pipe however the server ends, SIGKILL included, and the guard then
 * stops Godot, so a server killed hard leaves nothing running. It also forwards SIGTERM/SIGINT
 * (escalating to SIGKILL after a grace period) and exits the way Godot did.
 *
 * It runs as `node -e <source> -- <godot> <args...>` so it needs no file on disk. POSIX only: on
 * Windows a kill cannot be forwarded, and the server spawns Godot directly.
 */

/** How long the guard waits after SIGTERM before it SIGKILLs Godot. */
export const GUARD_KILL_GRACE_MS = 2_000;

const GUARD_SOURCE = `'use strict';
const { spawn } = require('node:child_process');
const { constants } = require('node:os');
const [grace, command, ...args] = process.argv.slice(1);
const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] });
let stopping = false;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  child.kill(signal);
  setTimeout(() => child.kill('SIGKILL'), Number(grace)).unref();
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGHUP', () => stop('SIGTERM'));
process.stdin.on('end', () => stop('SIGTERM'));
process.stdin.on('error', () => stop('SIGTERM'));
process.stdin.resume();
child.on('error', (error) => {
  process.stderr.write('ERROR: failed to start Godot: ' + error.message + '\\n');
  process.exit(127);
});
child.on('exit', (code, signal) => {
  if (signal === null) process.exit(code ?? 1);
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
  setTimeout(() => process.exit(128 + (constants.signals[signal] ?? 0)), 1000);
});
`;

/** Arguments for `process.execPath` that run `godotPath` behind the guard; Godot's args follow. */
export function guardArgs(godotPath: string, graceMs: number = GUARD_KILL_GRACE_MS): string[] {
  return ['-e', GUARD_SOURCE, '--', String(graceMs), godotPath];
}
