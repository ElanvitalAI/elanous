import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendImageLedgerEvent, baselinePinEvent, foldImageLedger, readImageLedger, readRegistryTags } from './image-ledger';
import { imageLs, recordImagePinFromConfigSet } from '../cli/image-cli';

const A = 'aaaaaaaaaaaa1111111111111111111111111111';
const B = 'bbbbbbbbbbbb2222222222222222222222222222';
const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'image-ledger-')); dirs.push(d); return join(d, 'image-ledger.jsonl'); }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const at = (iso: string) => () => new Date(iso);

describe('image ledger fold', () => {
  test('the latest baseline is the only current one · registry tags without a row are transient · latest is not a row', () => {
    const events = [
      baselinePinEvent(A, { now: at('2026-10-10T01:00:00Z'), host: 'mbp' }),
      baselinePinEvent(B, { now: at('2026-10-10T02:00:00Z'), host: 'mbp' }),
    ];
    const rows = foldImageLedger(events, ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc', 'latest']);
    expect(rows.map((r) => [r.tag, r.role, r.keep, r.current, r.inRegistry, r.unledgered])).toEqual([
      ['bbbbbbbbbbbb', 'baseline', 'pin', true, true, false],
      ['aaaaaaaaaaaa', 'baseline', 'pin', false, true, false],
      ['cccccccccccc', 'transient', 'short', false, true, true],
    ]);
    expect(rows.find((r) => r.unledgered)!.origin).toBeNull();
  });

  test('registry not read: no transient rows and inRegistry is unknown (null), not false', () => {
    const rows = foldImageLedger([baselinePinEvent(A, { now: at('2026-10-10T01:00:00Z'), host: 'h' })], null);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.inRegistry).toBeNull();
  });
});

describe('image ledger file', () => {
  test('append then read round-trips · bad lines are counted, not dropped silently', () => {
    const path = tmp();
    appendImageLedgerEvent(baselinePinEvent(A, { now: at('2026-10-10T01:00:00Z'), host: 'h' }), path);
    writeFileSync(path, `${readFileSync(path, 'utf8')}not json\n{"v":1,"tag":"zz"}\n`);
    const read = readImageLedger(path);
    expect(read.exists).toBe(true);
    expect(read.events.map((e) => e.tag)).toEqual(['aaaaaaaaaaaa']);
    expect(read.unreadableLines).toBe(2);
  });

  test('a missing ledger reads as exists=false with zero events', () => {
    expect(readImageLedger(join(tmpdir(), 'image-ledger-none', 'x.jsonl'))).toMatchObject({ exists: false, events: [], unreadableLines: 0 });
  });

  test('invalid events are refused at write time', () => {
    expect(() => baselinePinEvent('abc')).toThrow('not a commit');
  });
});

describe('recording site: config set harness.imageCommit', () => {
  test('records baseline ⊕ pin once per change, ignores other paths and non-commits', () => {
    const path = tmp();
    expect(recordImagePinFromConfigSet('harness.podPool', A, { ledgerPath: path })).toBe('skipped');
    expect(recordImagePinFromConfigSet('harness.imageCommit', 'not-hex', { ledgerPath: path })).toBe('skipped');
    expect(recordImagePinFromConfigSet('harness.imageCommit', A.slice(0, 12), { ledgerPath: path, now: at('2026-10-10T01:00:00Z'), host: 'mbp' })).toBe('recorded');
    expect(recordImagePinFromConfigSet('harness.imageCommit', A.slice(0, 12).toUpperCase(), { ledgerPath: path })).toBe('unchanged');
    expect(recordImagePinFromConfigSet('harness.imageCommit', B, { ledgerPath: path, now: at('2026-10-10T02:00:00Z'), host: 'mbp' })).toBe('recorded');
    const events = readImageLedger(path).events;
    expect(events.map((e) => [e.tag, e.role, e.keep, e.origin.reason, e.origin.host])).toEqual([
      ['aaaaaaaaaaaa', 'baseline', 'pin', 'config-set', 'mbp'],
      ['bbbbbbbbbbbb', 'baseline', 'pin', 'config-set', 'mbp'],
    ]);
  });

  test('a ledger write failure warns and reports failed (the config write is not undone)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'image-ledger-')); dirs.push(dir);
    const blocker = join(dir, 'file');
    writeFileSync(blocker, '');
    const warnings: string[] = [];
    expect(recordImagePinFromConfigSet('harness.imageCommit', A, { ledgerPath: join(blocker, 'sub', 'image-ledger.jsonl'), warn: (m) => warnings.push(m) })).toBe('failed');
    expect(warnings[0]).toContain('not recorded');
  });
});

