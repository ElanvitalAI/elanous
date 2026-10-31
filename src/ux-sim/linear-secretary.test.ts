import { describe, expect, test } from 'bun:test';
import { LogStore } from '../mss/logging/log-store.js';
import { simLinearSecretary } from './linear-secretary.js';

describe('DEMO1104-LINEAR-SECRETARY integrated test device', () => {
  test('one line creates grounded children, absorbs progress, attaches browser capture, and leaves approval open with run evidence', async () => {
    const result = await simLinearSecretary();
    try {
    expect(result.reply).toContain('등록: 부모 1개 · 하위 3개');
    expect(result.runId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(result.childIssueIds).toHaveLength(3);
    expect(result.completedIssueIds).toEqual(result.childIssueIds);
    expect(result.childEvidence).toHaveLength(3);
    expect(result.childEvidence.every(child => child.description.includes('근거:'))).toBe(true);
    expect(result.childEvidence[0]?.description).toContain(`elanous:intake:${result.intakeIds[0]}`);
    const browserAttachment = result.browserAttachment;
    if (!browserAttachment) throw new Error('integrated scene did not produce a browser attachment');
    expect(browserAttachment).toMatchObject({ issueId: result.childIssueIds[1] });
    expect(result.browserRunId).toBe(result.runId);
    expect(result.browserActionRunIds).toContain(result.runId);
    expect(result.linearAttachments).toContainEqual({ issueId: result.parentIssueId, url: browserAttachment.url });
    expect(result.progressCommentCount).toBe(6);
    expect(result.approvalCard?.text).toContain('11-04 Linear 데모 게시 승인');
    expect(result.approvalCard?.text).toContain('되돌릴 수 없음');
    expect(result.approvalCard?.buttons.flat().map(button => button.data)).toContain(`dec:${result.approvalCard?.id}:a`);
    expect(result.approvalCardStatus).toBe('open');
    expect(result.runEvidence).toEqual({ category: 'ux.sim.linear-secretary', event: 'completed', persisted: true });
    const checkerStore = new LogStore(result.evidencePath, { readonly: true });
    try {
      const checkerEvents = checkerStore.queryByDataKeys({ exactCategories: ['ux.sim.linear-secretary'], runIds: [result.runId] });
      expect(checkerEvents.filter(row => row.event === 'completed')).toHaveLength(1);
      expect(JSON.parse(String(checkerEvents.find(row => row.event === 'browser-capture-attached')?.data))).toMatchObject({ runId: result.runId });
      expect(JSON.parse(String(checkerEvents.find(row => row.event === 'approval-card-opened')?.data))).toMatchObject({ runId: result.runId });
    } finally { checkerStore.close(); }
    expect(result.runEvents).toEqual([
      'request-received', 'secretary-started', 'intake-submit-observed', 'intake-ledger-seam-completed', 'breakdown-created', 'subtask-absorbed',
      'browser-capture-attached', 'subtask-absorbed', 'subtask-absorbed', 'approval-card-opened', 'completed',
    ]);
    expect(result.externalCalls).toBeGreaterThan(0); // all counted calls were served by the local fake fetch
    } finally { result.cleanup(); }
  });
});
