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
  /** Port of the Godot editor's GDScript language server (editor setting; default 6005). */
  editorLspPort?: number | undefined;
  /** Never use the network (docs show signatures only). */
  offline?: boolean | undefined;
}

export const ENV = {
  project: 'GODOT_PROJECT_PATH',
  godot: 'GODOT_PATH',
  allowEval: 'GODOTTY_ALLOW_EVAL',
  lspPort: 'GODOT_LSP_PORT',
  offline: 'GODOTTY_OFFLINE',
} as const;

const DEFAULT_GODOT = 'godot';
const PROJECT_FILE = 'project.godot';

export const USAGE = `Usage: godotty-mcp [--project <dir>] [--godot <executable>] [--allow-eval]
       godotty-mcp install-addon [--project <dir>] [--force]

  --project <dir>    Godot project root (env ${ENV.project}; default: current directory)
  --godot <path>     Godot 4 executable (env ${ENV.godot}; default: "godot" on PATH)
  --lsp-port <port>  Editor GDScript language server port (env ${ENV.lspPort}; default 6005)
  --offline          Never use the network; docs show signatures only (env ${ENV.offline}=1)
  --allow-eval       Enable eval_gdscript, which runs arbitrary GDScript (env ${ENV.allowEval}=1)
  --help             Show this help`;

/** Thrown when the user asked for --help; the entry point prints usage and exits 0. */
export class HelpRequested extends Error {}

/**
 * Builds the config from argv (without the node/script prefix) and env.
 * Flags win over env vars. The project folder must exist, but project.godot may be created later:
 * the server starts anyway and project tools say what is missing (see `projectFileProblem`).
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
      'lsp-port': { type: 'string' },
      'allow-eval': { type: 'boolean' },
      offline: { type: 'boolean' },
      help: { type: 'boolean' },
    },
    strict: true,
  });
  if (values.help === true) {
    throw new HelpRequested();
  }
  const projectPath = path.resolve(cwd, values.project ?? env[ENV.project] ?? '.');
  assertProjectFolder(projectPath);
  const lspPort = values['lsp-port'] ?? env[ENV.lspPort];
  return {
    projectPath,
    godotPath: values.godot ?? env[ENV.godot] ?? DEFAULT_GODOT,
    allowEval: values['allow-eval'] === true || isTruthy(env[ENV.allowEval]),
    ...(lspPort === undefined ? {} : { editorLspPort: parsePort(lspPort) }),
    ...(values.offline === true || isTruthy(env[ENV.offline]) ? { offline: true } : {}),
  };
}

const MAX_PORT = 65_535;

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new ToolError(
      ErrorCode.InvalidInput,
      `Invalid port "${value}".`,
      'Use a number between 1 and 65535.',
    );
  }
  return port;
}

function assertProjectFolder(projectPath: string): void {
  if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
    throw new ToolError(
      ErrorCode.NotFound,
      `Project folder "${projectPath}" does not exist.`,
      `Pass --project <dir> or set ${ENV.project} to your Godot project root.`,
    );
  }
}

/** Whether the project folder has its project.godot yet. */
export function hasProjectFile(projectPath: string): boolean {
  return existsSync(path.join(projectPath, PROJECT_FILE));
}

/** The error project tools return while project.godot is missing. */
export function missingProjectError(projectPath: string): ToolError {
  return new ToolError(
    ErrorCode.NotFound,
    `No ${PROJECT_FILE} in "${projectPath}" yet.`,
    `Create the Godot project there (the Godot project manager, or a minimal ${PROJECT_FILE} with ` +
      'config_version=5), then call again; the server picks it up without a restart. godot_docs ' +
      'works without a project.',
  );
}

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}
