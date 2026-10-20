import { existsSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { getUserConfig } from '../../src/user-config.js';
import { isPodImageCommit } from '../../src/task-orchestrator/surfaces/pod-image-source.js';
import { debug } from '../../src/debug/log.js';

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => v && typeof v === 'object' && !Array.isArray(v) ? v as Rec : {};
const sha = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{40}$/i.test(v);
const emit = (outcome: string, result: Rec, evidence: Rec) => {
  debug.log('harness.journey', 'reflect.exit', { outcome, reason: result.reason ?? null, ...evidence });
  console.log(JSON.stringify({ outcome, result, evidence }));
};

async function main() {
try {
  const contextPath = process.env.ELANOUS_GRAPH_CONTEXT;
  if (!contextPath) throw new Error('ELANOUS_GRAPH_CONTEXT missing');
  const envelope = rec(JSON.parse(readFileSync(contextPath, 'utf8')));
  debug.log('harness.journey', 'reflect.enter', { runId: envelope.runId ?? null, nodeId: envelope.nodeId ?? 'reflect' });
  const input = rec(envelope.input);
  const context = rec(input.context);
  const prior = rec(input.prior);
  const landed = context.landedSha ?? context.commit;
  if (!sha(landed)) throw new Error('context.landedSha must be a full commit SHA');
  const attempts = Number(rec(prior.result).attempts ?? prior.attempts ?? 0);
  const maxAttempts = Number(context.maxAttempts ?? 3);
  if (!Number.isInteger(attempts) || attempts < 0 || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error('invalid bounded retry counters');

  // Root overrides are accepted only in an isolated test universe, never from
  // a production graph envelope that could forge an installed/pinned identity.
  const isolated = process.env.NODE_ENV === 'test' || Boolean(process.env.ELANOUS_TEST_HOME?.trim());
  if (!isolated && (context.installRoot || context.sourceRoot || context.configPath)) throw new Error('identity override requires test universe');
  const root = resolve(isolated && typeof context.installRoot === 'string' ? context.installRoot : join(homedir(), '.local', 'share', 'elanous'));
  const installRecord = join(root, 'install.json');
  if (!existsSync(installRecord)) throw new Error(`install record missing: ${installRecord}`);
  const installed = rec(JSON.parse(readFileSync(installRecord, 'utf8')));
  const source = isolated && typeof context.sourceRoot === 'string' ? resolve(context.sourceRoot) : typeof installed.source === 'string' ? resolve(installed.source) : '';
  const currentLink = join(root, 'current');
  if (!source || !existsSync(currentLink)) throw new Error('installed source/current identity unknown');
  const currentPath = realpathSync(currentLink);
  const versionDir = installed.versionDir;
  if (typeof versionDir !== 'string' || !/^versions\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(versionDir) ||
      readlinkSync(currentLink) !== versionDir || realpathSync(join(root, versionDir)) !== currentPath) {
    throw new Error('current symlink does not match install.json versionDir');
  }
  const entryPath = join(currentPath, 'node_modules', 'elanous', 'bin', 'elanous.mjs');
  if (!existsSync(entryPath) || !realpathSync(entryPath).startsWith(`${currentPath}/`)) {
    throw new Error('installed current entry missing or points outside current');
  }
  const currentCommit = installed.commit;
  if (!sha(currentCommit)) throw new Error('install.json commit missing/invalid');
  // The installer records the identity in three independent positions: the
  // version directory name, the root record and a copy inside that version.
  // A stale or forged root record alone cannot attest the installed entry.
  if (!versionDir.toLowerCase().endsWith(`-${currentCommit.slice(0, 12).toLowerCase()}`)) {
    throw new Error('installed version name does not match recorded commit');
  }
  const inside = rec(JSON.parse(readFileSync(join(currentPath, 'install.json'), 'utf8')));
  if (inside.versionDir !== versionDir || inside.commit !== currentCommit) {
    throw new Error('current install identity does not match root record');
  }
  // Pin provenance is the live config, never the untrusted graph input.
  const configPath = isolated && typeof context.configPath === 'string' ? resolve(context.configPath) : undefined;
  const pin = getUserConfig(configPath).harness?.imageCommit;
  if (!isPodImageCommit(pin)) throw new Error('harness.imageCommit pin missing/invalid');
  const git = spawnSync('git', ['-C', source, 'merge-base', '--is-ancestor', landed, currentCommit], { encoding: 'utf8' });
  if (git.error || git.status !== 0 && git.status !== 1) throw new Error(`installed ancestry cannot be verified: ${git.stderr || git.error?.message || git.status}`);
  const landedInstalled = git.status === 0;
  // The image pin may be a 12-digit abbreviation: resolve it to a unique
  // commit before checking ancestry, never compare abbreviated strings.
  const expanded = spawnSync('git', ['-C', source, 'rev-parse', '--verify', `${pin.trim()}^{commit}`], { encoding: 'utf8' });
  if (expanded.error || expanded.status !== 0 || !sha(expanded.stdout.trim())) throw new Error('harness pin commit cannot be resolved');
  const pinCommit = expanded.stdout.trim();
  const pinCheck = spawnSync('git', ['-C', source, 'merge-base', '--is-ancestor', landed, pinCommit], { encoding: 'utf8' });
  if (pinCheck.error || pinCheck.status !== 0 && pinCheck.status !== 1) throw new Error(`harness pin ancestry cannot be verified: ${pinCheck.stderr || pinCheck.error?.message || pinCheck.status}`);
  const matchesPin = pinCheck.status === 0;
  const evidence = { landedSha: landed, installedCommit: currentCommit, harnessImageCommit: pin, pinCommit, currentPath, installRecord, installedSource: source, attempts, maxAttempts };
  if (landedInstalled && matchesPin) return emit('done', { reflected: true, attempts }, evidence);
  if (attempts + 1 < maxAttempts) return emit('wait', { reflected: false, attempts: attempts + 1, reason: !landedInstalled ? 'not-installed-yet' : 'image-pin-not-yet-reflecting' }, { ...evidence, attempts: attempts + 1, retryAfterSeconds: 60 });
  return emit('needs-human', { reflected: false, attempts: attempts + 1, reason: !landedInstalled ? 'landed-sha-not-in-installed-current' : 'landed-sha-not-in-harness-image-pin' }, { ...evidence, attempts: attempts + 1 });
} catch (error) {
  emit('needs-human', { reflected: false, reason: error instanceof Error ? error.message : String(error) }, { failClosed: true });
}
}
void main();
