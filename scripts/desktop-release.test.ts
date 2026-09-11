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
  writeFileSync(join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: '0.2.0', identifier: 'com.quantumbox.jarvis' }));
  writeFileSync(join(root, 'src-tauri/Cargo.toml'), 'version = "0.2.0"\n');
  writeFileSync(join(root, 'AuthKey_TEST.p8'), 'fixture private key');
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
  writeFileSync(join(root, 'bin/tar'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const output = args[args.indexOf('-C') + 1] + '/JARVIS.app/Contents';
fs.mkdirSync(output, {recursive: true});
fs.writeFileSync(output + '/Info.plist', 'fixture plist');
`, { mode: 0o755 });
  writeFileSync(join(root, 'bin/plutil'), `#!/usr/bin/env node
process.stdout.write('com.quantumbox.jarvis\\n');
`, { mode: 0o755 });
  writeFileSync(join(root, 'bin/codesign'), `#!/usr/bin/env node
if (process.argv.includes('-d')) process.stderr.write([
  'Identifier=com.quantumbox.jarvis',
  'Authority=Developer ID Application: Quantum Box, Inc. (J8429VCGMR)',
  'TeamIdentifier=J8429VCGMR',
].join('\\n') + '\\n');
`, { mode: 0o755 });
  writeFileSync(join(root, 'bin/spctl'), `#!/usr/bin/env node
process.stderr.write('source=Notarized Developer ID\\n');
`, { mode: 0o755 });
  writeFileSync(join(root, 'bin/xcrun'), '#!/usr/bin/env node\n', { mode: 0o755 });
  const publicKey = Buffer.from('untrusted comment: fixture public key\n' + Buffer.alloc(42).toString('base64') + '\n').toString('base64');
  const env = {
    ...process.env,
    PATH: `${join(root, 'bin')}:${process.env.PATH}`,
    JARVIS_UPDATE_BASE_URL: 'https://updates.example.com/jarvis',
    JARVIS_UPDATER_PUBLIC_KEY: publicKey,
    TAURI_SIGNING_PRIVATE_KEY: 'fixture-not-a-real-key',
    JARVIS_APPLE_SIGNING_IDENTITY: 'Developer ID Application: Quantum Box, Inc. (J8429VCGMR)',
    JARVIS_APPLE_TEAM_ID: 'J8429VCGMR',
    APPLE_API_KEY: 'TEST',
    APPLE_API_ISSUER: '00000000-0000-0000-0000-000000000000',
    APPLE_API_KEY_PATH: join(root, 'AuthKey_TEST.p8'),
  };
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
}, 15_000);
it.each([
  { JARVIS_UPDATE_BASE_URL: 'http://updates.example.com/' },
  { JARVIS_UPDATE_BASE_URL: 'https://user:password@updates.example.com/' },
  { JARVIS_UPDATER_PUBLIC_KEY: '/path/to/key.pub' },
  { TAURI_SIGNING_PRIVATE_KEY: '' },
  { JARVIS_APPLE_SIGNING_IDENTITY: '' },
  { JARVIS_APPLE_TEAM_ID: '' },
  { APPLE_API_KEY_PATH: join(tmpdir(), 'missing-jarvis-test-key.p8') },
])('fails closed for invalid release configuration %j', overrides => {
  const f = fixture(); expect(f.run(overrides).status).not.toBe(0);
});

it('does not copy an archive when notarized app verification fails', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'bin/spctl'), '#!/usr/bin/env node\nprocess.exit(1);\n', { mode: 0o755 });
  const result = f.run();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Notarized app verification failed');
  expect(() => readFileSync(join(f.root, 'artifacts/updates/darwin-aarch64/0.2.0/JARVIS.app.tar.gz'))).toThrow();
}, 15_000);
it('rejects a version mismatch before building', () => {
  const f = fixture(); writeFileSync(join(f.root, 'src-tauri/Cargo.toml'), 'version = "0.1.0"\n');
  const result = f.run(); expect(result.status).not.toBe(0); expect(result.stderr).toContain('versions must match');
});
it('uses GitHub Releases flat assets and a shared latest manifest URL', () => {
  const f = fixture(); const result = f.run({ JARVIS_UPDATE_BASE_URL: 'https://github.com/quantum-box/jarvis/releases/' });
  expect(result.status, result.stderr).toBe(0);
  const config = JSON.parse(readFileSync(join(f.root, 'captured-config.json'), 'utf8'));
  expect(config.plugins.updater.endpoints).toEqual(['https://github.com/quantum-box/jarvis/releases/latest/download/latest.json']);
  const manifest = JSON.parse(readFileSync(join(f.root, 'artifacts/updates/darwin-aarch64/manifest-darwin-aarch64.json'), 'utf8'));
  expect(manifest.platforms['darwin-aarch64'].url).toBe('https://github.com/quantum-box/jarvis/releases/download/v0.2.0/JARVIS_0.2.0_darwin-aarch64.app.tar.gz');
  expect(readFileSync(join(f.root, 'artifacts/updates/darwin-aarch64/JARVIS_0.2.0_darwin-aarch64.app.tar.gz'), 'utf8')).toBe('fixture archive');
}, 15_000);
