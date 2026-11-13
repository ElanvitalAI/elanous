import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Message } from '../msg/msg-store.js';
import type { GraphRunState } from './runner-types.js';
import { assertPwaMailWaiver, isOperationalPwaMailSource, PWA_POLICY_SHA256, pwaMailPaths, pwaMailRowSha256 } from './release-pwa-mail-waiver.js';
import { assertSignedPwaBranchWaiver } from './release-pwa-waiver.js';
import { openMsgStore } from '../msg/msg-store.js';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const runId = '63f6b4e1-new-run';
const childRun = 'child-new-run';
const cut = 'a'.repeat(40);
const version = '0.3.15';
const output = JSON.stringify({ outcome: 'fail', verdict: 'fail', commit: cut, withCostly: false,
  cells: [...['T1', 'T1b', 'T4a', 'T5', 'T5b', 'C2a', 'C2b'].map(id => ({ id, first: 'pass', final: 'pass', reruns: [] })),
    ...['N1', 'N5a', 'N6a'].map(id => ({ id, first: 'fail', final: 'fail', reruns: ['fail', 'fail'] }))] });

test('fresh PWA waiver requires exact current child raw and ordered immutable JUD/OP mail rows', () => {
  const root = mkdtempSync(join(tmpdir(), 'pwa-mail-waiver-'));
  const put = (path: string, data: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); };
  try {
    const state = { graphId: 'release-loop', runId, status: 'failed', dryRun: false,
      input: { version }, path: ['version-release', 'traffic-gate-passed', 'pre-prepare-join'],
      nodes: [{ nodeId: 'version-release', output: JSON.stringify({ commit: cut }) },
        { nodeId: 'pre-prepare-join', ok: false }],
      fanOuts: { 'traffic-gate-passed:ok': { from: 'traffic-gate-passed', join: 'pre-prepare-join', branches: {
        pwa: { runId: childRun, status: 'failed', output },
        'export-check': { runId: 'export-child', status: 'done' },
        'mac-smoke': { runId: 'mac-child', status: 'done' },
      } } },
    } as unknown as GraphRunState;
    const child = JSON.stringify({ graphId: 'release-loop', runId: childRun, status: 'failed',
      nodes: [{ nodeId: 'pwa', output }] });
    put(join(root, 'graph-runs/release-loop', `${childRun}.json`), child);
    const paired = 'baseline same-host N1 N5a N6a failed; new failures 0\n';
    const pairedPath = 'REL/evidence/pwa-new/paired.log';
    const proofPath = 'JUD/evidence/pwa-new/independent.json';
    put(join(root, 'seat-state', pairedPath), paired);
    const proof = JSON.stringify({ runId, cut, childRun, childStateSha256: hash(child),
      pairedLogSha256: hash(paired), observedNewFailureIds: [] });
    put(join(root, 'seat-state', proofPath), proof);
    const issuedAt = new Date(Date.now() - 60_000).toISOString();
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const packet = JSON.stringify({ schemaVersion: 1, runId, version, cut, childRun,
      childStateSha256: hash(child), policySha256: PWA_POLICY_SHA256, issuedAt, expiresAt,
      pairedLog: { path: pairedPath, sha256: hash(paired) },
      independentProof: { path: proofPath, sha256: hash(proof) } });
    const packetSha256 = hash(packet);
    const paths = pwaMailPaths(root, version, runId, packetSha256);
    const jud: Message = { id: 11, from: 'JUD', to: 'REL', kind: 'coord',
      body: `DISPOSITION-ATTEST ${packetSha256} ${PWA_POLICY_SHA256} ${runId}`,
      createdAt: new Date(Date.now() - 30_000).toISOString(), provenance: { universe: 'prod', source: 'real' } };
    const op: Message = { id: 12, from: 'OP', to: 'REL', kind: 'coord',
      body: `DISPOSITION-APPROVE ${packetSha256}`,
      createdAt: new Date(Date.now() - 20_000).toISOString(), provenance: { universe: 'prod', source: 'real' } };
    const pin = { schemaVersion: 1, packetSha256, judMessageId: 11, opMessageId: 12,
      judMessageSha256: pwaMailRowSha256(jud), opMessageSha256: pwaMailRowSha256(op) };
    put(paths.packet, packet);
    put(paths.pin, JSON.stringify(pin));
    const lookup = (id: number) => id === 11 ? jud : id === 12 ? op : null;
    expect(assertPwaMailWaiver(state, root, false, lookup)).toMatchObject({ packetSha256,
      judMessageSha256: pin.judMessageSha256, pairedLogSha256: hash(paired) });
    expect(assertSignedPwaBranchWaiver(state, root, false, lookup)).toEqual({ documentSha256: packetSha256,
      signatureSha256: pin.judMessageSha256, pairedLogSha256: hash(paired) });
    expect(() => assertPwaMailWaiver({ ...state, runId: 'different-run' }, root, false, lookup)).toThrow();
    expect(() => assertPwaMailWaiver({ ...state, input: { version, cutCommit: 'b'.repeat(40) } }, root, false, lookup)).toThrow();
    const withoutSibling = structuredClone(state);
    delete withoutSibling.fanOuts!['traffic-gate-passed:ok']!.branches['export-check'];
    expect(() => assertPwaMailWaiver(withoutSibling, root, false, lookup)).toThrow('saved failed fan-out');
    const failedSibling = structuredClone(state);
    failedSibling.fanOuts!['traffic-gate-passed:ok']!.branches['mac-smoke']!.status = 'failed';
    expect(() => assertPwaMailWaiver(failedSibling, root, false, lookup)).toThrow('saved failed fan-out');
    expect(() => assertPwaMailWaiver(state, root, false, id => id === 12 ? null : lookup(id))).toThrow('mail proof');
    expect(() => assertPwaMailWaiver(state, root, false, id => id === 12 ? { ...op, body: 'forged' } : lookup(id))).toThrow('mail proof');
    expect(() => assertPwaMailWaiver(state, root, false, id => id === 11 ? { ...jud, provenance: undefined } : lookup(id))).toThrow('mail proof');
    expect(() => assertPwaMailWaiver(state, root, false, id => id === 11 ? { ...jud, provenance: { universe: 'sim', source: 'sim', device: 'test' } } : lookup(id))).toThrow('mail proof');
    expect(() => assertPwaMailWaiver(state, root, false, id => id === 12 ? { ...op, provenance: { universe: 'prod', source: 'real', device: 'other' } } : lookup(id))).toThrow('mail proof');
    const nullJud = { ...jud, provenance: undefined };
    const nullOp = { ...op, provenance: undefined };
    const nullPin = { ...pin, judMessageSha256: pwaMailRowSha256(nullJud),
      opMessageSha256: pwaMailRowSha256(nullOp) };
    put(paths.pin, JSON.stringify(nullPin));
    expect(() => assertPwaMailWaiver(state, root, false,
      id => id === 11 ? nullJud : id === 12 ? nullOp : null)).toThrow('mail proof');
    put(paths.pin, JSON.stringify(pin));
    put(join(root, 'seat-state', pairedPath), 'tampered');
    expect(() => assertPwaMailWaiver(state, root, false, lookup)).toThrow('paired raw');
    put(join(root, 'seat-state', pairedPath), paired);
    state.fanOuts!['traffic-gate-passed:ok']!.branches.pwa!.waiver = { verdict: 'waived', decidedBy: 'OP',
      reason: 'known issue', documentSha256: packetSha256, signatureSha256: pin.judMessageSha256,
      pairedLogSha256: hash(paired), originalStatus: 'failed' };
    expect(assertPwaMailWaiver(state, root, true, lookup).packetSha256).toBe(packetSha256);
    expect(assertSignedPwaBranchWaiver(state, root, true, lookup).documentSha256).toBe(packetSha256);
    state.fanOuts!['traffic-gate-passed:ok']!.branches.pwa!.waiver!.signatureSha256 = 'b'.repeat(64);
    expect(() => assertPwaMailWaiver(state, root, true, lookup)).toThrow('saved waiver differs');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('null provenance is authorized only by IDs read from the operational instance mail DB', () => {
  const home = mkdtempSync(join(tmpdir(), 'pwa-live-home-'));
  const root = join(home, '.elanous');
  try {
    const put = (path: string, data: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); };
    const state = { graphId: 'release-loop', runId, status: 'failed', dryRun: false,
      input: { version }, path: ['version-release', 'traffic-gate-passed', 'pre-prepare-join'],
      nodes: [{ nodeId: 'version-release', output: JSON.stringify({ commit: cut }) },
        { nodeId: 'pre-prepare-join', ok: false }],
      fanOuts: { 'traffic-gate-passed:ok': { from: 'traffic-gate-passed', join: 'pre-prepare-join', branches: {
        pwa: { runId: childRun, status: 'failed', output },
        'export-check': { runId: 'export-child', status: 'done' },
        'mac-smoke': { runId: 'mac-child', status: 'done' },
      } } },
    } as unknown as GraphRunState;
    const child = JSON.stringify({ graphId: 'release-loop', runId: childRun, status: 'failed',
      nodes: [{ nodeId: 'pwa', output }] });
    put(join(root, 'graph-runs/release-loop', `${childRun}.json`), child);
    const pairedPath = 'REL/evidence/pwa-new/paired.log';
    const proofPath = 'JUD/evidence/pwa-new/independent.json';
    const paired = 'same-host baseline N1 N5a N6a; new failures zero\n';
    const proof = JSON.stringify({ runId, cut, childRun, childStateSha256: hash(child),
      pairedLogSha256: hash(paired), observedNewFailureIds: [] });
    put(join(home, 'elanous-hq', 'seat-state', pairedPath), paired);
    put(join(home, 'elanous-hq', 'seat-state', proofPath), proof);
    const issuedAt = new Date(Date.now() - 60_000).toISOString();
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const packet = JSON.stringify({ schemaVersion: 1, runId, version, cut, childRun,
      childStateSha256: hash(child), policySha256: PWA_POLICY_SHA256, issuedAt, expiresAt,
      pairedLog: { path: pairedPath, sha256: hash(paired) },
      independentProof: { path: proofPath, sha256: hash(proof) } });
    const packetSha256 = hash(packet);
    const paths = pwaMailPaths(root, version, runId, packetSha256);
    put(paths.packet, packet);
    const store = openMsgStore(join(root, 'msg', 'messages.db'));
    const jud = store.post({ from: 'JUD', to: 'REL', kind: 'coord',
      body: `DISPOSITION-ATTEST ${packetSha256} ${PWA_POLICY_SHA256} ${runId}` });
    const op = store.post({ from: 'OP', to: 'REL', kind: 'coord', body: `DISPOSITION-APPROVE ${packetSha256}` });
    store.close();
    expect(jud.provenance).toBeUndefined();
    const pin = { schemaVersion: 1, packetSha256, judMessageId: jud.id, opMessageId: op.id,
      judMessageSha256: pwaMailRowSha256(jud), opMessageSha256: pwaMailRowSha256(op) };
    expect(pin.judMessageSha256).toBe(hash(JSON.stringify([jud.id, jud.from, jud.to,
      jud.kind, jud.body, jud.createdAt, null])));
    put(paths.pin, JSON.stringify(pin));
    const stateFile = join(home, 'state.json');
    put(stateFile, JSON.stringify(state));
    const childScript = `import { readFileSync } from 'node:fs';
      import { assertPwaMailWaiver } from './src/graph-runner/release-pwa-mail-waiver.ts';
      const state = JSON.parse(readFileSync(process.env.PWA_STATE_FILE, 'utf8'));
      assertPwaMailWaiver(state, process.env.PWA_TEST_ROOT, false);`;
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, NODE_ENV: 'production', PWA_STATE_FILE: stateFile, PWA_TEST_ROOT: root };
    delete env.ELANOUS_STATE_DIR;
    delete env.ELANOUS_UNIVERSE;
    delete env.ELANOUS_SIM_UNIVERSE;
    delete env.ELANOUS_UX_SIM_RUN_ID;
    const run = (override: Record<string, string> = {}) => spawnSync(process.execPath, ['-e', childScript], {
      cwd: join(import.meta.dir, '../..'), env: { ...env, ...override }, encoding: 'utf8' });
    expect(isOperationalPwaMailSource(root, root, root, join(root, 'msg/messages.db'), false, 'prod')).toBe(true);
    expect(run().status).toBe(0);
    expect(run({ NODE_ENV: 'test' }).status).not.toBe(0);
    expect(run({ ELANOUS_STATE_DIR: join(home, 'other-instance') }).status).not.toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
