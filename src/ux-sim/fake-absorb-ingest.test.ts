import { describe, expect, test } from 'bun:test';
import { buildAbsorbSummaryCard } from '../intake-plane/absorb-extract.js';
import { createFakeExtractors, FAKE_ABSORB_SCRAPS, FakeScrapInbox } from './fake-absorb-ingest.js';

describe('fake ABSORB ingest world', () => {
  test('seven input kinds extract and build a deterministic card', async () => {
    const inbox = new FakeScrapInbox();
    const extractors = createFakeExtractors();
    for (const scrap of FAKE_ABSORB_SCRAPS.filter((row) => row.memberId === 'member-a')) {
      inbox.create(scrap);
      const extracted = await extractors.extract(scrap);
      const card = await buildAbsorbSummaryCard(extracted);
      expect(card.title).toBeTruthy();
      expect(card.points[0]).toBeTruthy();
      if (scrap.raw.url) expect(card.originUrl).toBe(scrap.raw.url);
    }
    expect(new Set(inbox.list('member-a').map((row) => row.kind))).toEqual(new Set(['text', 'web', 'x', 'youtube', 'voice', 'video', 'photo']));
  });

  test('owner reads are isolated and the injected extractor failure is visible', async () => {
    const inbox = new FakeScrapInbox();
    for (const scrap of FAKE_ABSORB_SCRAPS) inbox.create(scrap);
    expect(inbox.list('member-a').some((row) => row.memberId === 'member-b')).toBe(false);
    expect(inbox.list('member-b').map((row) => row.id)).toEqual(['scrap-owner-b']);
    await expect(createFakeExtractors({ failKind: 'video' }).extract(FAKE_ABSORB_SCRAPS.find((row) => row.kind === 'video')!)).rejects.toThrow('simulated video extractor failure');
  });
});
