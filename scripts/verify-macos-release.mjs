import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const [appPath, expectedIdentifier, expectedIdentity, expectedTeamId] = process.argv.slice(2);
if (!appPath || !expectedIdentifier || !expectedIdentity || !expectedTeamId) {
  throw new Error('Usage: node scripts/verify-macos-release.mjs <app> <bundle-id> <identity> <team-id>');
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})${detail ? `: ${detail}` : ''}`);
  }
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

const infoPlist = `${appPath}/Contents/Info.plist`;
readFileSync(infoPlist);
const identifier = run('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPlist]).trim();
if (identifier !== expectedIdentifier) {
  throw new Error(`Unexpected CFBundleIdentifier: ${identifier || '(empty)'}`);
}
const microphoneUsageDescription = run(
  'plutil',
  ['-extract', 'NSMicrophoneUsageDescription', 'raw', '-o', '-', infoPlist],
).trim();
if (!microphoneUsageDescription) {
  throw new Error('NSMicrophoneUsageDescription must not be empty');
}

run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
// `:-` asks codesign for the raw plist; `-` renders a human-readable tree on current macOS.
const entitlements = spawnSync('codesign', ['-d', '--entitlements', ':-', appPath], { encoding: 'utf8' });
if (entitlements.status !== 0) {
  const detail = `${entitlements.stdout || ''}\n${entitlements.stderr || ''}`.trim();
  throw new Error(`Unable to read code-signing entitlements${detail ? `: ${detail}` : ''}`);
}
const audioInput = spawnSync(
  'plutil',
  ['-extract', 'com\\.apple\\.security\\.device\\.audio-input', 'raw', '-o', '-', '-'],
  { encoding: 'utf8', input: entitlements.stdout },
);
if (audioInput.status !== 0 || audioInput.stdout.trim() !== 'true') {
  throw new Error('Signed app must allow com.apple.security.device.audio-input');
}
const signature = run('codesign', ['-d', '--verbose=5', appPath]);
const fields = new Map(
  signature.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^([^=]+)=(.*)$/);
    return match ? [[match[1], match[2]]] : [];
  }),
);
if (fields.get('Identifier') !== expectedIdentifier) {
  throw new Error(`Code signature identifier does not match ${expectedIdentifier}`);
}
if (fields.get('TeamIdentifier') !== expectedTeamId) {
  throw new Error(`Code signature team does not match ${expectedTeamId}`);
}
if (process.platform === 'darwin' && fields.get('Page size') !== '4096') {
  throw new Error(`macOS code signature page size must be 4096 bytes, got ${fields.get('Page size') || '(missing)'}`);
}
const authorities = signature.split(/\r?\n/)
  .filter(line => line.startsWith('Authority='))
  .map(line => line.slice('Authority='.length));
if (!authorities.includes(expectedIdentity)) {
  throw new Error(`Code signature authority does not match ${expectedIdentity}`);
}

const assessment = run('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]);
if (!/source=Notarized Developer ID/i.test(assessment)) {
  throw new Error('Gatekeeper did not report a notarized Developer ID source');
}
run('xcrun', ['stapler', 'validate', appPath]);
console.log(`Verified notarized macOS release: ${appPath}`);
