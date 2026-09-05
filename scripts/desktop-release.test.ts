import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-release-test-'));
  roots.push(root);
  mkdirSync(join(root, 'src-tauri')); mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.2.0' }));
  writeFileSync(join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: '0.2.0' }));
  writeFileSync(join(root, 'src-tauri/Cargo.toml'), 'version = "0.2.0"\n');
  // Emulate only the build process, never a signing or installation proof.
  writeFileSync(join(root, 'bin/npm'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.copyFileSync(args[args.indexOf('--config') + 1], 'captured-config.json');
const dir = 'src-tauri/target/aarch64-apple-darwin/release/bundle/macos';
fs.mkdirSync(dir, {recursive: true});
fs.writeFileSync(dir + '/JARVIS.app.tar.gz', 'fixture archive');
fs.writeFileSync(dir + '/JARVIS.app.tar.gz.sig', 'fixture signature');
`, { mode: 0o755 });
  const publicKey = Buffer.from('untrusted comment: fixture public key\n' + Buffer.alloc(42).toString('base64') + '\n').toString('base64');
  const env = { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, JARVIS_UPDATE_BASE_URL: 'https://updates.example.com/jarvis', JARVIS_UPDATER_PUBLIC_KEY: publicKey, TAURI_SIGNING_PRIVATE_KEY: 'fixture-not-a-real-key' };
  return { root, env, run: (override = {}) => spawnSync(process.execPath, [resolve('scripts/desktop-release.mjs'), 'aarch64-apple-darwin'], { cwd: root, env: { ...env, ...override }, encoding: 'utf8' }) };
}
it('builds an architecture manifest with a stable endpoint and versioned archive URL', () => {
  const f = fixture(); const result = f.run();
  expect(result.status, result.stderr).toBe(0);
  const config = JSON.parse(readFileSync(join(f.root, 'captured-config.json'), 'utf8'));
  expect(config.plugins.updater.endpoints).toEqual(['https://updates.example.com/jarvis/{{target}}-{{arch}}/latest.json']);
  expect(config.bundle.createUpdaterArtifacts).toBe(true);
  expect(JSON.stringify(config)).not.toContain('fixture-not-a-real-key');
  const manifest = JSON.parse(readFileSync(join(f.root, 'artifacts/updates/darwin-aarch64/latest.json'), 'utf8'));
  expect(manifest).toMatchObject({ version: '0.2.0', platforms: { 'darwin-aarch64': { signature: 'fixture signature', url: 'https://updates.example.com/jarvis/darwin-aarch64/0.2.0/JARVIS.app.tar.gz' } } });
});
it.each([
  { JARVIS_UPDATE_BASE_URL: 'http://updates.example.com/' },
  { JARVIS_UPDATE_BASE_URL: 'https://user:password@updates.example.com/' },
  { JARVIS_UPDATER_PUBLIC_KEY: '/path/to/key.pub' },
  { TAURI_SIGNING_PRIVATE_KEY: '' },
])('fails closed for invalid release configuration %j', overrides => {
  const f = fixture(); expect(f.run(overrides).status).not.toBe(0);
});
it('rejects a version mismatch before building', () => {
  const f = fixture(); writeFileSync(join(f.root, 'src-tauri/Cargo.toml'), 'version = "0.1.0"\n');
  const result = f.run(); expect(result.status).not.toBe(0); expect(result.stderr).toContain('versions must match');
});
