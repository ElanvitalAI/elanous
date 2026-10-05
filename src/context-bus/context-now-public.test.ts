import { expect, test } from 'bun:test';
import { checkBrand } from '../../scripts/brand/check.js';
import { debug } from '../debug/log.js';
import { contextNow, type ContextNowAnswer, type ContextNowDeps } from './context-now.js';
import { filterPublicDemoContext } from './context-now-public.js';
import { renderCardNow, renderTelegramNow, renderTuiNow, renderVoiceNow } from './context-now-surfaces.js';

const answer: ContextNowAnswer = {
  at: '2026-10-04T04:00:00.000Z', topic: '진행',
  facts: [
    { kind: 'version', version: '0.2.0', source: 'elanous://release/0.2.0/checklist' },
    { kind: 'cell', version: '0.2.0', id: 'K6', title: '공개 기능', status: 'red', owner: 'TC', source: 'elanous://release/0.2.0/checklist#K6' },
    { kind: 'cell', version: '0.2.0', id: 'K7', title: 'available now', status: 'red', owner: 'TC', source: 'elanous://release/0.2.0/checklist#K7' },
    { kind: 'cell', version: '0.2.0', id: 'K8', title: 'out now 준비', status: 'yellow', owner: 'OP', source: 'elanous://release/0.2.0/checklist#K8' },
    { kind: 'decision', id: 'D1', title: 'fully autonomous', status: 'open', dueAt: null, source: 'elanous://decisions/D1' },
    { kind: 'decision', id: 'D2', title: '/Users/alice/internal', status: 'open', dueAt: null, source: 'elanous://decisions/D2' },
    { kind: 'seat', seat: 'TC', at: '2026-10-04T03:00:00.000Z', id: 'K6', title: '공개 기능', status: 'doing', source: 'elanous://seat-loop/TC/2026-10-04#1' },
  ],
  events: [{ at: '2026-10-04T03:00:00.000Z', kind: 'report', summary: 'PR #1234 on run-abcdef12 at node-b.tailnet /home/alice/private', source: 'https://github.com/org/repo/pull/1234' }],
  guide: ['OP 확인: PR #5678 — /Users/alice/notes'],
};