describe('image ls', () => {
  test('unreadable registry says unknown, never transient 0', () => {
    const path = tmp();
    appendImageLedgerEvent(baselinePinEvent(A, { now: at('2026-10-10T01:00:00Z'), host: 'mbp' }), path);
    const lines: string[] = [];
    const r = imageLs({}, { ledgerPath: path, env: {}, out: (l) => lines.push(l), readRegistry: () => ({ ok: false, reason: 'registry read failed (exit 7)' }) });
    expect(r.counts).toEqual({ baseline: 1, transient: null, ledgered: 1 });
    expect(lines.join('\n')).toContain('transient unknown');
    expect(lines.join('\n')).toContain('not read');
  });

  test('readable registry: transient = registry commit tags without a ledger row · JSON carries the counts', () => {
    const path = tmp();
    appendImageLedgerEvent(baselinePinEvent(A, { now: at('2026-10-10T01:00:00Z'), host: 'mbp' }), path);
    const seen: Array<{ port: string; sshHost?: string }> = [];
    const lines: string[] = [];
    const r = imageLs({ json: true, ssh: 'node-b' }, { ledgerPath: path, env: { ELANOUS_FLEET_REGISTRY_PORT: '5050' }, out: (l) => lines.push(l), readRegistry: (o) => { seen.push(o); return { ok: true, tags: ['aaaaaaaaaaaa', 'dddddddddddd', 'latest'] }; } });
    expect(seen).toEqual([{ port: '5050', sshHost: 'node-b' }]);
    expect(r.counts).toEqual({ baseline: 1, transient: 1, ledgered: 1 });
    expect(JSON.parse(lines.join('\n')).registry).toMatchObject({ read: true, tags: 3 });
  });

  test('an out-of-range registry port is not read', () => {
    let called = false;
    const r = imageLs({}, { ledgerPath: tmp(), env: { ELANOUS_FLEET_REGISTRY_PORT: '99999' }, out: () => {}, readRegistry: () => { called = true; return { ok: true, tags: [] }; } });
    expect(called).toBe(false);
    expect(r.registry).toMatchObject({ read: false, tags: null });
  });

  test('a row keeps the full commit when any event for the tag carried it', () => {
    const rows = foldImageLedger([
      baselinePinEvent(A, { now: at('2026-10-10T01:00:00Z'), host: 'h' }),
      baselinePinEvent(A.slice(0, 12), { now: at('2026-10-10T02:00:00Z'), host: 'h' }),
    ], null);
    expect(rows[0]!.commit).toBe(A);
  });

  test('--ssh refuses option-like hosts', () => {
    expect(() => imageLs({ ssh: '-oProxyCommand=x' }, { ledgerPath: tmp(), out: () => {} })).toThrow('invalid --ssh host');
  });
});

describe('registry read', () => {
  test('parses tags · null tags = empty · failure keeps the reason', () => {
    expect(readRegistryTags({ port: '5050', run: () => ({ status: 0, stdout: '{"name":"elanous-harness","tags":["a"]}' }) })).toEqual({ ok: true, tags: ['a'] });
    expect(readRegistryTags({ port: '5050', run: () => ({ status: 0, stdout: '{"tags":null}' }) })).toEqual({ ok: true, tags: [] });
    const calls: string[][] = [];
    const r = readRegistryTags({ port: '5050', sshHost: 'node-b', run: (cmd, args) => { calls.push([cmd, ...args]); return { status: 255, stdout: '', stderr: 'ssh: connect timed out' }; } });
    expect(r).toEqual({ ok: false, reason: 'registry read failed (exit 255): ssh: connect timed out' });
    expect(calls[0]!.slice(0, 1).concat(calls[0]!.slice(-1))).toEqual(['ssh', 'curl -fsS --max-time 15 http://localhost:5050/v2/elanous-harness/tags/list']);
  });
});
