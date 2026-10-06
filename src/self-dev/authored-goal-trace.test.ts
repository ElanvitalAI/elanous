import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authoredGoalTrace, recordAuthoredGoal } from './authored-goal-trace.js';
import { debug } from '../debug/log.js';

describe('AUTHOR-TRACE recordAuthoredGoal', () => {
  test('one goal-authored ledger event whose sha256 matches the archived body', () => {
    const root = mkdtempSync(join(tmpdir(), 'author-trace-'));
    try {
      const ledgerDir = join(root, 'run-ledger');
      const document = '# 골\n\n## 무엇\n한 줄\n\n## 판정 신호\nbun test x\n';
      const trace = recordAuthoredGoal({ runId: 'run-abc', authorRunId: 'author-1' }, 'docs/goals/GOAL-x.md', document, { ledgerDir });
      const lines = readFileSync(join(ledgerDir, 'run-abc.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ runId: 'run-abc', event: 'goal-authored', data: { path: 'docs/goals/GOAL-x.md', chars: [...document].length, sections: 2 } });
      const archived = readFileSync(trace.archivedAt, 'utf8');
      expect(createHash('sha256').update(archived).digest('hex')).toBe(lines[0].data.sha256);
      expect(readdirSync(join(root, 'authored-goals'))).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a re-authored goal in the same run is a second event and a second archive', () => {
    const root = mkdtempSync(join(tmpdir(), 'author-trace-'));
    try {
      const ledgerDir = join(root, 'run-ledger');
      recordAuthoredGoal({ runId: 'run-abc' }, 'a.md', 'first\n', { ledgerDir });
      recordAuthoredGoal({ runId: 'run-abc' }, 'a.md', 'second\n', { ledgerDir });
      expect(readFileSync(join(ledgerDir, 'run-abc.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
      expect(readdirSync(join(root, 'authored-goals'))).toHaveLength(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('at say time with only an authoring run id: archive ⊕ observation, no run-ledger file', () => {
    const root = mkdtempSync(join(tmpdir(), 'author-trace-'));
    try {
      const ledgerDir = join(root, 'run-ledger');
      const observed: Array<{ event: string; data: Record<string, unknown> }> = [];
      const log = debug.log;
      debug.log = ((_category, event, data) => { observed.push({ event: String(event), data: data as Record<string, unknown> }); }) as typeof debug.log;
      let trace;
      try { trace = recordAuthoredGoal({ authorRunId: 'author-9' }, 'g.md', 'body\n', { ledgerDir }); } finally { debug.log = log; }
      expect(readFileSync(trace.archivedAt, 'utf8')).toBe('body\n');
      const event = observed.find(({ event }) => event === 'goal-authored');
      expect(event?.data.sha256).toBe(createHash('sha256').update(readFileSync(trace.archivedAt, 'utf8')).digest('hex'));
      expect(event?.data.authorRunId).toBe('author-9');
      expect(trace.archivedAt).toContain('author-9-');
      expect(() => readdirSync(ledgerDir)).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('## inside a fenced code block is not a section', () => {
    expect(authoredGoalTrace('p', '## 하나\n```\n## 코드 속\n```\n~~~~\n## 또\n~~~\n## 아직 코드\n~~~~\n## 둘\n', 't').sections).toBe(2);
  });

  test('an ATX heading indented up to three spaces is a section; four spaces is code', () => {
    expect(authoredGoalTrace('p', '## 하나\n   ## 셋 칸 들여씀\n    ## 네 칸은 코드\n', 't').sections).toBe(2);
  });
});
