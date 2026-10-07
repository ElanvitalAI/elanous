import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { appendSkillRun, proposeSkillFixes, readSkillRuns, type SkillRun } from './skill-feedback.js';

function run(runId: string, skill = 'omni-crawl', failureKind = 'timeout'): SkillRun {
  return {
    skill, runId, outcome: 'failure', failureKind,
    userCorrected: false, retries: 0, durationMs: 120,
    at: `2026-10-06T00:00:0${runId.replace(/\D/g, '') || '0'}Z`,
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('skill feedback (shadow only)', () => {
  test('same skill and timeout failure x3 yields one proposal and three evidence ids', () => {
    const before = debug.events(1).at(-1);
    const proposals = proposeSkillFixes([run('r1'), run('r2'), run('r3')]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      skill: 'omni-crawl', failureKind: 'timeout', evidenceRunIds: ['r1', 'r2', 'r3'],
    });
    expect(proposals[0]!.suggestion).toContain('timeout');
    expect(proposals[0]!.expectedEffect).toContain('timeout');
    const latest = debug.events(1).at(-1);
    expect(latest).not.toBe(before);
    expect(latest).toMatchObject({ category: 'skill.feedback', event: 'proposal', data: {
      skill: 'omni-crawl', failureKind: 'timeout', runs: 3,
    } });
  });

  test('same failure x2 stays below the default threshold', () => {
    expect(proposeSkillFixes([run('r1'), run('r2')])).toEqual([]);
  });

  test('one timeout, parse and auth failure each cannot combine', () => {
    expect(proposeSkillFixes([run('r1', 'omni-crawl', 'timeout'), run('r2', 'omni-crawl', 'parse'), run('r3', 'omni-crawl', 'auth')])).toEqual([]);
  });

  test('two different skills with two timeouts each cannot combine', () => {
    expect(proposeSkillFixes([
      run('r1', 'omni-crawl'), run('r2', 'omni-crawl'),
      run('r3', 'omni-digest'), run('r4', 'omni-digest'),
    ])).toEqual([]);
  });

  test('duplicate run ids count as one execution, and evidence includes each execution once', () => {
    expect(proposeSkillFixes([run('r1'), run('r1'), run('r1')])).toEqual([]);
    const proposals = proposeSkillFixes([
      run('r1'), run('r2'), run('r2'), run('r3'), run('r4'), run('r4'),
    ]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      skill: 'omni-crawl', failureKind: 'timeout', evidenceRunIds: ['r2', 'r3', 'r4'],
    });
  });

  test('three JSONL appends round-trip; proposing does not modify SKILL.md or ledger', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-feedback-'));
    dirs.push(dir);
    const ledgerPath = join(dir, 'runs.jsonl');
    const skillPath = join(dir, 'SKILL.md');
    const fixture = Buffer.from('# omni-crawl\r\n\0unchanged\n');
    writeFileSync(skillPath, fixture);
    for (const id of ['r1', 'r2', 'r3']) appendSkillRun(ledgerPath, run(id));
    const ledgerBefore = readFileSync(ledgerPath);
    expect(ledgerBefore.toString('utf8').split('\n').filter(Boolean)).toHaveLength(3);
    expect(readSkillRuns(ledgerPath)).toEqual([run('r1'), run('r2'), run('r3')]);
    const before = readFileSync(skillPath);
    expect(proposeSkillFixes(readSkillRuns(ledgerPath))).toHaveLength(1);
    expect(readFileSync(skillPath).equals(before)).toBe(true);
    expect(readFileSync(ledgerPath).equals(ledgerBefore)).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(['SKILL.md', 'runs.jsonl']);
  });

  test('only failures count; configurable threshold and newest three timestamps', () => {
    const success = { ...run('r5'), outcome: 'success' as const };
    expect(proposeSkillFixes([run('r4'), run('r1'), success, run('r3'), run('r2')], { threshold: 4 }))
      .toMatchObject([{ evidenceRunIds: ['r2', 'r3', 'r4'] }]);
    expect(proposeSkillFixes([run('r1'), run('r2')], { threshold: 2 })).toHaveLength(1);
  });

  test('an absent ledger reads as empty without creating a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-feedback-'));
    dirs.push(dir);
    expect(readSkillRuns(join(dir, 'missing.jsonl'))).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });
});
