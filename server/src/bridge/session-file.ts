import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import { ensureStateDir, STATE_DIR, writePrivateFile } from '../util/state-dir.js';
import { PROTOCOL_VERSION, type SessionFile } from './protocol.js';

const SESSION_FILE = 'session.json';

export function sessionFilePath(projectRoot: string): string {
  return path.join(projectRoot, STATE_DIR, SESSION_FILE);
}

/** Tells the editor plugin where to connect (it polls this file). */
export function writeSessionFile(
  projectRoot: string,
  port: number,
  token: string,
  serverVersion: string,
  allowEval = false,
): void {
  // Owner-only, never through a symlink: the file holds the editor's bridge token.
  const file = path.join(ensureStateDir(projectRoot), SESSION_FILE);
  const session: SessionFile = {
    port,
    token,
    protocol: PROTOCOL_VERSION,
    pid: process.pid,
    server: serverVersion,
    allow_eval: allowEval,
  };
  writePrivateFile(file, `${JSON.stringify(session)}\n`);
}

/** Removes the session file if it is still ours (another server may have replaced it). */
export function removeSessionFile(projectRoot: string): void {
  const file = sessionFilePath(projectRoot);
  if (!existsSync(file)) return;
  try {
    const session = JSON.parse(readFileSync(file, 'utf8')) as Partial<SessionFile>;
    if (session.pid === process.pid) rmSync(file, { force: true });
  } catch {
    rmSync(file, { force: true });
  }
}
