import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('Windows packaging native dependency boundary', () => {
  it('rebuilds only the required SQLite addon before packaging', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(desktopDir, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };

    for (const scriptName of ['build:dir', 'build:win']) {
      const script = packageJson.scripts[scriptName];
      expect(script).toContain('electron-rebuild -f --only better-sqlite3 --types prod');
      expect(script).not.toContain('--only canvas');
    }
  });

  it('disables broad native rebuilds and excludes optional canvas from the app', () => {
    const builderConfig = readFileSync(
      resolve(desktopDir, 'electron-builder.yml'),
      'utf8',
    );

    expect(builderConfig).toMatch(/^npmRebuild:\s*false$/m);
    expect(builderConfig).toContain('- "!node_modules/canvas/**/*"');
  });
});
