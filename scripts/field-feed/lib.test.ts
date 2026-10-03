import { describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { setElanousConfigDir, resetElanousConfigDir } from '../../src/elanous-config-dir.js';
import { listOutputs } from '../../src/outputs/ledger.js';
import { debug } from '../../src/debug/log.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftPath, kstDate, lastJson, listPhotos, readDraft, writeDraft, type FeedDraft } from './lib.js';

describe('field-feed lib', () => {
  test('photos follow the upload capture stamp, not the name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'field-feed-'));
    try {
      for (const f of ['20261001T091819Z-telegram-a.jpg', '20261001T091816Z-telegram-z.jpg', 'notes.txt', 'b.png']) writeFileSync(join(dir, f), '');
      expect(listPhotos(dir)).toEqual(['20261001T091816Z-telegram-z.jpg', '20261001T091819Z-telegram-a.jpg', 'b.png']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('date line is the first photo in KST — a 23:30 UTC upload is the next day', () => {
    expect(kstDate(['20261001T233000Z-phone-x.jpg'])).toBe('2026.10.02');
    expect(kstDate(['no-stamp.jpg'])).toBe('');
  });

  test('the last JSON object in a model reply wins; prose around it is ignored', () => {
    expect(lastJson('생각 중… {"hook":"a"} 그리고 {"hook":"b","hashtags":["#x"]}')).toEqual({ hook: 'b', hashtags: ['#x'] });
    expect(lastJson('JSON 없음')).toBeNull();
  });

  test('graph first draft is indexed once, while human revisions retain the atomic draft shape', () => {
    const root = mkdtempSync(join(tmpdir(), 'field-feed-ledger-'));
    setElanousConfigDir(root);
    try {
      const folder = join(root, 'field', 'festival');
      const graph = { kind: 'feed-draft', version: 1, revision: 1, updatedBy: 'graph', event: { title: '가을 축제', date: '2026.10.01' } } as FeedDraft;
      writeDraft(folder, graph);
      writeDraft(folder, graph);
      const human = { ...graph, revision: 2, updatedBy: 'human' as const, event: { ...graph.event, title: '수정 제목' } };
      writeDraft(folder, human);
      writeDraft(join(root, 'field', 'human-only'), { ...graph, updatedBy: 'human' });
      writeDraft(join(root, 'field', 'graph-revision-two'), { ...graph, revision: 2 });
      expect(readFileSync(draftPath(folder), 'utf8')).toBe(JSON.stringify(human, null, 2) + '\n');
      expect(readdirSync(join(folder, 'feed'))).toEqual(['feed-draft.json']);
      expect(listOutputs({ source: 'field-feed' }, root)).toMatchObject([
        { source: 'field-feed', sourceId: 'festival', kind: 'post', title: '가을 축제', path: draftPath(folder) },
      ]);
    } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
  });

  test('a ledger write failure cannot change the atomically replaced draft', () => {
    const root = mkdtempSync(join(tmpdir(), 'field-feed-failed-ledger-'));
    setElanousConfigDir(root);
    const log = spyOn(debug, 'log');
    try {
      mkdirSync(join(root, 'outputs'));
      const month = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 7);
      mkdirSync(join(root, 'outputs', `outputs-${month}.jsonl`));
      const folder = join(root, 'field', 'festival');
      const graph = { kind: 'feed-draft', version: 1, revision: 1, updatedBy: 'graph', event: { title: '현장', date: '' } } as FeedDraft;
      writeDraft(folder, graph);
      expect(readFileSync(draftPath(folder), 'utf8')).toBe(JSON.stringify(graph, null, 2) + '\n');
      expect(readdirSync(join(folder, 'feed'))).toEqual(['feed-draft.json']);
      expect(log.mock.calls.some(call => call[0] === 'outputs.ledger' && call[1] === 'write-failed'
        && (call[2] as { source: string }).source === 'field-feed')).toBe(true);
    } finally { log.mockRestore(); resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
  });

  test('the draft file is the single source: what is written is what deliver reads, edits included', () => {
    const dir = mkdtempSync(join(tmpdir(), 'field-feed-'));
    setElanousConfigDir(dir);
    try {
      expect(readDraft(dir)).toBeNull();
      const draft = { kind: 'feed-draft', version: 1, revision: 1, updatedBy: 'graph', event: { title: '현장', date: '' }, slides: [{ caption: 'a', include: true }] } as unknown as FeedDraft;
      writeDraft(dir, draft);
      const edited = JSON.parse(readFileSync(draftPath(dir), 'utf8'));
      edited.slides[0].include = false; edited.revision = 2; edited.updatedBy = 'human';
      writeFileSync(draftPath(dir), JSON.stringify(edited));
      expect(readDraft(dir)).toMatchObject({ revision: 2, updatedBy: 'human', slides: [{ include: false }] });
    } finally { resetElanousConfigDir(); rmSync(dir, { recursive: true, force: true }); }
  });
});
