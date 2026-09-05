import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] || 'artifacts/updates');
const output = resolve(process.argv[3] || 'artifacts/release');
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Only stable release versions can update the latest channel');
const base = new URL(process.env.JARVIS_UPDATE_BASE_URL || '');
const repository = process.env.GITHUB_REPOSITORY || 'quantum-box/jarvis';
if (base.href !== `https://github.com/${repository}/releases/`) throw new Error('Release base URL must match the publishing repository');
const manifest = { version, notes: process.env.JARVIS_RELEASE_NOTES || readFileSync('docs/desktop-release-notes.md', 'utf8'), pub_date: new Date().toISOString(), platforms: {} };
const files = [];
for (const platform of ['darwin-aarch64', 'darwin-x86_64']) {
  const dir = join(root, platform);
  const part = JSON.parse(readFileSync(join(dir, `manifest-${platform}.json`), 'utf8'));
  const archive = `JARVIS_${version}_${platform}.app.tar.gz`;
  const entry = part.platforms?.[platform];
  const signature = readFileSync(join(dir, `${archive}.sig`), 'utf8').trim();
  if (part.version !== version || Object.keys(part.platforms || {}).length !== 1 || !entry || !signature || entry.signature !== signature || entry.url !== new URL(`download/v${version}/${archive}`, base).href || !existsSync(join(dir, archive))) {
    throw new Error(`Invalid release artifacts for ${platform}`);
  }
  manifest.platforms[platform] = entry;
  files.push([join(dir, archive), archive], [join(dir, `${archive}.sig`), `${archive}.sig`]);
}
// Publish nothing until both architectures have passed validation.
mkdirSync(output, { recursive: true });
for (const [source, name] of files) copyFileSync(source, join(output, name));
writeFileSync(join(output, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Assembled release v${version} with both macOS architectures`);
