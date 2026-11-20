import { describe, expect, it } from 'vitest';

import { globToRegExp, matchesType, walkProject } from '../../src/util/files.js';
import { makeTempProject } from '../helpers/tmp-project.js';

describe('walkProject', () => {
  it('lists files sorted, skipping hidden, generated, ignored and addon folders', () => {
    const project = makeTempProject({
      'scenes/main.tscn': '',
      'scripts/player.gd': '',
      'scripts/player.gd.uid': '',
      'icon.png': '',
      'icon.png.import': '',
      '.godot/cache': '',
      '.hidden/file.gd': '',
      'ignored/.gdignore': '',
      'ignored/x.gd': '',
      'addons/gut/gut.gd': '',
    });
    try {
      expect(walkProject(project.root, project.root, { includeAddons: false })).toEqual([
        'icon.png',
        'project.godot',
        'scenes/main.tscn',
        'scripts/player.gd',
      ]);
      expect(walkProject(project.root, project.root, { includeAddons: true })).toContain(
        'addons/gut/gut.gd',
      );
      expect(
        walkProject(project.root, `${project.root}/scripts`, { includeAddons: false }),
      ).toEqual(['scripts/player.gd']);
    } finally {
      project.cleanup();
    }
  });
});

describe('matchesType', () => {
  it('matches by extension, case-insensitively', () => {
    expect(matchesType('a/b.TSCN', 'scene')).toBe(true);
    expect(matchesType('a/b.gd', 'scene')).toBe(false);
    expect(matchesType('x.png', 'image')).toBe(true);
    expect(matchesType('anything', 'all')).toBe(true);
  });
});

describe('globToRegExp', () => {
  it.each([
    ['*.gd', 'scripts/player.gd', true],
    ['*.gd', 'player.gd', true],
    ['*player*', 'scenes/the_player_v2.tscn', true],
    ['scenes/*.tscn', 'scenes/main.tscn', true],
    ['scenes/*.tscn', 'scenes/sub/main.tscn', false],
    ['scenes/**/*.tscn', 'scenes/sub/deep/main.tscn', true],
    ['scenes/**/*.tscn', 'scenes/main.tscn', true],
    ['res://scenes/**', 'scenes/a/b', true],
    ['scripts/p?ayer.gd', 'scripts/player.gd', true],
    ['*.{png,svg}', 'icons/a.svg', true],
    ['*.{png,svg}', 'icons/a.jpg', false],
    ['a{b.gd', 'a{b.gd', true],
    ['file.gd', 'xfile.gd', false],
  ])('%s vs %s → %s', (glob, file, expected) => {
    expect(globToRegExp(glob).test(file)).toBe(expected);
  });
});
