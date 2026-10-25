// 재현 — TUI-RESUME-PICKER(10-23 00:44 대표 보고): `/session list`·`/resume` 픽커가 id 를 «8자로 잘라»
// 보여 줘, 앞 8자가 같은 두 세션은 화면에서 같아 보였고 그 앞자리로는 `/session load` 가 «모호»로 실패했다.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSessionId } from './index.js';
import { SESSION_ID_PREFIX_MIN, idPrefixCell, sessionIdPrefixes, uniqueIdPrefixes } from './id-prefix.js';
import { seedSessionWithId } from '../ux-sim/session-id-seed.js';

describe('uniqueIdPrefixes', () => {
  test('distinct ids keep the familiar 8 characters', () => {
    const ids = ['0000e49c-f9e8-4117-9d5f-795e57b541e9', '00067496-fd11-4d20-a63c-679c01ba4a29'];
    const p = uniqueIdPrefixes(ids, ids);
    expect(p.get(ids[0]!)).toBe('0000e49c');
    expect(p.get(ids[1]!)).toBe('00067496');
  });

  test('ids sharing 8+ characters grow one past the shared part — never cut below uniqueness', () => {
    const a = 'deadbeef-1111-4000-8000-000000000001';
    const b = 'deadbeef-1112-4000-8000-000000000002';
    const c = 'deadbeef-2000-4000-8000-000000000003';
    const p = uniqueIdPrefixes([a, b, c], [a, b, c]);
    expect(p.get(a)).toBe('deadbeef-1111');
    expect(p.get(b)).toBe('deadbeef-1112');
    expect(p.get(c)).toBe('deadbeef-2');
    for (const [id, prefix] of p) {
      expect([a, b, c].filter((o) => o.startsWith(prefix))).toEqual([id]);
    }
  });

  test('uniqueness is against the whole store, not just the rows shown', () => {
    const shown = 'cafe0000-aaaa-4000-8000-000000000001';
    const hidden = 'cafe0000-aaab-4000-8000-000000000002';
    expect(uniqueIdPrefixes([shown], [shown, hidden]).get(shown)).toBe('cafe0000-aaaa');
  });

  test('long ids and an id that is the start of another get their whole id', () => {
    const shortId = 'tg-123456789';
    const longId = 'tg-123456789-thread-42-' + 'x'.repeat(40);
    const p = uniqueIdPrefixes([shortId, longId], [shortId, longId]);
    expect(p.get(shortId)).toBe(shortId);
    expect(p.get(longId)).toBe('tg-123456789-');
  });

  test('many sessions with one shared stem: every prefix is unique and minimal', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `abcdef01-${String(i).padStart(4, '0')}-4000-8000-000000000000`);
    const p = uniqueIdPrefixes(ids, ids);
    const prefixes = [...p.values()];
    expect(new Set(prefixes).size).toBe(ids.length);
    for (const [id, prefix] of p) {
      expect(ids.filter((o) => o.startsWith(prefix))).toEqual([id]);
      expect(ids.filter((o) => o.startsWith(prefix.slice(0, -1))).length).toBeGreaterThan(1);
    }
  });

  test('idPrefixCell pads to the widest prefix so the column stays aligned', () => {
    const p = new Map([['a', 'abcdefgh'], ['b', 'abcdefghij']]);
    expect(idPrefixCell(p, 'a')).toBe('abcdefgh  ');
    expect(idPrefixCell(p, 'b').length).toBe(10);
    expect(SESSION_ID_PREFIX_MIN).toBe(8);
  });
});

describe('store: the prefix shown is the prefix /session load accepts', () => {
  let dir = '';
  let saved: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'session-id-prefix-'));
    saved = process.env.ELANOUS_SESSION_ROOT;
    process.env.ELANOUS_SESSION_ROOT = join(dir, 'sessions');
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ELANOUS_SESSION_ROOT; else process.env.ELANOUS_SESSION_ROOT = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  test('colliding sessions: each shown prefix resolves to exactly its own session', () => {
    const ids = [
      seedSessionWithId('5eed5eed-0001-4000-8000-000000000001', 'n8n 특강'),
      seedSessionWithId('5eed5eed-0002-4000-8000-000000000002', 'RSS 재촬영'),
      seedSessionWithId('5eed5eed-0002-4fff-8000-000000000003', '세 번째'),
    ];
    const p = sessionIdPrefixes(ids);
    for (const id of ids) {
      const prefix = p.get(id)!;
      expect(prefix.length).toBeGreaterThan(8);
      expect(resolveSessionId(prefix)).toBe(id);
    }
    expect(() => resolveSessionId('5eed5eed')).toThrow(/ambiguous/);
  });

  test('a whole id resolves even when it is the start of a longer id', () => {
    seedSessionWithId('tg-777', '짧은 id');
    seedSessionWithId('tg-7770001', '긴 id');
    expect(resolveSessionId('tg-777')).toBe('tg-777');
    expect(resolveSessionId('tg-7770')).toBe('tg-7770001');
  });
});
