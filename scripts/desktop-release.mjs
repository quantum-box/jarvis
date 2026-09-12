import { readFileSync, writeFileSync, mkdirSync, copyFileSync, mkdtempSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));

// One architecture per invocation. GitHub Releases use flat assets and a combined manifest.
const target = process.argv[2];
if (!['aarch64-apple-darwin', 'x86_64-apple-darwin'].includes(target)) {
  throw new Error('Usage: npm run release:desktop -- <aarch64-apple-darwin|x86_64-apple-darwin>');
}
const base = new URL(process.env.JARVIS_UPDATE_BASE_URL || '');
if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
  throw new Error('JARVIS_UPDATE_BASE_URL must be an HTTPS directory URL without credentials, query, or fragment');
}
base.pathname = base.pathname.replace(/\/?$/, '/');
const pubkey = process.env.JARVIS_UPDATER_PUBLIC_KEY?.trim();
if (!pubkey || !process.env.TAURI_SIGNING_PRIVATE_KEY) throw new Error('Updater public key and signing private key are required');
const appleIdentity = process.env.JARVIS_APPLE_SIGNING_IDENTITY?.trim();
const appleTeamId = process.env.JARVIS_APPLE_TEAM_ID?.trim();
if (!appleIdentity || !appleTeamId) throw new Error('Apple signing identity and team ID are required');
if (!process.env.APPLE_API_KEY || !process.env.APPLE_API_ISSUER || !process.env.APPLE_API_KEY_PATH) {
  throw new Error('App Store Connect API key ID, issuer, and private key path are required');
}
if (!existsSync(process.env.APPLE_API_KEY_PATH)) throw new Error('App Store Connect private key file does not exist');
// Reject accidentally passing a private key or path as the public key.
const publicLines = Buffer.from(pubkey, 'base64').toString('utf8').trim().split('\n');
if (!publicLines[0]?.startsWith('untrusted comment:') || Buffer.from(publicLines[1] || '', 'base64').length !== 42) {
  throw new Error('JARVIS_UPDATER_PUBLIC_KEY must contain a Tauri public key, not a path');
}
const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8').match(/^version = "([^"]+)"/m)?.[1];
if (config.version !== pkg.version || cargo !== pkg.version) throw new Error('package.json, Cargo.toml and tauri.conf.json versions must match');
const arch = target.split('-')[0];
const platform = `darwin-${arch}`;
const githubReleases = base.hostname === 'github.com' && /^\/[^/]+\/[^/]+\/releases\/$/.test(base.pathname);
const archiveName = `JARVIS_${pkg.version}_${platform}.app.tar.gz`;
const endpoint = githubReleases
  ? new URL('latest/download/latest.json', base).href
  : new URL('{{target}}-{{arch}}/latest.json', base).href.replaceAll('%7B', '{').replaceAll('%7D', '}');
const archiveUrl = githubReleases
  ? new URL(`download/v${pkg.version}/${archiveName}`, base).href
  : new URL(`${platform}/${pkg.version}/JARVIS.app.tar.gz`, base).href;
const temp = mkdtempSync(join(tmpdir(), 'jarvis-release-'));
try {
  // macOS 26 Tahoe's AMFI has compatibility problems loading 16 KiB
  // code-signature pages for larger native binaries. Keep the signing
  // invocation explicit so the signed app works on both current and older
  // macOS runners. The wrapper only changes signing calls; verification and
  // notarization commands continue to use the system codesign unchanged.
  const codesignPageSize = process.platform === 'darwin'
    ? (process.env.JARVIS_CODESIGN_PAGE_SIZE || '4096')
    : '';
  const buildEnv = { ...process.env };
  if (codesignPageSize && codesignPageSize !== 'off') {
    if (!/^\d+$/.test(codesignPageSize)) throw new Error('JARVIS_CODESIGN_PAGE_SIZE must be numeric or off');
    const codesignWrapper = join(temp, 'codesign');
    writeFileSync(codesignWrapper, '#!/bin/sh\nset -eu\nfor arg in "$@"; do\n  case "$arg" in\n    --sign|-s|--sign=*|-s?*)\n      exec /usr/bin/codesign --pagesize=' + codesignPageSize + ' "$@"\n      ;;\n  esac\ndone\nexec /usr/bin/codesign "$@"\n');
    chmodSync(codesignWrapper, 0o755);
    buildEnv.PATH = `${temp}:${process.env.PATH || ''}`;
  }
  const configPath = join(temp, 'updater.json');
  writeFileSync(configPath, JSON.stringify({ bundle: { createUpdaterArtifacts: true }, plugins: { updater: { pubkey, endpoints: [endpoint] } } }));
  const build = spawnSync('npm', ['run', 'tauri', 'build', '--', '--ci', '--target', target, '--bundles', 'app', '--config', configPath, '--', '--locked'], {
    stdio: 'inherit',
    env: { ...buildEnv, APPLE_SIGNING_IDENTITY: appleIdentity },
  });
  if (build.status !== 0) throw new Error(`Tauri build failed (${build.status})`);
  const bundle = resolve(`src-tauri/target/${target}/release/bundle/macos/JARVIS.app.tar.gz`);
  const extracted = join(temp, 'archive');
  mkdirSync(extracted);
  const unpack = spawnSync('tar', ['-xzf', bundle, '-C', extracted], { stdio: 'inherit' });
  if (unpack.status !== 0) throw new Error(`Updater archive extraction failed (${unpack.status})`);
  const archivedApp = join(extracted, 'JARVIS.app');
  if (!existsSync(archivedApp)) throw new Error('Updater archive does not contain JARVIS.app');
  const verify = spawnSync(process.execPath, [join(scriptDir, 'verify-macos-release.mjs'), archivedApp, config.identifier, appleIdentity, appleTeamId], { stdio: 'inherit' });
  if (verify.status !== 0) throw new Error(`Notarized app verification failed (${verify.status})`);
  const output = resolve(`artifacts/updates/${platform}`);
  const archiveDir = githubReleases ? output : join(output, pkg.version);
  const outputArchiveName = githubReleases ? archiveName : 'JARVIS.app.tar.gz';
  mkdirSync(archiveDir, { recursive: true });
  copyFileSync(bundle, join(archiveDir, outputArchiveName));
  copyFileSync(`${bundle}.sig`, join(archiveDir, `${outputArchiveName}.sig`));
  const signature = readFileSync(`${bundle}.sig`, 'utf8').trim();
  if (!signature) throw new Error('Missing updater signature');
  writeFileSync(join(output, githubReleases ? `manifest-${platform}.json` : 'latest.json'), JSON.stringify({
    version: pkg.version,
    notes: process.env.JARVIS_RELEASE_NOTES || '',
    pub_date: new Date().toISOString(),
    platforms: { [platform]: { signature, url: archiveUrl } },
  }, null, 2) + '\n');
  console.log(`Signed update artifacts: ${output}`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
