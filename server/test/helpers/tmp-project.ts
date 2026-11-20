import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Creates a throwaway Godot project folder (with project.godot) and returns its canonical path. */
export function makeTempProject(files: Record<string, string> = {}): {
  root: string;
  cleanup: () => void;
} {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'godotty-mcp-test-')));
  writeFileSync(path.join(root, 'project.godot'), 'config_version=5\n');
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return {
    root,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
