import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { STATE_DIR } from '../godot/runtime-injection.js';
import { PROTOCOL_VERSION, type SessionFile } from './protocol.js';

const SESSION_FILE = 'session.json';
/** Owner read/write only: the file holds the bridge token. */
const PRIVATE_FILE_MODE = 0o600;

export function sessionFilePath(projectRoot: string): string {
  return path.join(projectRoot, STATE_DIR, SESSION_FILE);
}

/** Tells the editor plugin where to connect (it polls this file). */
export function writeSessionFile(
  projectRoot: string,
  port: number,
  token: string,
  serverVersion: string,
): void {
  const file = sessionFilePath(projectRoot);
  mkdirSync(path.dirname(file), { recursive: true });
  const session: SessionFile = {
    port,
    token,
    protocol: PROTOCOL_VERSION,
    pid: process.pid,
    server: serverVersion,
  };
  writeFileSync(file, `${JSON.stringify(session)}\n`, { mode: PRIVATE_FILE_MODE });
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
