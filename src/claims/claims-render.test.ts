import { expect, test, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { checkBrand } from '../../scripts/brand/check.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaimsLedger } from './claims-ledger.js';
import { queueStaleRechecks, renderClaims, representativeNumber } from './claims-render.js';
import { debug } from '../debug/log.js';

const root = () => realpathSync(mkdtempSync(join(tmpdir(), 'claims-render-test-')));

test('four claims: public fresh only, stale recheck once per KST day, brand exclusion and hidden proof', () => {
  const stateDir = root();
  const instanceRoot = root();
  let now = new Date('2026-10-04T00:00:00Z');
  const ledger = new ClaimsLedger({ stateDir, now: () => now });
  const logs: Array<{ category: string; event: string; data: unknown }> = [];
  const spy = spyOn(debug, 'log').mockImplementation((category, event, data) => { logs.push({ category, event, data }); });
  const add = (id: string, claim: string, value: string, until: string, publish = true) => {
    ledger.add({ id, claim, audience: 'personal', owner: 'MK' });
    ledger.verify(id, { value, command: `measure-${id}`, source: 'https://example.com/proof', measuredAt: '2026-10-03T00:00:00Z', validUntil: until, by: 'TC' });
    if (publish) ledger.publish(id, 'MK');
  };
  try {
    add('fresh', '측정된 코드가 있습니다.', '420만+ 줄', '2026-10-07T00:00:00Z');
    add('expired', '오래된 수입니다.', '12건', '2026-10-05T00:00:00Z');
    add('verified', '공개 전입니다.', '100건', '2026-10-07T00:00:00Z', false);
    add('forbidden', 'available now', '9건', '2026-10-07T00:00:00Z'); // B2, docs/brand/brand-rules.yaml
    now = new Date('2026-10-05T00:00:00Z');
    const result = renderClaims(ledger, { surface: 'deck' });
    expect(result.included).toEqual(['fresh']);
    expect(result.excluded).toEqual([
      { id: 'expired', reason: 'stale' }, { id: 'verified', reason: 'not-public' }, { id: 'forbidden', reason: 'brand' },
    ]);
    expect(result.markdown).toStartWith('## 왜 엘라누스인가');
    expect(result.markdown).toContain('측정된 코드가 있습니다. — 420만+ 줄');
    const renderedFile = join(stateDir, 'rendered.md');
    writeFileSync(renderedFile, result.markdown);
    expect(checkBrand('deck', [renderedFile]).findings).toEqual([]);
    expect(result.markdown).not.toContain('available now');
    expect(result.markdown.replace(/<!--[\s\S]*?-->/g, '')).not.toContain('measure-fresh');
    expect(result.markdown).toContain('<!-- claim:fresh measured:2026-10-03T00:00:00.000Z cmd:measure-fresh');
    expect(result.markdown.match(/<!--[\s\S]*?-->/g)).toEqual([
      '<!-- claim:fresh measured:2026-10-03T00:00:00.000Z cmd:measure-fresh source:https://example.com/proof -->',
      '<!-- src:https://example.com/proof -->',
    ]);
    expect(result.markdown.replace(/<!--[\s\S]*?-->/g, '')).not.toContain('https://example.com/proof');
    expect(renderClaims(ledger, { surface: 'site', audience: 'other' }).included).toEqual([]);
    expect(renderClaims(ledger, { surface: 'notice' }).markdown).toStartWith('### 이번 판에서 확인된 것');
    const site = renderClaims(ledger, { surface: 'site', audience: 'personal' });
    expect(site.markdown).toStartWith('## 엘라누스가 하는 일');
    expect(site.included).toEqual(['fresh']);
    expect(queueStaleRechecks(ledger, { root: instanceRoot, now })).toBe(1);
    expect(queueStaleRechecks(ledger, { root: instanceRoot, now })).toBe(0);
    expect(queueStaleRechecks(new ClaimsLedger({ stateDir, now: () => now }), { root: instanceRoot, now })).toBe(0);
    const requests = readFileSync(join(instanceRoot, 'seat-requests', 'requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(requests).toEqual([{ key: 'claims-recheck:expired:2026-10-05', seat: 'MK', text: 'expired 근거 낡음 — 재측: measure-expired', source: 'claims', status: 'queued', queuedAt: now.toISOString() }]);
    expect(logs).toContainEqual({ category: 'claims.render', event: 'rendered', data: { surface: 'deck', included: ['fresh'], excluded: result.excluded } });
    expect(logs).toContainEqual({ category: 'claims.recheck', event: 'queued', data: { count: 1 } });
  } finally { spy.mockRestore(); rmSync(stateDir, { recursive: true, force: true }); rmSync(instanceRoot, { recursive: true, force: true }); }
});

test('multiline claims render one sentence and one representative number; brand excludes the offending line', () => {
  const stateDir = root();
  const now = new Date('2026-10-04T00:00:00Z');
  const ledger = new ClaimsLedger({ stateDir, now: () => now });
  try {
    const add = (id: string, claim: string, value: string) => {
      ledger.add({ id, claim, audience: 'personal', owner: 'MK' });
      ledger.verify(id, { value, command: `measure-${id}`, measuredAt: now.toISOString(), validUntil: '2026-10-07T00:00:00Z', by: 'TC' });
      ledger.publish(id, 'MK');
    };
    add('multiline', '측정된 코드가 있습니다. 두 번째 설명입니다.\n세 번째 설명입니다.', '좋은 근거\n420만+ 줄 · 12건');
    add('forbidden', 'available now\n안내입니다.', '9건\n다른 근거');
    const result = renderClaims(ledger, { surface: 'deck' });
    expect(result.included).toEqual(['multiline']);
    expect(result.excluded).toEqual([{ id: 'forbidden', reason: 'brand' }]);
    expect(result.markdown).toContain('측정된 코드가 있습니다. — 420만+ 줄');
    expect(result.markdown).not.toContain('두 번째 설명입니다.');
    expect(result.markdown).not.toContain('좋은 근거');
    expect(result.markdown).not.toContain('세 번째 설명입니다.');
    expect(result.markdown).not.toContain('12건');
    expect(result.markdown).not.toContain('available now');
    const renderedFile = join(stateDir, 'rendered.md');
    writeFileSync(renderedFile, result.markdown);
    expect(checkBrand('deck', [renderedFile]).findings).toEqual([]);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('brand finding in a multiline claim with no other candidates excludes that claim', () => {
  const stateDir = root();
  const now = new Date('2026-10-04T00:00:00Z');
  const ledger = new ClaimsLedger({ stateDir, now: () => now });
  try {
    ledger.add({ id: 'multiline', claim: 'available now\n측정된 코드가 있습니다.', audience: 'personal', owner: 'MK' });
    ledger.verify('multiline', { value: '420만+ 줄', command: 'measure-multiline', measuredAt: now.toISOString(), validUntil: '2026-10-07T00:00:00Z', by: 'TC' });
    ledger.publish('multiline', 'MK');
    const result = renderClaims(ledger, { surface: 'deck' });
    expect(result.included).toEqual([]);
    expect(result.excluded).toEqual([{ id: 'multiline', reason: 'brand' }]);
    expect(result.markdown).toBe('## 왜 엘라누스인가\n');
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('the latest evidence controls expiration and the recheck command', () => {
  const stateDir = root();
  const instanceRoot = root();
  let now = new Date('2026-10-04T00:00:00Z');
  const ledger = new ClaimsLedger({ stateDir, now: () => now });
  try {
    ledger.add({ id: 'superseded', claim: '측정 결과입니다.', audience: 'personal', owner: 'TC' });
    ledger.verify('superseded', { value: '420만+ 줄', command: 'old-command', measuredAt: '2026-10-01T00:00:00Z', validUntil: '2026-10-07T00:00:00Z', by: 'TC' });
    ledger.verify('superseded', { value: '2건', command: 'latest-command', measuredAt: '2026-10-03T00:00:00Z', validUntil: '2026-10-05T00:00:00Z', by: 'TC' });
    ledger.publish('superseded', 'TC');
    now = new Date('2026-10-05T00:00:00Z');
    const rendered = renderClaims(ledger, { surface: 'deck' });
    expect(rendered.included).toEqual([]);
    expect(rendered.excluded).toEqual([{ id: 'superseded', reason: 'stale' }]);
    expect(queueStaleRechecks(ledger, { root: instanceRoot, now })).toBe(1);
    const request = JSON.parse(readFileSync(join(instanceRoot, 'seat-requests', 'requests.jsonl'), 'utf8').trim());
    expect(request.text).toBe('superseded 근거 낡음 — 재측: latest-command');
  } finally { rmSync(stateDir, { recursive: true, force: true }); rmSync(instanceRoot, { recursive: true, force: true }); }
});

test('representativeNumber picks the one unit-bearing measured value and refuses dates or ambiguity (review round 3)', () => {
  expect(representativeNumber('측정일 2026-10-03, 결과 420만+ 줄')).toBe('420만+ 줄');
  expect(representativeNumber('2026-10-04T09:00:00Z 기준 37%')).toBe('37%');
  expect(representativeNumber('2026')).toBeUndefined();
  expect(representativeNumber('12배 그리고 37%')).toBe('12배');
  expect(representativeNumber('측정 시각 09:30 · 근거 문서')).toBeUndefined();
});
