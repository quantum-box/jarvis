import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(path, 'utf8');
const json = path => JSON.parse(read(path));
const capture = (path, pattern, label) => {
  const match = read(path).match(pattern);
  if (!match) throw new Error(`${label}のバージョンを読み取れません。`);
  return match[1];
};

const packageJson = json('package.json');
const packageLock = json('package-lock.json');
const versions = new Map([
  ['package.json', packageJson.version],
  ['package-lock.json', packageLock.version],
  ['package-lock.json packages[""]', packageLock.packages?.['']?.version],
  ['src-tauri/Cargo.toml', capture('src-tauri/Cargo.toml', /^version\s*=\s*"([^"]+)"/m, 'Cargo.toml')],
  ['src-tauri/Cargo.lock', capture('src-tauri/Cargo.lock', /\[\[package\]\]\nname = "jarvis"\nversion = "([^"]+)"/, 'Cargo.lock')],
  ['src-tauri/tauri.conf.json', json('src-tauri/tauri.conf.json').version],
  ['docs/desktop-release-notes.md', capture('docs/desktop-release-notes.md', /^JARVIS (\d+\.\d+\.\d+)です。/m, 'リリースノート')],
]);

const version = packageJson.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`安定版のバージョン形式ではありません: ${version}`);
}
const mismatches = [...versions].filter(([, candidate]) => candidate !== version);
if (mismatches.length) {
  throw new Error(`バージョンを${version}に揃えてください: ${mismatches.map(([path, candidate]) => `${path}=${candidate ?? 'missing'}`).join(', ')}`);
}

const baseSha = process.env.JARVIS_BASE_SHA?.trim();
const baseVersion = process.env.JARVIS_BASE_VERSION?.trim() || (baseSha
  ? JSON.parse(execFileSync('git', ['show', `${baseSha}:package.json`], { encoding: 'utf8' })).version
  : '');
if (baseVersion) {
  const parts = value => value.split('.').map(Number);
  const [current, base] = [parts(version), parts(baseVersion)];
  const increased = current.some((part, index) => part > base[index] && current.slice(0, index).every((value, prefix) => value === base[prefix]));
  if (!increased) throw new Error(`PRではバージョンを上げてください: ${baseVersion} → ${version}`);
}

console.log(`Release version ${version} is consistent${baseVersion ? ` and newer than ${baseVersion}` : ''}.`);
