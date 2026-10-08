import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestIntakeItems, listIntakeItems, markIntakeItem } from './items.js';
import { buildIntakeDigest, renderDigestMarkdown, renderDigestTelegram, type IntakeDigest } from './digest.js';

test('filtered digest excludes unowned queues and MK notes; empty user briefing has the shared zero headline', () => {
  const root = mkdtempSync(join(tmpdir(), 'watch-digest-'));
  const at = '2026-10-04T16:00:00Z';
  try {
    for (const [seat, title] of [['user', 'first'], ['MK', 'other'], ['user', 'second']]) {
      ingestIntakeItems(root, 'github', [{ seat, url: `https://example.com/${title}`, title, kind: 'repo' }], at);
      markIntakeItem(root, listIntakeItems(root).find(item => item.title === title)!.id,
        { status: 'absorbed', output: { kind: 'note', ref: `/notes/${title}.md` } }, at);
    }
    ingestIntakeItems(root, 'github', [{ seat: 'user', url: 'https://example.com/fresh', title: 'fresh', kind: 'repo' }], at);
    const firstId = listIntakeItems(root).find(item => item.title === 'first')!.id;
    const lensDir = join(root, 'intake', 'outbox', 'lens');
    mkdirSync(lensDir, { recursive: true });
    writeFileSync(join(lensDir, '2026-10-05.jsonl'), JSON.stringify({
      id: firstId, lensVerdict: '보강', why: '우리 영상 칸의 편집 근거를 강화한다', target: '영상',
    }) + '\n');
    expect(buildIntakeDigest(root, '2026-10-05').absorbed).toHaveLength(3);
    const user = buildIntakeDigest(root, '2026-10-05', undefined, undefined, 'user');
    expect(user.absorbed.map(entry => entry.oneLiner ?? entry.noteName)).toEqual(['first', 'second', 'fresh']);
    expect(user.goals).toEqual([]);
    expect(user.news).toBeUndefined();
    expect(user.absorbed.find(entry => entry.id === firstId)?.impact?.verdict).toBe('보강');
    expect(renderDigestTelegram(user)).toContain('흡수 3편 → 우리에게 닿는 것 1');
    expect(renderDigestTelegram(user)).toContain('S 무엇: first\nC 우리에게 왜: 우리 영상 칸의 편집 근거를 강화한다\nA 그래서 무엇을 하나: 칸 영상 에 근거 추가\n🔗 노트: [[first]]');
    expect(renderDigestTelegram(user)).toContain('참고 2편 — 노트: [[second]], https://example.com/fresh');
    expect(renderDigestTelegram(user)).not.toContain('other');
    expect(renderDigestTelegram(buildIntakeDigest(root, '2026-10-06', undefined, undefined, 'user'))).toBe('흡수 0편 → 우리에게 닿는 것 0');
    expect(renderDigestTelegram(buildIntakeDigest(root, '2026-10-06'))).toBe('흡수 0편 → 우리에게 닿는 것 0');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('seat and whole briefings share the lens headline, S·C·A·note blocks and one reference line without human triage', () => {
  const absorbed: IntakeDigest['absorbed'] = [
    { id: 'touch', sources: ['github'], axis: '영상 자동화', oneLiner: '새 영상 편집 기능', note: '/notes/touch.md', noteName: 'touch', url: 'https://example.com/touch', impact: { verdict: '보강', why: '우리 영상 칸의 편집 소구점을 강화한다', target: '영상' } },
    { id: 'reference', sources: ['github'], axis: '그 밖', oneLiner: '무관한 항목', note: '/notes/reference.md', noteName: 'reference' },
    { id: 'unnamed', sources: ['github'], axis: '그 밖', oneLiner: '다른 참고', url: 'https://example.com/unnamed' },
    { id: 'unlinked', sources: ['github'], axis: '그 밖', oneLiner: '원문 없음' },
  ];
  for (const seat of [undefined, 'MK']) {
    const digest: IntakeDigest = { day: '2026-10-05', ...(seat ? { seat } : {}), absorbed, goals: [], review: Array.from({ length: 94 }, (_, n) => ({ fact: `판단 ${n}` })), grounding: 0, release: 0, manual: 0 };
    const briefing = renderDigestTelegram(digest);
    expect(briefing.split('\n')[0]).toBe('흡수 4편 → 우리에게 닿는 것 1');
    expect(briefing).toContain('S 무엇: 새 영상 편집 기능\nC 우리에게 왜: 우리 영상 칸의 편집 소구점을 강화한다\nA 그래서 무엇을 하나: 칸 영상 에 근거 추가\n🔗 노트: [[touch]]');
    expect(briefing).toContain('참고 3편 — 노트: [[reference]], https://example.com/unnamed, unlinked');
    expect(briefing.match(/^참고 \d+편 — 노트:/gm)).toHaveLength(1);
    expect(briefing).not.toContain('무관한 항목');
    expect(briefing).not.toContain('사람이 가를 것');
    expect(briefing).not.toContain('판단 0');
    expect(briefing).not.toContain('그 밖 3건 · 참고');
    expect(renderDigestMarkdown(digest)).toContain('렌즈 판정 못 함 3 — 원장 `elanous intake items`');
    expect(renderDigestMarkdown(digest)).not.toContain('사람이 가를 것');
    const noVerdict = renderDigestTelegram({ ...digest, absorbed: absorbed.map(({ impact: _impact, ...entry }) => entry) });
    expect(noVerdict.split('\n')[0]).toBe('흡수 4편 → 우리에게 닿는 것 0');
    expect(noVerdict).toContain('참고 4편 — 노트: [[touch]], [[reference]], https://example.com/unnamed, unlinked');
    expect(noVerdict).not.toContain('S 무엇:');
  }
  const eleven: IntakeDigest['absorbed'] = Array.from({ length: 11 }, (_, n) => ({
    id: `item-${n}`, sources: ['github'], axis: '영상 자동화', oneLiner: `기사 ${n}`, noteName: `note-${n}`,
    ...(n < 4 ? { impact: { verdict: '보강' as const, why: `영상 칸의 편집 효익 ${n}`, target: '영상' } } : {}),
  }));
  const elevenDigest: IntakeDigest = { day: '2026-10-05', absorbed: eleven, goals: [], grounding: 0, release: 0, manual: 0 };
  for (const seat of [undefined, 'MK']) {
    const text = renderDigestTelegram({ ...elevenDigest, ...(seat ? { seat } : {}) });
    expect(text.split('\n')[0]).toBe('흡수 11편 → 우리에게 닿는 것 4');
    expect(text.match(/^S 무엇:/gm)).toHaveLength(3);
    expect(text).toContain('닿는 것 1건 더');
    expect(text).toContain('참고 7편 — 노트: [[note-4]], [[note-5]], [[note-6]], [[note-7]], [[note-8]], [[note-9]], [[note-10]]');
    expect(text).not.toContain('사람이 가를 것');
  }
  const many: IntakeDigest['absorbed'] = Array.from({ length: 94 }, (_, n) => ({ id: `ref-${n}`, sources: ['github'], axis: '그 밖', noteName: `ref-${n}` }));
  const crowded = renderDigestTelegram({ day: '2026-10-05', absorbed: many, goals: [], grounding: 0, release: 0, manual: 0 });
  const referenceLines = crowded.match(/^참고 .*$/gm) ?? [];
  expect(referenceLines).toHaveLength(1);
  expect(referenceLines[0]).toStartWith('참고 94편 — 노트: [[ref-0]], ');
  expect(referenceLines[0]).toEndWith('[[ref-9]] 외 84편 · 원장 `elanous intake items`');
  expect(crowded).not.toContain('[[ref-10]]');
});
