import { describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { publicExposureFiles, runExposeGate } from './expose-gate.js';

const doc = 'release/public/docs/guide.md';
const payload = JSON.stringify({ docs: 1, missing: [], orphan: [], failing: [], internal: [], unreviewed: [], unjudged: [doc] });

describe('EXPOSE-GATE', () => {
  test('PR public docs only: exact --json --files scope, Gate line, warn passes and strict blocks an unjudged doc', () => {
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const run = (command: string, args: string[], cwd: string) => {
        calls.push({ command, args, cwd });
        return { status: 0, stdout: payload };
      };
      const files = ['src/other.ts', doc, doc, 'release/public/docs/nested/not-a-rubric-doc.md', 'docs/other.md'];
      const warn = runExposeGate('/repo', files, 'warn', run);
      const strict = runExposeGate('/repo', files, 'strict', run);
      expect(warn).toEqual({ passed: true, log: '[expose] 1개 · 미판정 1 · fail 0' });
      expect(strict).toEqual({ passed: false, log: warn.log });
      expect(calls).toEqual(Array.from({ length: 2 }, () => ({ command: 'bun', args: ['scripts/expose-rubric-check.ts', '--json', '--files', doc], cwd: '/repo' })));
      expect(log.mock.calls.filter(([category, event]) => category === 'self-implement.gate' && event === 'expose').map((call) => call[2]))
        .toEqual([{ files: [doc], unreviewed: 1, failed: 0, mode: 'warn' }, { files: [doc], unreviewed: 1, failed: 0, mode: 'strict' }]);
    } finally { log.mockRestore(); }
  });

  test('deleted public doc stays in the PR count even when the checker reports an orphan', () => {
    const orphan = JSON.stringify({ docs: 0, missing: [], orphan: [doc], failing: [], internal: [], unreviewed: [], unjudged: [] });
    expect(runExposeGate('/repo', [doc], 'warn', () => ({ status: 0, stdout: orphan })))
      .toEqual({ passed: true, log: '[expose] 1개 · 미판정 0 · fail 1' });
    expect(runExposeGate('/repo', [doc], 'strict', () => ({ status: 0, stdout: orphan })).passed).toBe(false);
  });

  test('no public docs: no checker call, no Gate line, no observation', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    let calls = 0;
    try {
      const result = runExposeGate('/repo', ['docs/other.md', 'src/a.ts', 'release/public/docs/nested/a.md'], 'strict', () => {
        calls += 1;
        throw new Error('unexpected checker call');
      });
      expect(result).toEqual({ passed: true, log: '' });
      expect(calls).toBe(0);
      expect(publicExposureFiles(['release/public/docs/nested/a.md', doc])).toEqual([doc]);
      expect(log.mock.calls.some(([category, event]) => category === 'self-implement.gate' && event === 'expose')).toBe(false);
    } finally { log.mockRestore(); }
  });

  test('public TC review pending does not block strict when the rubric has a judged pass', () => {
    const reviewed = JSON.stringify({ docs: 1, missing: [], orphan: [], failing: [], internal: [], unreviewed: [doc], unjudged: [] });
    expect(runExposeGate('/repo', [doc], 'strict', () => ({ status: 0, stdout: reviewed })))
      .toEqual({ passed: true, log: '[expose] 1개 · 미판정 0 · fail 0' });
  });

  test('strict blocks fail and unmeasured checker; warn preserves landing', () => {
    const failed = JSON.stringify({ docs: 1, missing: [], orphan: [], failing: [{ path: doc, criteria: ['brand'] }], internal: [], unreviewed: [], unjudged: [] });
    expect(runExposeGate('/repo', [doc], 'strict', () => ({ status: 0, stdout: failed }))).toEqual({ passed: false, log: '[expose] 1개 · 미판정 0 · fail 1' });
    expect(runExposeGate('/repo', [doc], 'strict', () => ({ status: 2, stderr: 'ledger missing' }))).toEqual({ passed: false, log: '[expose] 못 쟀다 — ledger missing' });
    expect(runExposeGate('/repo', [doc], 'warn', () => ({ status: 2, stderr: 'ledger missing' })).passed).toBe(true);
  });
});
