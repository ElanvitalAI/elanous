import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSurfaceEventsDb, querySurfaceUtterances, recordEvent, recordInboundTurn } from '../domains/surface-events.js';
import { collectSelfUtterances, PAGE_SIZE } from './self-utterances-cli.js';

const interval = { from: '2026-10-12T00:00:00Z', to: '2026-10-13T00:00:00Z' };

test('self utterance CLI records explicit human and defaults unmarked Claude Code speech to agent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'self-utterance-origin-'));
  const env = { ...process.env, ELANOUS_STATE_DIR: dir, ELANOUS_CONFIG_DIR: dir };
  try {
    for (const [text, origin] of [['human prompt', 'human'], ['unmarked prompt', ''], ['explicit agent', 'agent']]) {
      const args = ['bun', 'bin/elanous.mjs', '--test', 'self', 'utterance', '--source', 'claude-code', '--text', text, '--ts', '2026-10-12T12:00:00Z'];
      if (origin) args.push('--origin', origin);
      const child = Bun.spawnSync(args, { cwd: import.meta.dir + '/../..', env, stdout: 'pipe', stderr: 'pipe' });
      expect(child.exitCode).toBe(0);
    }
    const codex = Bun.spawnSync(['bun', 'bin/elanous.mjs', '--test', 'self', 'utterance', '--source', 'codex', '--text', 'codex human prompt', '--ts', '2026-10-12T12:00:00Z', '--origin', 'human'], { cwd: import.meta.dir + '/../..', env, stdout: 'pipe', stderr: 'pipe' });
    expect(codex.exitCode).toBe(0);
    const invalid = Bun.spawnSync(['bun', 'bin/elanous.mjs', '--test', 'self', 'utterance', '--source', 'claude-code', '--text', 'invalid prompt', '--origin', 'robot'], { cwd: import.meta.dir + '/../..', env, stdout: 'pipe', stderr: 'pipe' });
    expect(invalid.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(invalid.stdout) + new TextDecoder().decode(invalid.stderr)).toContain('--origin must be human or agent');
    const db = openSurfaceEventsDb(join(dir, 'surface_events.db'));
    try {
      const human = collectSelfUtterances({ ...interval, surface: 'ext:claude-code', origin: 'human' }, db);
      const agent = collectSelfUtterances({ ...interval, surface: 'ext:claude-code', origin: 'agent' }, db);
      const codexHuman = collectSelfUtterances({ ...interval, surface: 'ext:codex', origin: 'human' }, db);
      expect(codexHuman.utterances.map((row) => [row.text, row.source])).toEqual([['codex human prompt', 'codex']]);
      expect(human.utterances.map((row) => [row.text, row.source])).toEqual([['human prompt', 'claude-code']]);
      expect(agent.utterances.map((row) => row.text).sort()).toEqual(['explicit agent', 'unmarked prompt']);
      const rows = db.query('SELECT text, surface, refs FROM events ORDER BY text').all() as Array<{ text: string; surface: string; refs: string }>;
      expect(rows.map((row) => [row.text, row.surface, JSON.parse(row.refs)])).toEqual([
        ['codex human prompt', 'ext:codex', { origin: 'codex', utteranceOrigin: 'human' }],
        ['explicit agent', 'ext:claude-code', { origin: 'claude-code' }],
        ['human prompt', 'ext:claude-code', { origin: 'claude-code', utteranceOrigin: 'human' }],
        ['unmarked prompt', 'ext:claude-code', { origin: 'claude-code' }],
      ]);
    } finally { db.close(); }
    const read = Bun.spawnSync(['bun', 'bin/elanous.mjs', '--test', 'self', 'utterances', '--from', interval.from, '--to', interval.to, '--surface', 'ext:claude-code', '--origin', 'human', '--json'], { cwd: import.meta.dir + '/../..', env, stdout: 'pipe', stderr: 'pipe' });
    expect(read.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(read.stdout)).utterances.map((row: { text: string; origin: string }) => [row.text, row.origin])).toEqual([['human prompt', 'human']]);
    const readAgent = Bun.spawnSync(['bun', 'bin/elanous.mjs', '--test', 'self', 'utterances', '--from', interval.from, '--to', interval.to, '--surface', 'ext:claude-code', '--origin', 'agent', '--json'], { cwd: import.meta.dir + '/../..', env, stdout: 'pipe', stderr: 'pipe' });
    expect(readAgent.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(readAgent.stdout)).utterances.map((row: { text: string; origin: string; source: string }) => [row.text, row.origin, row.source]).sort()).toEqual([['explicit agent', 'agent', 'claude-code'], ['unmarked prompt', 'agent', 'claude-code']]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

describe('self utterances CLI data contract', () => {
  test('half-open UTC bounds, deterministic ts/id ordering, surface/origin filters, paginated without loss and read-only', () => {
    const db = openSurfaceEventsDb(':memory:');
    try {
      recordEvent(db, { surface: 'cli', direction: 'inbound', kind: 'utterance', text: 'before', ts: '2026-10-11T23:59:59.999Z', refs: '{"origin":"human"}' });
      recordEvent(db, { surface: 'cli', direction: 'inbound', kind: 'utterance', text: 'same first', ts: '2026-10-12T01:00:00Z', refs: '{"origin":"human","cwd":"/valid/path"}' });
      recordEvent(db, { surface: 'cli', direction: 'inbound', kind: 'utterance', text: 'same second', ts: '2026-10-12T01:00:00Z', refs: '{"origin":"human"}' });
      recordEvent(db, { surface: 'cli', direction: 'inbound', kind: 'utterance', text: '[UX] 검토해 주세요 📨', ts: '2026-10-12T01:30:00Z', refs: '{"origin":"human"}' });
      recordEvent(db, { surface: 'cli', direction: 'outbound', kind: 'utterance', text: 'outbound is not inbound speech', ts: '2026-10-12T01:45:00Z', refs: '{"origin":"agent"}' });
      recordEvent(db, { surface: 'cli', direction: 'inbound', kind: 'alert', text: 'non-speech event', ts: '2026-10-12T01:50:00Z', refs: '{"origin":"human"}' });
      recordEvent(db, { surface: 'ext:codex', direction: 'inbound', kind: 'utterance', text: 'agent codex', ts: '2026-10-12T02:00:00Z', refs: '{"origin":"codex"}' });
      recordEvent(db, { surface: 'ext:claude-code', direction: 'inbound', kind: 'utterance', text: 'agent claude', ts: '2026-10-12T03:00:00Z', refs: '{"origin":"claude-code"}' });
      recordEvent(db, { surface: 'coord:channel', direction: 'inbound', kind: 'utterance', text: 'mirrored', ts: '2026-10-12T04:00:00Z', refs: '{"origin":"human"}' });
      recordEvent(db, { surface: 'cli', direction: 'inbound', kind: 'utterance', text: '[OP] 자리 알림', ts: '2026-10-12T04:30:00Z' });
      recordEvent(db, { surface: 'cli', direction: 'inbound', kind: 'utterance', text: 'seat notice 📨', ts: '2026-10-12T05:00:00Z' });
      recordEvent(db, { surface: 'cli', direction: 'inbound', kind: 'utterance', text: 'Please explain seat notice in the documentation', ts: '2026-10-12T05:01:00Z' });
      recordEvent(db, { surface: 'cli', direction: 'inbound', kind: 'utterance', text: '[UX] 검토해 주세요', ts: '2026-10-12T05:30:00Z' });
      recordEvent(db, { surface: 'cli', direction: 'inbound', kind: 'utterance', text: '📨 질문입니다', ts: '2026-10-12T05:45:00Z' });
      recordEvent(db, { surface: 'coord:seat', direction: 'inbound', kind: 'utterance', text: '[UX] 자동 알림', ts: '2026-10-12T05:47:00Z', refs: '{"origin":"seat"}' });
      recordEvent(db, { surface: 'cli', direction: 'inbound', kind: 'utterance', text: 'observer tagged despite human source', ts: '2026-10-12T05:48:00Z', refs: '{"origin":"human"}', tags: 'observer-generated' });
      recordEvent(db, { surface: 'cli', direction: 'inbound', kind: 'utterance', text: 'observer origin', ts: '2026-10-12T05:49:00Z', refs: '{"origin":"observer"}' });
      recordEvent(db, { surface: 'ext:codex', direction: 'inbound', kind: 'utterance', text: 'unknown origin codex', ts: '2026-10-12T05:50:00Z', refs: '{"origin":"ext:codex"}' });
      recordEvent(db, { surface: 'cli', direction: 'inbound', kind: 'utterance', text: 'token sk-abcdefghijklmnop email person@example.com URL https://example.test/?token=secret', ts: '2026-10-12T06:00:00Z', refs: '{"origin":"human"}' });
      recordInboundTurn({ surface: 'telegram', userText: 'Please explain seat notice in the documentation', responseText: 'assistant answer must not be exported', now: () => '2026-10-12T06:30:00Z', db });
      recordInboundTurn({ surface: 'discord', userText: '[OP] is a role label in this quote', responseText: 'private answer must not be exported', now: () => '2026-10-12T06:31:00Z', db });
      recordInboundTurn({ surface: 'telegram', userText: 'A long human question ' + 'x'.repeat(170), responseText: 'assistant reply', now: () => '2026-10-12T06:32:00Z', db });
      recordInboundTurn({ surface: 'telegram', userText: 'first line\nA: quoted answer marker\nmore question text', responseText: 'real assistant reply', now: () => '2026-10-12T06:33:00Z', db });
      recordEvent(db, { surface: 'telegram', direction: 'inbound', kind: 'qna', text: 'legacy unstructured question', summary: 's'.repeat(150), ts: '2026-10-12T06:34:00Z' });
      recordEvent(db, { surface: 'telegram', direction: 'inbound', kind: 'qna', text: 'Q: question\nQ: extra question\nA: answer', ts: '2026-10-12T06:35:00Z' });
      recordEvent(db, { surface: 'telegram', direction: 'inbound', kind: 'qna', text: 'unstructured', summary: 't'.repeat(151), ts: '2026-10-12T06:36:00Z' });
      recordEvent(db, { surface: 'telegram', direction: 'inbound', kind: 'qna', text: 'Q: automatic\nA: answer', ts: '2026-10-12T06:37:00Z', refs: '{"origin":"observer-generated"}' });
      recordEvent(db, { surface: 'telegram', direction: 'inbound', kind: 'qna', text: 'Q: agent instruction\nA: answer', ts: '2026-10-12T06:38:00Z', refs: '{"origin":"agent"}' });
      recordEvent(db, { surface: 'telegram', direction: 'inbound', kind: 'qna', text: 'unstructured with no summary', summary: '', ts: '2026-10-12T06:39:00Z' });
      recordEvent(db, { surface: 'cli', direction: 'inbound', kind: 'utterance', text: 'after', ts: '2026-10-13T00:00:00Z', refs: '{"origin":"human"}' });
      for (let i = 0; i < PAGE_SIZE; i++) recordEvent(db, { surface: 'cli', direction: 'inbound', kind: 'utterance', text: `page ${i}`, ts: `2026-10-12T10:${String(i).padStart(2, '0')}:00Z`, refs: '{"origin":"human"}' });
      const before = db.query('SELECT id, recall_count FROM events ORDER BY id').all();
      const first = collectSelfUtterances(interval, db);
      const second = collectSelfUtterances({ ...interval, page: '2' }, db);
      expect(first.utterances).toHaveLength(PAGE_SIZE);
      expect(first.page.hasNext).toBe(true);
      expect(second.page.hasNext).toBe(false);
      const all = [...first.utterances, ...second.utterances];
      expect(all).toHaveLength(first.counts.matched);
      expect(new Set(all.map((r) => r.id)).size).toBe(all.length);
      const tied = all.filter((r) => r.ts === '2026-10-12T01:00:00.000Z');
      expect(tied.map((r) => r.id)).toEqual([...tied.map((r) => r.id)].sort());
      expect(all.some((r) => r.text === 'before' || r.text === 'after')).toBe(false);
      expect(all.some((r) => r.text === '[UX] 검토해 주세요 📨' && r.origin === 'human')).toBe(true);
      expect(all.some((r) => r.text === 'outbound is not inbound speech' || r.text === 'non-speech event')).toBe(false);
      expect(all.some((r) => r.surface === 'ext:codex' && r.origin === 'agent')).toBe(true);
      expect(all.some((r) => r.surface === 'ext:claude-code' && r.origin === 'agent')).toBe(true);
      expect(all.some((r) => r.surface === 'coord:channel')).toBe(false);
      expect(all.some((r) => r.surface === 'coord:seat')).toBe(false);
      expect(all.some((r) => r.text === 'observer tagged despite human source' || r.text === 'observer origin' || r.text === 'automatic')).toBe(false);
      expect(all.some((r) => r.surface === 'telegram' && r.origin === 'human' && r.text === 'Please explain seat notice in the documentation')).toBe(true);
      expect(all.some((r) => r.surface === 'telegram' && r.origin === 'agent' && r.text === 'agent instruction')).toBe(true);
      expect(all.some((r) => r.text === 'unstructured with no summary')).toBe(false);
      expect(all.some((r) => r.surface === 'discord' && r.origin === 'human' && r.text === '[OP] is a role label in this quote')).toBe(true);
      expect(all.some((r) => r.surface === 'telegram' && r.text === 'A long human question ' + 'x'.repeat(170) && r.extract === 'qna')).toBe(true);
      expect(all.some((r) => r.extract === 'ambiguous' && r.text === 'first line' && r.possibleLoss)).toBe(true);
      expect(all.some((r) => r.extract === 'ambiguous' && r.text === 'question\nQ: extra question' && r.possibleLoss)).toBe(true);
      expect(all.some((r) => r.extract === 'summary' && !r.truncated && r.truncationEvidence === 'cap-reached' && r.text === 's'.repeat(150))).toBe(true);
      expect(all.some((r) => r.extract === 'summary' && r.truncated && r.truncationEvidence === 'over-cap' && r.text === 't'.repeat(150))).toBe(true);
      expect(first.counts.ambiguous).toBe(2);
      expect(first.counts.truncated).toBe(1);
      expect(first.counts.capReached).toBe(1);
      expect(first.counts.possibleLoss).toBe(2);
      expect(all.some((r) => r.text.includes('assistant answer must not be exported') || r.text.includes('private answer must not be exported'))).toBe(false);
      expect(all.some((r) => r.text === '[OP] 자리 알림')).toBe(true);
      expect(all.some((r) => r.text === 'seat notice 📨')).toBe(true);
      expect(all.some((r) => r.text === 'Please explain seat notice in the documentation' && r.origin === 'human')).toBe(true);
      expect(all.some((r) => r.text === '[UX] 검토해 주세요')).toBe(true);
      expect(all.some((r) => r.text === '📨 질문입니다')).toBe(true);
      expect(all.some((r) => r.surface === 'ext:codex' && r.text === 'unknown origin codex' && r.origin === 'agent')).toBe(true);
      expect(first.counts.excludedAutomatic).toBe(5);
      expect(first.counts.excludedUnextractable).toBe(1);
      const human = collectSelfUtterances({ ...interval, origin: 'human', surface: 'cli' }, db);
      expect(human.utterances.every((r) => r.origin === 'human' && r.surface === 'cli')).toBe(true);
      const agentQna = collectSelfUtterances({ ...interval, origin: 'agent', surface: 'telegram' }, db);
      expect(agentQna.utterances.map((r) => r.text)).toEqual(['agent instruction']);
      const secret = all.find((r) => r.text.startsWith('token'))!.text;
      expect(secret).not.toContain('sk-abcdefghijklmnop');
      expect(secret).not.toContain('person@example.com');
      expect(secret).not.toContain('token=secret');
      expect(all.find((r) => r.cwd !== null)!.cwd).toBe('/valid/path');
      expect(db.query('SELECT id, recall_count FROM events ORDER BY id').all()).toEqual(before);
    } finally { db.close(); }
  });

  test('rejects malformed ranges and non-positive page', () => {
    const db = openSurfaceEventsDb(':memory:');
    try {
      expect(() => collectSelfUtterances({ ...interval, page: '0' }, db)).toThrow('--page must be a positive integer');
      expect(() => collectSelfUtterances({ from: interval.to, to: interval.from }, db)).toThrow('--from must be earlier than --to');
      expect(() => collectSelfUtterances({ from: 'bad', to: interval.to }, db)).toThrow('--from must be a valid ISO date/time');
    } finally { db.close(); }
  });
});

 test('surface query applies date half-open bounds and tie-breaks by id', () => {
  const db = openSurfaceEventsDb(':memory:');
  try {
    recordEvent(db, { surface: 'cli', direction: 'inbound', kind: 'utterance', text: 'x', ts: interval.from });
    recordEvent(db, { surface: 'other', direction: 'inbound', kind: 'utterance', text: 'y', ts: interval.from });
    recordEvent(db, { surface: 'cli', direction: 'outbound', kind: 'utterance', text: 'outbound', ts: interval.from });
    recordEvent(db, { surface: 'cli', direction: 'inbound', kind: 'alert', text: 'event, not speech', ts: interval.from });
    recordEvent(db, { surface: 'cli', direction: 'inbound', kind: 'utterance', text: 'z', ts: interval.to });
    const rows = querySurfaceUtterances(db, { ...interval, surface: 'cli' });
    expect(rows.map((row) => row.text)).toEqual(['x']);
  } finally { db.close(); }
});

test('surface query compares mixed ISO timestamp forms by instant at fractional bounds', () => {
  const db = openSurfaceEventsDb(':memory:');
  try {
    recordEvent(db, { surface: 'cli', direction: 'inbound', kind: 'utterance', text: 'before', ts: '2026-10-12T00:00:00Z' });
    recordEvent(db, { surface: 'cli', direction: 'inbound', kind: 'utterance', text: 'inside', ts: '2026-10-12T00:00:00.500Z' });
    recordEvent(db, { surface: 'cli', direction: 'inbound', kind: 'utterance', text: 'at end', ts: '2026-10-12T00:00:00.750Z' });
    recordEvent(db, { surface: 'cli', direction: 'inbound', kind: 'utterance', text: 'later', ts: '2026-10-12T00:00:01Z' });
    const result = collectSelfUtterances({ from: '2026-10-12T00:00:00.250Z', to: '2026-10-12T00:00:00.750Z' }, db);
    expect(result.utterances.map((row) => row.text)).toEqual(['inside']);
  } finally { db.close(); }
});