test('missing rules collapse every cell and decision, redact linked seats and free text, and log the fallback', () => {
  const originalLog = debug.log;
  const missingLogs: unknown[] = [];
  (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => {
    if (category === 'context.now' && event === 'brand-rules-missing') missingLogs.push(data);
  }) as typeof debug.log;
  try {
    const missingRules: typeof checkBrand = (scope, paths) => checkBrand(scope, paths, '/nonexistent/brand-rules.yaml');
    const before = structuredClone(answer);
    const filtered = filterPublicDemoContext(answer, missingRules);
    expect(filtered.hiddenCount).toBe(6);
    expect(filtered.facts.filter(fact => fact.kind === 'cell')).toMatchObject([
      { kind: 'cell', id: '내부 항목', title: '내부 항목 3개' },
    ]);
    expect(filtered.facts.filter(fact => fact.kind === 'decision')).toMatchObject([
      { kind: 'decision', id: '내부 항목', title: '내부 항목 2개', status: 'open' },
    ]);
    expect(filtered.facts.find(fact => fact.kind === 'seat')).toMatchObject({ id: '내부 항목', title: '내부 항목 1개' });
    const unlinked = filterPublicDemoContext({ ...answer, facts: [{ kind: 'seat', seat: 'UX', at: answer.at,
      id: 'K99', title: '비공개 별도 작업', status: 'doing', source: 'elanous://seat-loop/UX/1' }] }, missingRules);
    expect(unlinked.facts[0]).toMatchObject({ id: '내부 항목', title: '내부 항목 1개' });
    expect(unlinked.hiddenCount).toBe(1);
    expect(filtered.events[0]?.summary).toBe('공개 소식');
    expect(filtered.guide).toEqual(['공개 안내']);
    expect(answer).toEqual(before);
    expect(missingLogs).toEqual([{ audience: 'public-demo' }, { audience: 'public-demo' }]);
    for (const sensitive of [/\/Users\//, /\/home\//, /\bstack\b/i, /fully autonomous/, /공개 기능/]) {
      expect(JSON.stringify(filtered)).not.toMatch(sensitive);
    }
  } finally {
    (debug as { log: typeof debug.log }).log = originalLog;
  }
});

test('brand-flagged cell and decision titles collapse by kind and count while clear facts remain', () => {
  const before = structuredClone(answer);
  const filtered = filterPublicDemoContext(answer);
  expect(filtered.facts.filter(fact => fact.kind === 'cell')).toMatchObject([
    { kind: 'cell', id: 'K6', title: '공개 기능', owner: '기술' },
    { kind: 'cell', title: '내부 항목 2개', source: '내부 원장' },
  ]);
  expect(filtered.facts.filter(fact => fact.kind === 'decision')).toMatchObject([
    { kind: 'decision', title: '내부 항목 2개', source: '내부 원장' },
  ]);
  expect(filtered.facts.find(fact => fact.kind === 'seat')).toMatchObject({ seat: '기술', title: '공개 기능', source: '내부 원장' });
  expect(answer).toEqual(before);
  expect(filterPublicDemoContext(answer)).toEqual(filtered);
  for (const text of ['available now', 'out now', 'fully autonomous', '/Users/alice/internal', 'K7', 'K8', 'D1', 'D2']) {
    expect(JSON.stringify(filtered)).not.toContain(text);
  }
});

test('public demo replaces machine-specific tokens in every free-text channel and source without losing safe data', () => {
  const filtered = filterPublicDemoContext(answer);
  expect(filtered.at).toBe(answer.at);
  expect(filtered.topic).toBe(answer.topic);
  expect(filtered.facts[0]).toMatchObject({ kind: 'version', version: '0.2.0' });
  expect(filtered.events[0]?.summary).toContain('공개 변경');
  expect(filtered.events[0]?.summary).toContain('공개 실행');
  expect(filtered.events[0]?.source).toBe('공개 주소');
  expect(filtered.guide[0]).toContain('운영 확인: 공개 변경');
  const output = JSON.stringify(filtered);
  for (const token of ['#1234', '#5678', 'run-abcdef12', 'OP', 'TC', 'node-b', '.tailnet', '/home/alice', '/Users/alice', 'github.com']) {
    expect(output).not.toContain(token);
  }
});

test('single-label hostnames are hidden when identified as hosts, without masking ordinary copy', () => {
  const filtered = filterPublicDemoContext({ ...answer,
    topic: 'hostname=msb2',
    events: [{ at: answer.at, kind: 'report', summary: 'deploy at msb2 and connect to localhost; host: stagingbox', source: 'http://localhost:8080/status' }],
    guide: ['machine=cedar and server: backup', 'release on schedule', 'msb2 localhost', 'connect to node42:8080'],
  });
  expect(filtered.topic).toBe('hostname= 공개 호스트');
  expect(filtered.events[0]?.summary).toContain('at 공개 호스트');
  expect(filtered.events[0]?.summary).toContain('공개 호스트');
  expect(filtered.events[0]?.source).toBe('공개 주소');
  expect(filtered.guide).toEqual(['machine= 공개 호스트 and server: 공개 호스트', 'release on schedule', '공개 호스트 공개 호스트', 'connect to 공개 호스트:8080']);
  for (const host of ['msb2', 'localhost', 'stagingbox', 'cedar', 'backup', 'node42']) {
    expect(JSON.stringify(filtered)).not.toContain(host);
  }
});

test('deploy and connect context hides bare hostnames and one- or two-digit PR references in event summaries', () => {
  const filtered = filterPublicDemoContext({ ...answer,
    events: [{ at: answer.at, kind: 'report', summary: 'deploy at stagingbox; connect to backup; merged #7 and #42', source: '내부 출처' }],
  });
  expect(filtered.events[0]?.summary).toBe('deploy at 공개 호스트; connect to 공개 호스트; merged 공개 변경 and 공개 변경');
  for (const token of ['stagingbox', 'backup', '#7', '#42']) {
    expect(JSON.stringify(filtered)).not.toContain(token);
  }
});

test('collapsed open decisions remain pending for public voice even when another decision is not open', () => {
  const privateDecisions: ContextNowAnswer = { ...answer, facts: [
    { kind: 'decision', id: 'D1', title: 'fully autonomous', status: 'closed', dueAt: null, source: 'elanous://decisions/D1' },
    { kind: 'decision', id: 'D2', title: 'available now', status: 'open', dueAt: null, source: 'elanous://decisions/D2' },
    { kind: 'cell', version: '0.2.0', id: 'K6', title: '공개 기능', status: 'red', owner: null, source: 'elanous://release/0.2.0/checklist#K6' },
  ] };
  const filtered = filterPublicDemoContext(privateDecisions);
  expect(filtered.facts.find(fact => fact.kind === 'decision')).toMatchObject({ title: '내부 항목 2개', status: 'open' });
  expect(renderVoiceNow(privateDecisions, 'public-demo')).toContain('다음은 내부 항목 2개 결정이 필요합니다');
  expect(renderVoiceNow(privateDecisions, 'public-demo')).not.toContain('공개 기능 칸을 확인해야 합니다');
  expect(renderVoiceNow(filtered, 'public-demo')).toContain('다음은 내부 항목 2개 결정이 필요합니다');
  const closedOnly = filterPublicDemoContext({ ...privateDecisions, facts: privateDecisions.facts.filter(fact => fact.kind !== 'decision' || fact.status !== 'open') });
  expect(closedOnly.facts.find(fact => fact.kind === 'decision')).toMatchObject({ title: '내부 항목 1개', status: '진행 중' });
});

test('public-demo audience filters contextNow and every renderer while operator output stays unchanged', () => {
  const deps: ContextNowDeps = {
    now: () => new Date(answer.at), version: () => '0.2.0',
    checklist: version => ({ version, released: '', dev: version, history: [], items: version === '0.2.0'
      ? [{ id: 'K7', title: 'available now', status: 'red', updatedAt: answer.at, updatedBy: 'TC' }] : [] }),
    decisions: () => [], seatEntries: () => [], events: () => [],
  };
  const raw = contextNow({}, deps);
  const publicAnswer = contextNow({ audience: 'public-demo' }, deps);
  expect(raw.facts.some(fact => fact.kind === 'cell' && fact.title === 'available now')).toBe(true);
  expect(publicAnswer.facts.some(fact => fact.kind === 'cell' && fact.title === '내부 항목 1개')).toBe(true);
  expect(contextNow({ audience: 'operator' }, deps)).toEqual(raw);
  expect(contextNow({ audience: 'user' }, deps)).toEqual(raw);
  const outputs = [renderTelegramNow(raw, 'public-demo'), renderTuiNow(raw, 'public-demo').join('\n'),
    renderVoiceNow(raw, 'public-demo'), JSON.stringify(renderCardNow(raw, 'public-demo'))];
  for (const output of outputs) {
    expect(output).toContain('내부 항목 1개');
    expect(output).not.toContain('available now');
  }
  const seatAnswer: ContextNowAnswer = { ...raw, facts: [
    { kind: 'seat', seat: 'TC', at: answer.at, status: 'doing', id: null, title: '공개 기능', source: 'elanous://seat-loop/TC/1' },
  ] };
  expect(renderVoiceNow(seatAnswer, 'public-demo')).toContain('기술 공개 기능');
  expect(renderVoiceNow(seatAnswer, 'public-demo')).not.toContain('TC');
  expect(renderVoiceNow(filterPublicDemoContext(seatAnswer), 'public-demo')).toContain('기술 공개 기능');
  expect(renderTelegramNow(raw)).toContain('available now');
  expect(renderTuiNow(raw).join('\n')).toContain('available now');
  expect(renderVoiceNow(raw)).toContain('available now');
  expect(JSON.stringify(renderCardNow(raw))).toContain('available now');
});

test('brand rules also reject glossary and non-title phrases, without hiding a different safe decision', () => {
  const filtered = filterPublicDemoContext({ ...answer, facts: [
    { kind: 'decision', id: 'D3', title: '승인 검토', status: 'open', dueAt: null, source: 'elanous://decisions/D3' },
    { kind: 'cell', version: '0.2.0', id: 'K9', title: '공지 검토', status: 'yellow', owner: null, source: 'elanous://release/0.2.0/checklist#K9' },
  ], events: [{ at: answer.at, kind: 'report', summary: 'launching today', source: 'elanous://events/1' }], guide: ['out now 내부 안내'] });
  expect(filtered.facts.map(fact => fact.kind)).toEqual(['decision', 'cell']);
  expect(filtered.events[0]?.summary).toBe('공개 소식');
  expect(filtered.guide).toEqual(['공개 안내']);
});

test('bare host words after host/ssh verbs and user@host are hidden (review must-fix)', () => {
  const filtered = filterPublicDemoContext({ ...answer,
    events: [{ at: answer.at, kind: 'report', summary: 'hostname stagingbox; ssh stagingbox; deploy@cedarbox ready', source: '내부 출처' }],
    guide: ['scp to backupbox done', 'machine cedar online'],
  });
  for (const host of ['stagingbox', 'cedarbox', 'backupbox', 'cedar']) {
    expect(JSON.stringify(filtered)).not.toContain(host);
  }
  expect(filtered.events[0]?.summary).toContain('ssh 공개 호스트');
});

test('home paths beyond /home and /Users are hidden: ~, /root, $HOME (review must-fix)', () => {
  const filtered = filterPublicDemoContext({ ...answer,
    events: [{ at: answer.at, kind: 'report', summary: 'wrote ~/private/plan and $HOME/.config/x', source: '내부 출처' }],
    guide: ['key at /root/.ssh/id_rsa', 'see ${HOME}/notes and /root'],
  });
  const output = JSON.stringify(filtered);
  for (const path of ['~/private', '/root/.ssh', 'id_rsa', '$HOME/.config', '${HOME}/notes', '/root']) {
    expect(output).not.toContain(path);
  }
  expect(filtered.guide[0]).toContain('공개 경로');
});

test('public demo answer carries hiddenCount of collapsed internal items; operator answer has none', () => {
  expect(filterPublicDemoContext(answer).hiddenCount).toBe(4);
  expect(answer.hiddenCount).toBeUndefined();
});
