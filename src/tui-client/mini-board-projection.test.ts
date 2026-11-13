import { expect, test } from 'bun:test';
import type { RenderCtx } from '../plugins/core/types.js';
import type { WidgetContext } from '../widgets/types.js';
import type { TaskCardEntry } from '../../apps/pwa/src/lib/task-card-model.js';
import { formatTuiMiniBoardCard, projectTuiMiniBoard, renderTuiMiniBoard } from './mini-board-projection.js';
import miniBoardWidget, { type MiniBoardWidgetState } from '../widgets/mini-board.js';

function event(taskId: string, section: TaskCardEntry['section'], ts: number, key: string, data: Record<string, unknown>, runId = 'run-42c1abcd'): TaskCardEntry {
  return { taskId, section, ts, key, data, owner: 'sim', runId };
}

test('projects the existing card journal into PWA columns and contractual card fields', () => {
  const events = [
    event('task-1', 'intake', 1, 'intake', { title: 'KAIST 데모', summary: '요청 정리' }),
    event('task-1', 'landing', 2, 'landing', { summary: '소유자 승인' }),
    event('task-1', 'workspace', 3, 'workspace', { summary: '화면 작업' }),
    event('task-1', 'release', 4, 'release-test', { status: 'testing', summary: '원격 확인 중', resultUrl: 'https://hidden.test' }),
    event('task-1', 'release', 5, 'release-progress', { status: 'testing' }),
    event('task-2', 'intake', 5, 'intake', { title: '완료 카드' }),
    event('task-2', 'release', 6, 'release-done', { status: 'done', summary: '리허설 완료', publicUrl: 'https://demo.example.test' }),
  ];

  const board = projectTuiMiniBoard(events, Date.UTC(2026, 10, 9, 3, 4));
  expect(board.columns.map((column) => column.id)).toEqual(['steward', 'landing', 'execution', 'release', 'done']);
  expect(board.columns.map((column) => column.label)).toEqual(['제안', '승인', '개발 중', '시험', '배포됨']);
  expect(board.columns[3]!.cards[0]).toMatchObject({
    taskId: 'task-1', title: 'KAIST 데모', summary: '원격 확인 중', runId: '42c1abcd',
  });
  expect(board.columns[3]!.cards[0]).not.toHaveProperty('resultUrl');
  expect(board.columns[4]!.cards[0]).toMatchObject({
    taskId: 'task-2', title: '완료 카드', summary: '리허설 완료', resultUrl: 'https://demo.example.test',
  });
  expect(formatTuiMiniBoardCard(board.columns[4]!.cards[0]!)).toBe('완료 카드 · 리허설 완료 · run 42c1abcd · ↗ https://demo.example.test');
});

test('renders five columns wide and folds into ordered vertical cards on narrow terminals', () => {
  const board = projectTuiMiniBoard([
    event('task-1', 'intake', 1, 'a', { title: 'DB 읽기 뷰', summary: '요청 정리' }),
    event('task-2', 'landing', 2, 'b', { title: 'KAIST 데모', summary: '소유자 승인' }),
    event('task-3', 'workspace', 3, 'c', { title: 'PWA 작업', summary: '화면 작업' }),
    event('task-4', 'release', 4, 'd', { title: 'API 리허설', summary: '원격 확인 중', status: 'testing' }),
    event('task-5', 'release', 5, 'e', { title: '디자인 체크', summary: '리허설 완료', status: 'done', resultUrl: 'https://demo.example.test' }),
  ], Date.UTC(2026, 10, 9, 3, 4));

  const wide = renderTuiMiniBoard(board, 200);
  expect(wide[0]).toMatch(/^미니 보드 · 갱신 \d{2}:\d{2}$/);
  expect(wide[1]).toContain('제안(1)');
  expect(wide[1]).toContain('개발 중(1)');
  expect(wide.join('\n')).toContain('↗ https://demo.example.test');
  expect(wide.join('\n')).toContain('run 42c1abcd');
  const narrowWide = renderTuiMiniBoard(projectTuiMiniBoard([
    event('done-only', 'release', 1, 'done', { title: '완료', status: 'done', resultUrl: 'https://demo.example.test/a/longer/path' }),
  ]), 90).join('').replace(/\s+/g, '');
  expect(narrowWide).toContain('https://demo.example.test/a/longer/path');

  const narrow = renderTuiMiniBoard(board, 60).map((line) => line.trimEnd());
  expect(narrow[1]).toBe('제안(1)');
  expect(narrow).toContain('  DB 읽기 뷰 · 요청 정리 · run 42c1abcd');
  expect(narrow.indexOf('시험(1)')).toBeLessThan(narrow.indexOf('배포됨(1)'));
  expect(narrow.join('').replace(/\s+/g, '')).toContain('↗https://demo.example.test');
});

test('widget scroll exposes every board column when the pane is shorter than its content', () => {
  const events: TaskCardEntry[] = [
    event('task-1', 'intake', 1, 'a', { title: '제안 카드', summary: '요약' }),
    event('task-2', 'landing', 2, 'b', { title: '승인 카드', summary: '요약' }),
    event('task-3', 'workspace', 3, 'c', { title: '개발 카드', summary: '요약' }),
    event('task-4', 'release', 4, 'd', { title: '시험 카드', summary: '요약', status: 'testing' }),
    event('task-5', 'intake', 4, 'e-intake', { title: '완료 카드', summary: '요약' }),
    event('task-5', 'release', 5, 'e', { title: '완료 카드', summary: '요약', status: 'done', resultUrl: 'https://demo.example.test' }),
  ];
  const state = miniBoardWidget.initialState({ events, updatedAt: 0 });
  const renderCtx = { width: 60, height: 6 } as RenderCtx;
  const firstPage = miniBoardWidget.render(state, renderCtx, '미니 보드');
  expect(firstPage).toHaveLength(6);
  expect(firstPage.join('\n')).not.toContain('배포됨(1)');

  const key = { name: 'G' } as Parameters<NonNullable<typeof miniBoardWidget.onKey>>[0];
  const widgetCtx = { width: 60, height: 6 } as WidgetContext<MiniBoardWidgetState>;
  expect(miniBoardWidget.onKey?.(key, state, widgetCtx)).toEqual({ type: 'refresh' });
  const lastPage = miniBoardWidget.render(state, renderCtx, '미니 보드');
  expect(lastPage).toHaveLength(6);
  expect(lastPage.join('\n')).toContain('배포됨(1)');
  expect(lastPage.join('\n')).toContain('완료 카드');
});

test('Scene 6 NEXT projection shows diagram and PDF links on the deployed card', () => {
  const board = projectTuiMiniBoard([event('scene-6', 'intake', 0, 'intake', { title: '티켓팅 MVP' }), event('scene-6', 'release', 1, 'released', {
    title: '티켓팅 MVP', status: 'done', attachments: [
      { kind: 'diagram', title: '아키텍처', url: 'https://demo.example.test/diagram.svg' },
      { kind: 'pdf', title: '설계 보고서', url: 'https://demo.example.test/report.pdf' },
    ],
  })], 1);
  const text = renderTuiMiniBoard(board, 60).join('\n');
  expect(text).toContain('배포됨(1)');
  expect(text).toContain('티켓팅 MVP');
  expect(text).toContain('도면 아키텍처');
  expect(text.replace(/\s+/g, '')).toContain('https://demo.example.test/diagram.svg');
  expect(text).toContain('PDF 설계 보고서');
  expect(text.replace(/\s+/g, '')).toContain('https://demo.example.test/report.pdf');
});
