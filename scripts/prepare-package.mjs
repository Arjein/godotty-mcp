#!/usr/bin/env node
// Runs on `npm pack` / `npm publish` (prepack): copies the Godot addon, README and LICENSE into the
// server package so the published package is self-contained. The copies are gitignored.
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = path.join(repo, 'server');
const addonTarget = path.join(pkg, 'addon', 'godotty_mcp');

rmSync(path.join(pkg, 'addon'), { recursive: true, force: true });
cpSync(path.join(repo, 'addon', 'addons', 'godotty_mcp'), addonTarget, { recursive: true });
for (const file of ['LICENSE', 'CHANGELOG.md']) {
  cpSync(path.join(repo, file), path.join(pkg, file));
}
// npmjs.com shows the README out of the repository context: make relative links absolute.
const base = 'https://github.com/Arjein/godotty-mcp/blob/main/';
const readme = readFileSync(path.join(repo, 'README.md'), 'utf8').replace(
  /\]\((?!https?:|#)([^)]+)\)/g,
  (_match, target) => `](${base}${target})`,
);
writeFileSync(path.join(pkg, 'README.md'), readme);
console.log(`prepared ${path.relative(repo, addonTarget)} and package docs`);
