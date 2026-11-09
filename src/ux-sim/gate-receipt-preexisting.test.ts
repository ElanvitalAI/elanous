import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeGate, sameHeadPreexistingFailureIds, type GateRunner } from '../../scripts/release-loop/gate-node';
import { gateBaselineReceipt, gateEnvFingerprint } from '../../scripts/release-loop/gate-baseline-receipt';
import { gateShardRuntimeIdentityKey, planGateShardDispatch, type GateShardReceipt } from '../../scripts/release-loop/gate-shard-dispatch';
const roots: string[] = [];
const head = 'a'.repeat(40), baseline = 'b'.repeat(40);
const pins = { graphSha: 'c'.repeat(64), recipeSha: 'd'.repeat(64) };
const digestA = `sha256:${'a'.repeat(64)}`, digestB = `sha256:${'b'.repeat(64)}`;
const baseImageDigest = `sha256:${'e'.repeat(64)}`;
const envFingerprint = gateEnvFingerprint({ ELANOUS_TEST_FAKE_LLM: '1' });
const runtimeIdentity = { bunVersion: Bun.version, platform: process.platform, architecture: process.arch, envFingerprint, baseImageDigest };
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'ux-sim-gate-receipt-')); roots.push(dir); return dir; };
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
test('same-head rerun persists and reads judged preexisting IDs from the production gate verdict', async () => {
 const dir = root(), instanceRoot = join(dir, 'instance'), ledgerRoot = join(dir, 'ledger');
 const version = '0.2.34', baselineVersion = '0.2.33';
 mkdirSync(join(instanceRoot, 'release', baselineVersion), { recursive: true });
 writeFileSync(join(instanceRoot, 'release', baselineVersion, 'release.json'), JSON.stringify({ sourceCommit: baseline }));
 writeFileSync(join(instanceRoot, 'release', baselineVersion, 'gate-failures.json'), JSON.stringify({ commit: baseline, failures: ['src/a.test.ts > stable'] }));
 const output = (ids: string[]) => ids.map((id) => { const split = id.indexOf(' > '); return `${id.slice(0, split)}:\n(fail) ${id.slice(split + 3)} [1.00ms]\n`; }).join('') + `\n${ids.length} fail\nRan ${Math.max(1, ids.length)} tests across ${Math.max(1, ids.length)} files.\n`;
  const runner: GateRunner = {
  async localCommand() { return { rc: 0, output: "" }; }, async command(cmd, args, cwd) { if (cmd === "bun" && args[0] === "run") { const file = args[2]!.replace("./", ""); const ids = cwd.endsWith("/cut") ? (file === "src/b.test.ts" ? ["src/b.test.ts > new"] : ["src/a.test.ts > stable"]) : file === "src/b.test.ts" ? [] : ["src/a.test.ts > stable"]; return { rc: ids.length ? 1 : 0, output: output(ids) }; } return { rc: 0, output: "" }; },
  async sweep(tree) { return { rc: 1, output: output(tree.endsWith('/cut') ? ['src/a.test.ts > stable', 'src/b.test.ts > new'] : ['src/a.test.ts > stable']) }; },
  async add() {}, async remove() {}, async snapshot() {}, async removeSnapshot() {},
 };
 const opts = { commit: head, version, baselineVersion, baselineCommit: baseline, instanceRoot, ledgerRoot };
 const first = await judgeGate(opts, runner), verdictPath = join(ledgerRoot, 'release', version, 'gate-verdict.json');
 expect(first).toMatchObject({ outcome: 'regression', introduced: ['src/b.test.ts > new'], preexisting: 1 });
 expect(JSON.parse(readFileSync(verdictPath, 'utf8'))).toMatchObject({ commit: head, baselineCommit: baseline, preexisting: ['src/a.test.ts > stable'] });
 expect(sameHeadPreexistingFailureIds(ledgerRoot, version, head, baseline)).toEqual(['src/a.test.ts > stable']);
 const resumed = await judgeGate(opts, runner);
 expect(resumed).toMatchObject({ outcome: 'regression', introduced: ['src/b.test.ts > new'], preexisting: 1 });
 expect(sameHeadPreexistingFailureIds(ledgerRoot, version, head, 'f'.repeat(40))).toBeUndefined();
});
test('the next same-head sweep reuses a failed shard only with the persisted preexisting verdict', () => {
 const dir = root(), version = '0.2.34', failure = 'src/a.test.ts > stable';
 const verdictPath = join(dir, 'release', version, 'gate-verdict.json');
 mkdirSync(join(dir, 'release', version), { recursive: true });
 const file = 'src/a.test.ts', imageDigest = digestA, lockfileHash = 'f'.repeat(64);
 const receipt: GateShardReceipt = {
  id: 'pod-0', files: [file], version, head40: head, base40: baseline,
  graphSha: pins.graphSha, recipeSha: pins.recipeSha, graphEntry: 'gate-entry-v1',
  recipeCommand: 'bun scripts/release-loop/gate-node.ts --json', recipeTimeoutMs: 14400000,
  host: 'gcp1', envKey: gateShardRuntimeIdentityKey(runtimeIdentity, lockfileHash)!,
  envFingerprint, imageDigest, runtimeIdentity, lockfileHash,
  testedFileHashes: { [file]: '1'.repeat(64) },
  executions: [{ branch: '', attemptId: 'first-sweep', host: 'gcp1', imageDigest, runtimeIdentity }],
  status: 'complete', failureIds: [failure], errorIds: [], evidencePath: 'pod-0.result.json',
  evidenceSha256: '2'.repeat(64), measuredAt: '2026-11-08T00:00:00.000Z', attempt: 1,
 };
 const plan = () => planGateShardDispatch({
  head40: head, base40: baseline, shards: [{ id: 'pod-0', files: [file] }], receipts: [receipt],
  hosts: [{ id: 'gcp1', platform: process.platform === 'linux' ? 'linux' : process.platform === 'darwin' ? 'darwin' : 'other', available: true, reserved: false }],
  graphEntry: receipt.graphEntry, recipeCommand: receipt.recipeCommand, recipeTimeoutMs: receipt.recipeTimeoutMs,
  environmentIdentity: { ...runtimeIdentity, imageDigest }, lockfileHash,
  testedFileHashesByShard: { 'pod-0': receipt.testedFileHashes! },
  sameHeadPreexistingFailureIds: sameHeadPreexistingFailureIds(dir, version, head, baseline),
 });
 expect(plan().map(({ kind }) => kind)).toEqual(['run']);
 writeFileSync(verdictPath, JSON.stringify({ commit: head, baselineCommit: baseline, outcome: 'regression',
  preexisting: [failure], introduced: ['src/b.test.ts > new'] }));
 expect(plan().map(({ kind }) => kind)).toEqual(['reuse']);
 writeFileSync(verdictPath, JSON.stringify({ commit: head, baselineCommit: 'c'.repeat(40), outcome: 'regression',
  preexisting: [failure], introduced: [] }));
 expect(plan().map(({ kind }) => kind)).toEqual(['run']);
});
test('a different Pod image digest cannot mint or reuse the baseline receipt', () => {
 const dir = root(), logs = join(dir, 'release', '0.2.34', 'gate-logs', 'cut'); mkdirSync(logs, { recursive: true });
 const row = (index: number, imageDigest: string) => writeFileSync(join(logs, `pod-${index}.json`), JSON.stringify({ commit: head, files: [`${index ? 'b' : 'a'}.test.ts`], shardCount: 2, sweepId: 'sweep-current', attemptId: `attempt-${index}`, imageDigest, runtimeIdentity }));
 row(0, digestA); row(1, digestA);
 const input = { root: dir, version: '0.2.34', commit: head, fullSweep: true, graphPins: pins, envFingerprint };
 expect(gateBaselineReceipt(input)).toMatchObject({ valid: true, imageDigest: digestA, shards: 2 });
 row(1, digestB);
 expect(gateBaselineReceipt(input)).toMatchObject({ valid: false, reason: 'cut Pods used different image digests' });
});
