import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-assemble-test-')); roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.2.0' }));
  mkdirSync(join(root, 'docs')); writeFileSync(join(root, 'docs/desktop-release-notes.md'), 'Release notes');
  for (const platform of ['darwin-aarch64', 'darwin-x86_64']) {
    const dir = join(root, 'artifacts/updates', platform); mkdirSync(dir, { recursive: true });
    const archive = `JARVIS_0.2.0_${platform}.app.tar.gz`;
    writeFileSync(join(dir, archive), 'fixture archive'); writeFileSync(join(dir, `${archive}.sig`), 'fixture signature');
    writeFileSync(join(dir, `manifest-${platform}.json`), JSON.stringify({ version: '0.2.0', platforms: { [platform]: { signature: 'fixture signature', url: `https://github.com/quantum-box/jarvis/releases/download/v0.2.0/${archive}` } } }));
  }
  return { root, run: () => spawnSync(process.execPath, [resolve('scripts/assemble-desktop-release.mjs')], { cwd: root, env: { ...process.env, GITHUB_REPOSITORY: 'quantum-box/jarvis', JARVIS_UPDATE_BASE_URL: 'https://github.com/quantum-box/jarvis/releases/' }, encoding: 'utf8' }) };
}
it('combines both architectures and release notes before publication', () => {
  const f = fixture(); const result = f.run(); expect(result.status, result.stderr).toBe(0);
  const manifest = JSON.parse(readFileSync(join(f.root, 'artifacts/release/latest.json'), 'utf8'));
  expect(Object.keys(manifest.platforms)).toEqual(['darwin-aarch64', 'darwin-x86_64']);
  expect(manifest.notes).toBe('Release notes');
  for (const platform of Object.keys(manifest.platforms)) expect(existsSync(join(f.root, `artifacts/release/JARVIS_0.2.0_${platform}.app.tar.gz`))).toBe(true);
});
it.each(['version', 'signature', 'url', 'platform'] as const)('rejects mismatched %s without creating publishable output', kind => {
  const f = fixture(); const path = join(f.root, 'artifacts/updates/darwin-x86_64/manifest-darwin-x86_64.json');
  const part = JSON.parse(readFileSync(path, 'utf8'));
  if (kind === 'version') part.version = '0.1.0';
  if (kind === 'signature') part.platforms['darwin-x86_64'].signature = 'different signature';
  if (kind === 'url') part.platforms['darwin-x86_64'].url = 'https://example.com/untrusted.tar.gz';
  if (kind === 'platform') part.platforms['windows-x86_64'] = part.platforms['darwin-x86_64'];
  writeFileSync(path, JSON.stringify(part));
  expect(f.run().status).not.toBe(0); expect(existsSync(join(f.root, 'artifacts/release/latest.json'))).toBe(false);
});
it('rejects missing architecture artifacts', () => {
  const f = fixture(); rmSync(join(f.root, 'artifacts/updates/darwin-x86_64'), { recursive: true });
  expect(f.run().status).not.toBe(0);
});
