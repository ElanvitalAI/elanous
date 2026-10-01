import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
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

  test('the draft file is the single source: what is written is what deliver reads, edits included', () => {
    const dir = mkdtempSync(join(tmpdir(), 'field-feed-'));
    try {
      expect(readDraft(dir)).toBeNull();
      const draft = { kind: 'feed-draft', version: 1, revision: 1, updatedBy: 'graph', slides: [{ caption: 'a', include: true }] } as unknown as FeedDraft;
      writeDraft(dir, draft);
      const edited = JSON.parse(readFileSync(draftPath(dir), 'utf8'));
      edited.slides[0].include = false; edited.revision = 2; edited.updatedBy = 'human';
      writeFileSync(draftPath(dir), JSON.stringify(edited));
      expect(readDraft(dir)).toMatchObject({ revision: 2, updatedBy: 'human', slides: [{ include: false }] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
