import { describe, expect, test } from 'bun:test';
import { createTask } from '../types.js';
import { buildApprovalSummary, finalize, type IdeaApprovalGh } from './idea-approval-pr.js';

const task = createTask({
  title: '[dev] usage runs by role',
  description: 'why: 판정 비용을 잴 자가 없다\n수용기준: usage runs --by role 이 역할별 행을 낸다\n원문: https://x.com/example/status/1',
  generatedBy: { kind: 'external', provider: 'intake', ref: 'ledger:1' },
  surface: { kind: 'llm-direct', prompt: 'implement' },
});

describe('intake idea PR approval', () => {
  test('writes six-field summary ahead of original body, then readies and labels; repeated call does not edit body', async () => {
    const calls: string[][] = [];
    let body = '원래 본문';
    let isDraft = true;
    const labels: string[] = [];
    const gh: IdeaApprovalGh = async (args) => {
      calls.push(args);
      if (args[1] === 'view') return JSON.stringify({ body, isDraft, labels: labels.map((name) => ({ name })) });
      if (args.includes('--body')) body = args[args.indexOf('--body') + 1]!;
      if (args[1] === 'ready') isDraft = false;
      if (args.includes('--add-label')) labels.push(args[args.indexOf('--add-label') + 1]!, args.at(-1)!);
      return '';
    };
    const input = { task, runId: 'run-1', prUrl: 'https://github.com/example/repo/pull/123', ok: true, gh };
    const first = await finalize(input);
    expect(calls.map((args) => args.slice(0, 2).join(' '))).toEqual(['pr view', 'pr edit', 'pr ready', 'pr edit']);
    expect(calls[1]).toEqual(['pr', 'edit', input.prUrl, '--body', body]);
    expect(calls[3]).toEqual(['pr', 'edit', input.prUrl, '--add-label', 'elanous:idea-approval', '--add-label', 'elanous:from-intake']);
    expect(body).toStartWith('아이디어: ledger:1\n\n## 승인 요약\n');
    for (const heading of ['한 줄', '원문 (출발점)', 'SCQA', '과정', '머지하면 좋아지는 것', '바뀌는 것 / 위험']) {
      expect(body).toContain(`**${heading}**`);
    }
    expect(body).toContain('https://x.com/example/status/1');
    expect(body).toContain('해설에 없음');
    expect(body).toContain('<!-- elanous:approval-summary-end -->');
    expect(body).toEndWith('원래 본문');
    expect(first).toMatchObject({ pr: '123', ready: true, labeled: true, summaryChars: buildApprovalSummary(input).length });
    expect(first.missingFields).toContain('작성자');
    await finalize(input);
    expect(calls.slice(4)).toEqual([['pr', 'view', input.prUrl, '--json', 'body,isDraft,labels']]);
  });

  test('replaces harness running and origin labels when promoting an intake PR', async () => {
    const calls: string[][] = [];
    const gh: IdeaApprovalGh = async (args) => {
      calls.push(args);
      if (args[1] === 'view') return JSON.stringify({
        body: '원래 본문', isDraft: true,
        labels: [{ name: 'elanous:running' }, { name: 'elanous:from-harness' }],
      });
      return '';
    };
    await finalize({ task, runId: 'run-1', prUrl: 'https://github.com/example/repo/pull/123', ok: true, gh });
    expect(calls[3]).toEqual([
      'pr', 'edit', 'https://github.com/example/repo/pull/123', '--add-label', 'elanous:idea-approval', '--add-label', 'elanous:from-intake',
      '--remove-label', 'elanous:running', '--remove-label', 'elanous:from-harness',
    ]);
  });

  test('incomplete existing summary is never promoted by ready or approval labels', async () => {
    const calls: string[][] = [];
    const input = { task, runId: 'run-1', prUrl: 'https://github.com/other/repo/pull/123', ok: true };
    const gh: IdeaApprovalGh = async (args) => {
      calls.push(args);
      if (args[1] === 'view') return JSON.stringify({ body: '아이디어: ledger:1\n\n## 승인 요약\n불완전', isDraft: true, labels: [] });
      throw new Error('must not promote incomplete summary');
    };
    expect(finalize({ ...input, gh })).rejects.toThrow('PR approval summary incomplete');
    expect(calls).toEqual([['pr', 'view', input.prUrl, '--json', 'body,isDraft,labels']]);
  });

  test('rewrites a stale or empty six-heading summary with current task and run before promotion', async () => {
    for (const stale of [
      '## 승인 요약\n**한 줄** — \n**원문 (출발점)** — \n**SCQA** — \n**과정** — \n**머지하면 좋아지는 것** — \n**바뀌는 것 / 위험** — ',
      buildApprovalSummary({ task, runId: 'previous-run', prUrl: 'https://github.com/example/repo/pull/123', ok: true }),
    ]) {
      let body = `아이디어: ledger:1\n\n${stale}\n\n원래 본문`;
      const calls: string[][] = [];
      const gh: IdeaApprovalGh = async (args) => {
        calls.push(args);
        if (args[1] === 'view') return JSON.stringify({ body, isDraft: true, labels: [] });
        if (args.includes('--body')) body = args[args.indexOf('--body') + 1]!;
        return '';
      };
      const input = { task, runId: 'current-run', prUrl: 'https://github.com/example/repo/pull/123', ok: true, gh };
      await finalize(input);
      expect(calls.map((args) => args.slice(0, 2).join(' '))).toEqual(['pr view', 'pr edit', 'pr ready', 'pr edit']);
      expect(body).toBe(`아이디어: ledger:1\n\n${buildApprovalSummary(input)}\n\n<!-- elanous:approval-summary-end -->\n\n원래 본문`);
      expect(body).toContain('current-run');
      expect(body).not.toContain('previous-run');
    }
  });

  test('replaces the whole previous summary even when its six fields contain blank lines', async () => {
    const input = { task, runId: 'current-run', prUrl: 'https://github.com/example/repo/pull/123', ok: true };
    const previous = buildApprovalSummary({ ...input, runId: 'previous-run' }).replace('**과정**', '\n옛 요약 설명\n\n**과정**');
    let body = `아이디어: ledger:1\n\n${previous}\n\n원래 본문`;
    const calls: string[][] = [];
    const gh: IdeaApprovalGh = async (args) => {
      calls.push(args);
      if (args[1] === 'view') return JSON.stringify({ body, isDraft: true, labels: [] });
      if (args.includes('--body')) body = args[args.indexOf('--body') + 1]!;
      return '';
    };
    await finalize({ ...input, gh });
    expect(calls.map((args) => args.slice(0, 2).join(' '))).toEqual(['pr view', 'pr edit', 'pr ready', 'pr edit']);
    expect(body).toBe(`아이디어: ledger:1\n\n${buildApprovalSummary(input)}\n\n<!-- elanous:approval-summary-end -->\n\n원래 본문`);
    expect(body).not.toContain('옛 요약 설명');
    expect(body).not.toContain('previous-run');
  });

  test('replaces a marked summary with blank lines after its last field without leaving stale text', async () => {
    const input = { task, prUrl: 'https://github.com/example/repo/pull/123', runId: 'new-run', ok: true };
    const old = buildApprovalSummary({ ...input, runId: 'old-run' });
    let body = `아이디어: ledger:1\n\n${old}\n\n옛 위험 상세\n\n<!-- elanous:approval-summary-end -->\n\n원래 본문\n\n## 요청\n기존 요청`;
    const calls: string[][] = [];
    const gh: IdeaApprovalGh = async (args) => {
      calls.push(args);
      if (args[1] === 'view') return JSON.stringify({ body, isDraft: true, labels: [] });
      if (args.includes('--body')) body = args[args.indexOf('--body') + 1]!;
      return '';
    };
    await finalize({ ...input, gh });
    expect(body).toBe(`아이디어: ledger:1\n\n${buildApprovalSummary(input)}\n\n<!-- elanous:approval-summary-end -->\n\n원래 본문\n\n## 요청\n기존 요청`);
    expect(body).not.toContain('옛 위험 상세');
    expect(body).not.toContain('old-run');
    expect(calls.map((args) => args.slice(0, 2).join(' '))).toEqual(['pr view', 'pr edit', 'pr ready', 'pr edit']);
  });

  test('refuses an unmarked previous summary when a second paragraph could be stale summary text', async () => {
    const calls: string[][] = [];
    const previous = buildApprovalSummary({ task, prUrl: 'https://github.com/example/repo/pull/123', ok: true });
    const gh: IdeaApprovalGh = async (args) => {
      calls.push(args);
      if (args[1] === 'view') return JSON.stringify({
        body: `아이디어: ledger:1\n\n${previous}\n\n옛 요약 덧붙임\n\n원래 본문`, isDraft: true, labels: [],
      });
      throw new Error('must not promote');
    };
    expect(finalize({ task, prUrl: 'https://github.com/example/repo/pull/123', ok: true, gh })).rejects.toThrow('PR approval summary incomplete');
    expect(calls).toHaveLength(1);
  });

  test('refuses ambiguous blank lines in the last field rather than promoting stale text', async () => {
    const calls: string[][] = [];
    const gh: IdeaApprovalGh = async (args) => {
      calls.push(args);
      if (args[1] === 'view') return JSON.stringify({
        body: '아이디어: ledger:1\n\n## 승인 요약\n**한 줄** — 예전 제목\n**원문 (출발점)** — 옛 링크\n**SCQA** — 옛 이야기\n**과정** — 옛 과정\n**머지하면 좋아지는 것** — 옛 목표\n**바뀌는 것 / 위험** — 옛 위험\n\n이전 요약의 나머지\n\n원래 본문',
        isDraft: true, labels: [],
      });
      throw new Error('must not promote');
    };
    expect(finalize({ task, prUrl: 'https://github.com/example/repo/pull/123', ok: true, gh })).rejects.toThrow('PR approval summary incomplete');
    expect(calls).toHaveLength(1);
  });

  test('refuses a blank line inside the final field before its PR footer', async () => {
    const calls: string[][] = [];
    const previous = buildApprovalSummary({ task, prUrl: 'https://github.com/example/repo/pull/123', ok: true })
      .replace(' · PR: https://github.com/example/repo/pull/123', '\n\n옛 위험 설명 · PR: https://github.com/example/repo/pull/123');
    const gh: IdeaApprovalGh = async (args) => {
      calls.push(args);
      if (args[1] === 'view') return JSON.stringify({ body: `아이디어: ledger:1\n\n${previous}\n\n원래 본문`, isDraft: true, labels: [] });
      throw new Error('must not promote');
    };
    expect(finalize({ task, prUrl: 'https://github.com/example/repo/pull/123', ok: true, gh })).rejects.toThrow('PR approval summary incomplete');
    expect(calls).toHaveLength(1);
  });

  test('does not promote a summary whose last field cannot be separated from the original body', async () => {
    const calls: string[][] = [];
    const gh: IdeaApprovalGh = async (args) => {
      calls.push(args);
      if (args[1] === 'view') return JSON.stringify({
        body: `아이디어: ledger:1\n\n${buildApprovalSummary({ task, prUrl: 'https://github.com/example/repo/pull/123', ok: true })}`,
        isDraft: true, labels: [],
      });
      throw new Error('must not promote');
    };
    expect(finalize({ task, prUrl: 'https://github.com/example/repo/pull/123', ok: true, gh })).rejects.toThrow('PR approval summary incomplete');
    expect(calls).toHaveLength(1);
  });

  test('stale summary edit failure cannot ready or label an already marked PR', async () => {
    const calls: string[][] = [];
    const gh: IdeaApprovalGh = async (args) => {
      calls.push(args);
      if (args[1] === 'view') return JSON.stringify({
        body: `아이디어: ledger:1\n\n${buildApprovalSummary({ task, runId: 'previous-run', prUrl: 'https://github.com/example/repo/pull/123', ok: true })}\n\n원래 본문`,
        isDraft: true, labels: [],
      });
      throw new Error('stale body edit failed');
    };
    expect(finalize({ task, runId: 'current-run', prUrl: 'https://github.com/example/repo/pull/123', ok: true, gh })).rejects.toThrow('stale body edit failed');
    expect(calls.map((args) => args.slice(0, 2).join(' '))).toEqual(['pr view', 'pr edit']);
    expect(calls[1]).toContain('--body');
  });

  test('failed harness run never promotes draft PR even if a URL exists', async () => {
    const calls: string[][] = [];
    const result = await finalize({
      task, runId: 'run-failed', prUrl: 'https://github.com/other/repo/pull/123', ok: false,
      gh: async (args) => { calls.push(args); throw new Error('must not call gh'); },
    });
    expect(result).toMatchObject({ pr: '123', ready: false, labeled: false });
    expect(calls).toEqual([]);
  });

  test('body editing failure never readies or labels', async () => {
    const calls: string[][] = [];
    const gh: IdeaApprovalGh = async (args) => {
      calls.push(args);
      if (args[1] === 'view') return JSON.stringify({ body: '원래 본문', isDraft: true, labels: [] });
      throw new Error('body edit failed');
    };
    expect(finalize({ task, runId: 'run-1', prUrl: 'https://github.com/example/repo/pull/123', ok: true, gh })).rejects.toThrow('body edit failed');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.includes('--body')).toBe(true);
  });
});
