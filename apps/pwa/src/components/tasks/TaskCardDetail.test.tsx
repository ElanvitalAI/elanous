import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { foldCard, type TaskCardEntry } from '@/lib/task-card-model';
import { TaskCardDetail } from './TaskCardDetail';

const entry = (section: TaskCardEntry['section'], key: string, ts: number, owner: string, data: Record<string, unknown>): TaskCardEntry =>
  ({ taskId: 'task-1', section, key, ts, owner, data });

function render(entries: TaskCardEntry[]) {
  const card = foldCard(entries);
  if (!card) throw new Error('expected a card');
  return renderToStaticMarkup(<TaskCardDetail card={card} />);
}

describe('TaskCardDetail', () => {
  test('renders the latest entry for each section with its owner, time, and collapsed JSON', () => {
    const html = render([
      entry('intake', 'intake-1', 1700000000000, 'steward', { title: 'First title' }),
      entry('gates', 'old-gate', 1700000001000, 'old-owner', { budget: 'wait' }),
      entry('gates', 'new-gate', 1700000002000, 'gate-owner', { budget: 'proceed', location: 'pod' }),
      entry('run', 'run-1', 1700000003000, 'runner', { status: 'active' }),
    ]);
    expect(html).toContain('First title');
    expect(html).toContain('aria-label="intake section"');
    expect(html).toContain('aria-label="run section"');
    expect(html).toContain('Owner: steward');
    expect(html).toContain('Owner: gate-owner');
    expect(html).toContain('Owner: runner');
    expect(html).toContain('dateTime="2023-11-14T22:13:22.000Z"');
    expect(html).toContain('&quot;status&quot;: &quot;active&quot;');
    expect(html).not.toContain('old-owner');
    expect((html.match(/<details class=/g) ?? []).length).toBe(3);
    expect(html).not.toContain('<details open');
  });

  test('summarizes gate decisions together in one line and lists every incident with its metadata', () => {
    const html = render([
      entry('gates', 'gate-1', 1700000000000, 'gatekeeper', { budget: 'wait-reset', location: 'host' }),
      entry('incidents', 'incident-1', 1700000001000, 'operator', { kind: 'quota' }),
      entry('incidents', 'incident-2', 1700000002000, 'runner', { kind: 'pod-oom' }),
    ]);
    expect(html).toMatch(/<p[^>]*aria-label="Gate decisions"[^>]*>Gate · budget: wait-reset · location: host<\/p>/);
    expect(html).toContain('Incidents (2)');
    expect(html).toContain('<ol');
    expect(html).toContain('Owner: operator');
    expect(html).toContain('Owner: runner');
    expect(html).toContain('&quot;kind&quot;: &quot;quota&quot;');
    expect(html).toContain('&quot;kind&quot;: &quot;pod-oom&quot;');
    expect((html.match(/<details class=/g) ?? []).length).toBe(3);
  });

  test('shows assigned cell, release version and live progress on one line, or an unplaced state', () => {
    const card = foldCard([entry('triage', 'wish', 1700000000000, 'steward', { title: '소원' })]);
    if (!card) throw new Error('expected a card');
    const assigned = renderToStaticMarkup(<TaskCardDetail card={card} placements={[
      { cellId: 'C1', cellTitle: '첫 칸', version: '0.2.14', status: 'yellow' },
      { cellId: 'C2', cellTitle: '둘째 칸', version: '0.2.15', status: 'done' },
    ]} />);
    expect(assigned).toMatch(/<p[^>]*aria-label="Wish placement and progress"[^>]*>배치 · C1 첫 칸 · 0.2.14판 · 진행 중 \/ C2 둘째 칸 · 0.2.15판 · 완료<\/p>/);
    expect(renderToStaticMarkup(<TaskCardDetail card={card} placements={[]} />)).toContain('배치 · 아직 배치되지 않음');
    expect(renderToStaticMarkup(<TaskCardDetail card={card} />)).not.toContain('Wish placement and progress');
  });

  test('renders stored Telegram conversation, PWA session and TUI destination; old cards have no address', () => {
    const base = foldCard([entry('intake', 'wish', 1700000000000, 'steward', { title: '소원' })]);
    if (!base) throw new Error('expected a card');
    const telegram = renderToStaticMarkup(<TaskCardDetail card={{ ...base, wishReply: { surface: 'telegram', address: '42:7' } }} />);
    expect(telegram).toContain('텔레그램 대화 · 42:7');
    expect(telegram).toContain('회신 이력');
    expect(telegram).toContain('카드 원장에는 회신 발송 이력이 기록되지 않습니다');
    expect(renderToStaticMarkup(<TaskCardDetail card={{ ...base, wishReply: { surface: 'pwa', address: 'session-1' } }} />))
      .toContain('PWA · session-1');
    expect(renderToStaticMarkup(<TaskCardDetail card={{ ...base, wishReply: { surface: 'tui', address: null } }} />))
      .toContain('TUI');
    expect(renderToStaticMarkup(<TaskCardDetail card={{ ...base, wishReply: null }} />))
      .toContain('회신 주소 없음');
  });

  test('a non-wish card shows neither reply section', () => {
    const base = foldCard([entry('intake', 'wish', 1700000000000, 'steward', { title: '일반 카드' })]);
    if (!base) throw new Error('expected a card');
    const html = renderToStaticMarkup(<TaskCardDetail card={base} />);
    expect(html).not.toContain('어디로 회신하나');
    expect(html).not.toContain('회신 이력');
  });

  test('open detail offers one-line reason and close action; public capture hides it', () => {
    const card = foldCard([entry('triage', 'open', 1700000000000, 'steward', { title: 'Open' })]);
    if (!card) throw new Error('expected a card');
    const html = renderToStaticMarkup(<TaskCardDetail card={{ ...card, status: 'open' }} onClose={async () => {}} />);
    expect(html).toContain('닫기 사유 (한 줄)');
    expect(html).toContain('type="text"');
    expect(html).toContain('type="submit"');
    expect(html).toContain('닫기</button>');
    const capture = renderToStaticMarkup(<TaskCardDetail card={{ ...card, status: 'open' }} publicCapture onClose={async () => {}} />);
    expect(capture).not.toContain('type="submit"');
    expect(capture).not.toContain('닫기 사유');
  });

  test('closed detail replaces the action with the persisted reason', () => {
    const card = foldCard([entry('triage', 'closed', 1700000000000, 'steward', { title: 'Closed' })]);
    if (!card) throw new Error('expected a card');
    const html = renderToStaticMarkup(<TaskCardDetail card={{ ...card, status: 'closed', closedReason: '완료' }} onClose={async () => {}} />);
    expect(html).toContain('닫힘 · 완료');
    expect(html).not.toContain('type="submit"');
  });

  test('does not invent a gate decision or incident when neither exists', () => {
    const html = render([entry('triage', 'triage-1', 1700000000000, 'steward', { title: 'Ready' })]);
    expect(html).not.toContain('Gate decisions');
    expect(html).toContain('No incidents.');
  });
});
