// 런 서랍 — 화면·로그·멈춤(확인 한 번)·승인 이동. 화면 쪽만 몬다(훅 없음).
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { awaitingApproval, RunDrawerView, type RunDrawerViewProps } from './RunDrawer';

const base: RunDrawerViewProps = {
  runId: 'run-a', lines: ['l1', 'l2'], stopState: 'idle',
  onStop: () => {}, onConfirmStop: () => {}, onCancelStop: () => {}, onClose: () => {},
};
const run = { runId: 'run-a', stages: { review: 'info' as const }, current: 'review' as const, lastTs: '', events: 3, blocked: false, pr: '42', ledgerStatus: null };

describe('RunDrawerView', () => {
  test('screen text, log lines, approvals link when a PR is open and not landed', () => {
    const html = renderToStaticMarkup(<RunDrawerView {...base} run={run} screen={{ runId: 'run-a', screenKey: 'space-a', text: 'GOAL-LOOP R2', stoppable: true }} />);
    expect(html).toContain('GOAL-LOOP R2');
    expect(html).toContain('l1\nl2');
    expect(html).toContain('/approvals?pr=42');
    expect(html).toContain('data-elanous-action="live-run-stop"');
    expect(html).not.toContain('disabled=""');
  });

  test('missing screen shows the reason, stop is disabled without a live screen', () => {
    const html = renderToStaticMarkup(<RunDrawerView {...base} screen={{ runId: 'run-a', screenKey: null, text: null, stoppable: false, reason: 'no-screen-key' }} />);
    expect(html).toContain('다른 우주');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('/approvals');
  });

  test('stop asks once before sending', () => {
    const html = renderToStaticMarkup(<RunDrawerView {...base} stopState="confirm" screen={{ runId: 'run-a', screenKey: 'space-a', text: 'x', stoppable: true }} />);
    expect(html).toContain('되돌릴 수 없습니다');
    expect(html).toContain('live-run-stop-confirm');
  });

  test('awaitingApproval: PR open and not landed', () => {
    expect(awaitingApproval(run)).toBe(true);
    expect(awaitingApproval({ ...run, stages: { land: 'ok' } })).toBe(false);
    expect(awaitingApproval({ ...run, pr: null })).toBe(false);
  });

  test('MAX «이 런만» asks once before turning on', () => {
    const idle = renderToStaticMarkup(<RunDrawerView {...base} max={{ state: 'idle', ask: () => {}, confirm: () => {}, cancel: () => {} }} />);
    expect(idle).toContain('data-elanous-action="live-run-max"');
    const confirm = renderToStaticMarkup(<RunDrawerView {...base} max={{ state: 'confirm', ask: () => {}, confirm: () => {}, cancel: () => {} }} />);
    expect(confirm).toContain('live-run-max-confirm');
    expect(renderToStaticMarkup(<RunDrawerView {...base} />)).not.toContain('live-run-max');
  });
});
