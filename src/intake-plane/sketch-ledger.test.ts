import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureAndDraftIntakeRecord } from './capture.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { intakeItemId, loadIntakeLedger } from './items.js';
import { ledgerSourceForSketch, recordSketchInLedger } from './sketch-ledger.js';
import { createIntakeStore } from './store.js';
import type { RawIntakeRecord } from './types.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'sketch-ledger-'));
  roots.push(root);
  return root;
}

function sketch(source: RawIntakeRecord['source'], rawText: string): RawIntakeRecord {
  return {
    intakeId: 'sketch-1', source, rawText, attachments: [],
    receivedAt: '2026-09-27T12:34:56.000Z',
  };
}

test('maps every sketch source to a ledger source', () => {
  expect(Object.fromEntries(([
    'tui-scratch', 'web-scratch', 'mobile-scratch', 'voice', 'telegram',
    'discord', 'api', 'document', 'url',
  ] as const).map((source) => [source, ledgerSourceForSketch(source)]))).toEqual({
    'tui-scratch': 'memo', 'web-scratch': 'pwa', 'mobile-scratch': 'pwa',
    voice: 'memo', telegram: 'telegram-bot', discord: 'memo',
    api: 'memo', document: 'memo', url: 'memo',
  });
});

test('ingests the first valid HTTP(S) URL and at most 2,000 text characters at receivedAt', () => {
  const root = fixture();
  const raw = sketch('web-scratch', `ftp://invalid.test https://first.example/a?utm_source=x https://second.example/b ${'x'.repeat(2_100)}`);
  const id = recordSketchInLedger(root, raw);
  expect(id).toBe(intakeItemId('pwa', { url: 'https://first.example/a?utm_source=x' }));
  const item = loadIntakeLedger(root).items.get(id!);
  expect(item).toMatchObject({
    id, source: 'pwa', sources: ['pwa'], url: 'https://first.example/a',
    observedAt: raw.receivedAt, lastSeenAt: raw.receivedAt, privacy: 'user-private',
  });
  expect(item?.text).toHaveLength(2_000);
  expect(item?.text).not.toContain('x'.repeat(2_100));
  expect(loadIntakeLedger(root).items.size).toBe(1);
});

test('text-only sketches return their ledger id; repeated captures merge instead of duplicating', () => {
  const root = fixture();
  const raw = sketch('telegram', '  a note with no link  ');
  const id = recordSketchInLedger(root, raw);
  expect(id).toBe(intakeItemId('telegram-bot', { text: 'a note with no link' }));
  expect(recordSketchInLedger(root, raw)).toBe(id);
  expect(loadIntakeLedger(root).items.size).toBe(1);
  expect(loadIntakeLedger(root).items.get(id!)?.text).toBe('a note with no link');
});

test('blank sketches do not ingest and return undefined', () => {
  const root = fixture();
  expect(recordSketchInLedger(root, sketch('voice', ' \n\t '))).toBeUndefined();
  expect(loadIntakeLedger(root).items.size).toBe(0);
});

test('capture and draft writes one ledger entry after capture', () => {
  const root = fixture();
  const store = createIntakeStore({ archiveDir: null });
  const raw = sketch('tui-scratch', 'capture this note');
  const captured = store.capture.bind(store);
  store.capture = (record) => {
    expect(loadIntakeLedger(root).items.size).toBe(0);
    return captured(record);
  };
  const setState = store.setState.bind(store);
  store.setState = (intakeId, nextState, detail) => {
    expect(loadIntakeLedger(root).items.size).toBe(1);
    return setState(intakeId, nextState, detail);
  };
  const session = captureAndDraftIntakeRecord(store, raw, { ledgerRoot: root });
  const id = intakeItemId('memo', { text: raw.rawText });
  expect(session.draft?.intakeId).toBe(raw.intakeId);
  expect(loadIntakeLedger(root).items.get(id)).toMatchObject({
    source: 'memo', text: raw.rawText, observedAt: raw.receivedAt,
  });
  expect(loadIntakeLedger(root).items.size).toBe(1);
  expect(readFileSync(join(root, 'intake', 'items.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
});

test('capture and draft defaults to the effective instance root when ledgerRoot is absent', () => {
  const root = fixture();
  const previous = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root;
  try {
    expect(effectiveInstanceRoot()).toBe(root);
    const store = createIntakeStore({ archiveDir: null });
    const raw = sketch('api', 'default-root note');
    const session = captureAndDraftIntakeRecord(store, raw);
    expect(session.draft?.intakeId).toBe(raw.intakeId);
    expect(loadIntakeLedger(root).items.get(intakeItemId('memo', { text: raw.rawText }))?.text).toBe(raw.rawText);
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
  }
});

test('ledger write failure does not block capture or drafting', () => {
  const root = fixture();
  const unusableRoot = join(root, 'file');
  writeFileSync(unusableRoot, 'not a directory');
  const store = createIntakeStore({ archiveDir: null });
  const raw = sketch('voice', 'continue even when the ledger cannot write');
  const session = captureAndDraftIntakeRecord(store, raw, { ledgerRoot: unusableRoot });
  expect(session.draft?.intakeId).toBe(raw.intakeId);
  expect(store.getSession(raw.intakeId)?.raw).toEqual(raw);
  expect(store.listEvents({ intakeId: raw.intakeId }).map((event) => event.kind)).toEqual([
    'captured', 'state-transition', 'draft-saved',
  ]);
});

test('capture leaves an observation — recorded on success, record-failed (no text) when the ledger is unwritable', async () => {
  const { debug } = await import('../debug/log.js');
  const { spyOn } = await import('bun:test');
  const rows: Array<[string, string, Record<string, unknown>]> = [];
  const spy = spyOn(debug, 'log').mockImplementation((c, e, d) => { if (c === 'intake.sketch-ledger') rows.push([c, e, (d ?? {}) as Record<string, unknown>]); });
  try {
    const ok = fixture();
    const store = createIntakeStore({ archiveDir: null });
    captureAndDraftIntakeRecord(store, sketch('tui-scratch', 'see https://example.com/a'), { ledgerRoot: ok });
    // 원장 뿌리 자리에 «파일»을 두면 쓰기가 실패한다(권한에 기대지 않아 root 로 도는 Pod 에서도 같다).
    const blocked = join(fixture(), 'not-a-dir');
    writeFileSync(blocked, 'x');
    const failed = { ...sketch('telegram', 'secret memo https://example.com/b'), intakeId: 'sketch-2' };
    expect(() => captureAndDraftIntakeRecord(store, failed, { ledgerRoot: blocked })).not.toThrow();
    expect(rows.map(([, e, d]) => [e, d.source])).toEqual([['recorded', 'tui-scratch'], ['record-failed', 'telegram']]);
    expect(rows[0][2].hasUrl).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('secret memo');
  } finally { spy.mockRestore(); }
});
