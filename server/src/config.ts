import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { ErrorCode, ToolError } from './util/errors.js';

/** Runtime configuration, resolved once at startup from CLI flags and environment variables. */
export interface ServerConfig {
  /** Absolute path of the Godot project root (the folder containing project.godot). */
  projectPath: string;
  /** Godot executable to invoke; a bare name is looked up on PATH. */
  godotPath: string;
  /** Registers `eval_gdscript`. Off unless explicitly enabled. */
  allowEval: boolean;
}

export const ENV = {
  project: 'GODOT_PROJECT_PATH',
  godot: 'GODOT_PATH',
  allowEval: 'GODOTTY_ALLOW_EVAL',
} as const;

const DEFAULT_GODOT = 'godot';
const PROJECT_FILE = 'project.godot';

export const USAGE = `Usage: godotty-mcp [--project <dir>] [--godot <executable>] [--allow-eval]

  --project <dir>    Godot project root (env ${ENV.project}; default: current directory)
  --godot <path>     Godot 4 executable (env ${ENV.godot}; default: "godot" on PATH)
  --allow-eval       Enable eval_gdscript, which runs arbitrary GDScript (env ${ENV.allowEval}=1)
  --help             Show this help`;

/** Thrown when the user asked for --help; the entry point prints usage and exits 0. */
export class HelpRequested extends Error {}

/**
 * Builds the config from argv (without the node/script prefix) and env.
 * Flags win over env vars; the project folder must contain project.godot.
 */
export function loadConfig(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): ServerConfig {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      project: { type: 'string' },
      godot: { type: 'string' },
      'allow-eval': { type: 'boolean' },
      help: { type: 'boolean' },
    },
    strict: true,
  });
  if (values.help === true) {
    throw new HelpRequested();
  }
  const projectPath = path.resolve(cwd, values.project ?? env[ENV.project] ?? '.');
  assertGodotProject(projectPath);
  return {
    projectPath,
    godotPath: values.godot ?? env[ENV.godot] ?? DEFAULT_GODOT,
    allowEval: values['allow-eval'] === true || isTruthy(env[ENV.allowEval]),
  };
}

function assertGodotProject(projectPath: string): void {
  const isDir = existsSync(projectPath) && statSync(projectPath).isDirectory();
  if (!isDir || !existsSync(path.join(projectPath, PROJECT_FILE))) {
    throw new ToolError(
      ErrorCode.NotFound,
      `No ${PROJECT_FILE} found in "${projectPath}".`,
      `Pass --project <dir> or set ${ENV.project} to your Godot project root.`,
    );
  }
}

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}
