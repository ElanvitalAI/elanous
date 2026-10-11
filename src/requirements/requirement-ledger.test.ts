import { describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { RequirementLedger, type CaptureInput } from './requirement-ledger.js';

const root = () => mkdtempSync(join(tmpdir(), 'req-ledger-'));
const ledger = (stateDir = root()) =>
  new RequirementLedger({ stateDir, now: () => new Date('2026-10-11T01:00:00Z') });

const frBase = (): CaptureInput => ({
  statement: 'Harness journey is one graph',
  kind: 'fr',
  source: { kind: 'directive', at: '2026-10-11T00:00:00Z' },
  rfc: ['docs/RFC-harness-full-journey-as-graph-2026-10-08.md#4b'],
  cells: ['REQ-LEDGER'],
  owner: 'MK',
  tags: ['graph'],
  themes: ['harness-graph-0224'],
});

const nfrBase = (): CaptureInput => ({
  statement: 'mbp 1-minute load stays within core×1.5',
  kind: 'nfr:reliability',
  source: { kind: 'incident', at: '2026-10-11T00:10:00Z' },
  owner: 'OP',
  tags: ['load'],
});

const adminBase = (): CaptureInput => ({
  statement: 'Mac mini return deferred; temporary spare',
  kind: 'admin:hardware',
  source: { kind: 'seat', at: '2026-10-11T00:20:00Z' },
  owner: 'OP',
  evidence: {
    approvalCardId: 'D-20261011-01',
    documentLocation: 'elanous-pro/docs/hardware/mac-mini.md',
    receiptLocation: 'seat-state/receipts/mac-mini-2026-10.txt',
  },
});

describe('RequirementLedger — capture → place → transition', () => {
  test('fr record walks captured→placed→in-progress→landed→verified', () => {
    const store = ledger();
    const logs: unknown[][] = [];
    const spy = spyOn(debug, 'log').mockImplementation(((...args: unknown[]) => {
      logs.push(args);
    }) as typeof debug.log);
    try {
      const captured = store.capture(frBase());
      expect(captured.id).toBe('req-261011-1');
      expect(captured.status).toBe('captured');
      expect(captured.kind).toBe('fr');

      const placed = store.place(captured.id);
      expect(placed.status).toBe('placed');

      const progressing = store.transition(captured.id, 'in-progress');
      expect(progressing.status).toBe('in-progress');

      const landed = store.transition(captured.id, 'landed');
      expect(landed.status).toBe('landed');

      const verified = store.transition(captured.id, 'verified');
      expect(verified.status).toBe('verified');
      expect(store.show(captured.id).status).toBe('verified');

      const lines = readFileSync(store.path, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(5);
      expect(JSON.parse(lines[0]!).type).toBe('captured');
      expect(logs.filter(row => row[0] === 'requirements.ledger').map(row => row[1])).toEqual([
        'captured',
        'transition',
        'transition',
        'transition',
        'transition',
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  test('nfr record capture→place→transition', () => {
    const store = ledger();
    const captured = store.capture(nfrBase());
    expect(captured.kind).toBe('nfr:reliability');
    expect(store.place(captured.id).status).toBe('placed');
    expect(store.transition(captured.id, 'in-progress').status).toBe('in-progress');
    expect(store.list({ status: 'in-progress' })).toHaveLength(1);
  });

  test('admin record capture→place→transition with location-only evidence', () => {
    const store = ledger();
    const captured = store.capture(adminBase());
    expect(captured.kind).toBe('admin:hardware');
    expect(captured.evidence).toEqual({
      approvalCardId: 'D-20261011-01',
      documentLocation: 'elanous-pro/docs/hardware/mac-mini.md',
      receiptLocation: 'seat-state/receipts/mac-mini-2026-10.txt',
    });
    expect(store.place(captured.id).status).toBe('placed');
    expect(store.transition(captured.id, 'dropped', { note: 'owner cancelled' }).status).toBe('dropped');
  });
});

describe('RequirementLedger — allowlist + admin excerpt rejection', () => {
  test('disallowed keys throw before any bytes are written', () => {
    const store = ledger();
    expect(() => store.capture({ ...frBase(), priority: 'P0' } as CaptureInput & { priority: string })).toThrow(
      'disallowed key: priority',
    );
    expect(existsSync(store.path)).toBe(false);
  });

  test('admin source.excerpt throws and writes zero bytes', () => {
    const store = ledger();
    expect(() =>
      store.capture({
        ...adminBase(),
        source: { kind: 'seat', at: '2026-10-11T00:20:00Z', excerpt: '원문 발화 그대로' },
      }),
    ).toThrow('admin source.excerpt is forbidden');
    expect(existsSync(store.path)).toBe(false);
  });

  test('account/payment raw-text fields throw', () => {
    const store = ledger();
    expect(() =>
      store.capture({
        ...adminBase(),
        evidence: { approvalCardId: 'D-1', password: 'hunter2' } as CaptureInput['evidence'] & { password: string },
      }),
    ).toThrow(/account\/payment raw-text field rejected/);
    expect(existsSync(store.path)).toBe(false);
  });
});

describe('RequirementLedger — secret-shaped values are rejected, not redacted', () => {
  test('secret-shaped statement throws and value is absent from JSONL', () => {
    const store = ledger();
    const secret = `sk-${'a'.repeat(20)}`;
    expect(() => store.capture({ ...frBase(), statement: `leak ${secret}` })).toThrow(/secret-shaped value rejected/);
    expect(existsSync(store.path)).toBe(false);
  });

  test('secret-shaped owner throws with value absent from JSONL', () => {
    const store = ledger();
    store.capture(frBase());
    const before = readFileSync(store.path, 'utf8');
    const secret = `ghp_${'A'.repeat(36)}`;
    expect(() => store.capture({ ...nfrBase(), owner: secret })).toThrow(/secret-shaped value rejected/);
    expect(readFileSync(store.path, 'utf8')).toBe(before);
    expect(before).not.toContain(secret);
  });

  test('secret-shaped tags throw with value absent from JSONL', () => {
    const store = ledger();
    store.capture(frBase());
    const before = readFileSync(store.path, 'utf8');
    const secret = 'token=abcd1234efgh';
    expect(() => store.capture({ ...nfrBase(), tags: [secret] })).toThrow(/secret-shaped value rejected/);
    expect(readFileSync(store.path, 'utf8')).toBe(before);
    expect(before).not.toContain('abcd1234efgh');
  });

  test('secret-shaped evidence throws with value absent from JSONL', () => {
    const store = ledger();
    store.capture(frBase());
    const before = readFileSync(store.path, 'utf8');
    const secret = `sk-proj-${'B'.repeat(20)}`;
    expect(() =>
      store.capture({
        ...adminBase(),
        evidence: { approvalCardId: secret },
      }),
    ).toThrow(/secret-shaped value rejected/);
    expect(readFileSync(store.path, 'utf8')).toBe(before);
    expect(before).not.toContain(secret);
  });
});
