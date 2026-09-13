import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(version = '0.1.11') {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-version-test-'));
  roots.push(root);
  mkdirSync(join(root, 'src-tauri'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ version, packages: { '': { version } } }));
  writeFileSync(join(root, 'src-tauri/Cargo.toml'), `[package]\nname = "jarvis"\nversion = "${version}"\n`);
  writeFileSync(join(root, 'src-tauri/Cargo.lock'), `[[package]]\nname = "jarvis"\nversion = "${version}"\n`);
  writeFileSync(join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ version }));
  writeFileSync(join(root, 'docs/desktop-release-notes.md'), `JARVIS ${version}です。\n`);
  const run = (env: Record<string, string> = {}) => spawnSync(
    process.execPath,
    [resolve('scripts/check-release-version.mjs')],
    { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8' },
  );
  return { root, run };
}

it('accepts matching release files and a newer PR version', () => {
  const result = fixture().run({ JARVIS_BASE_VERSION: '0.1.10' });
  expect(result.status, result.stderr).toBe(0);
});

it('rejects a PR without a version bump', () => {
  const result = fixture().run({ JARVIS_BASE_VERSION: '0.1.11' });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('PRではバージョンを上げてください');
});

it('rejects inconsistent release files', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: '0.1.10' }));
  const result = f.run();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('src-tauri/tauri.conf.json=0.1.10');
});
