import { describe, expect, test } from 'bun:test';
import { verdictForFinalPtyScreen } from './pty-drive-verdict.js';

describe('verdictForFinalPtyScreen', () => {
  test.each([1, 2, 127])('nonzero child exit code %i overrides success evidence', (exitCode) => {
    expect(verdictForFinalPtyScreen({ screen: '5 pass\nGOAL-COMPLETE', inputHistory: [], exitCode }))
      .toEqual({ kind: 'done-but-failed', reason: `child exit code ${exitCode}`, evidence: null });
  });

  test('command not found takes precedence over a later success marker', () => {
    expect(verdictForFinalPtyScreen({ screen: 'bash: build-tool: command not found\n5 pass', inputHistory: ['build-tool\r'], exitCode: 0 }))
      .toEqual({ kind: 'done-but-failed', reason: 'bash: build-tool: command not found', evidence: null });
  });

  test.each(['1 fail', '1 failing', '1 failure', '1 failures', 'Permission denied'])('%s takes precedence over passing tests and a completion marker', (failure) => {
    const verdict = verdictForFinalPtyScreen({ screen: `7 pass\n${failure}\nGOAL-COMPLETE`, inputHistory: [], exitCode: null });
    expect(verdict).toEqual({ kind: 'done-but-failed', reason: failure, evidence: null });
  });

  test.each(['rg --files -g AGENTS.md', 'grep -q target missing.txt', 'diff a.txt b.txt'])(
    '%s exit 1 is a no-match/difference rather than mission failure', (command) => {
      expect(verdictForFinalPtyScreen({ screen: `• Failed (exit 1) ${command}\nThe artifact is ready.`, inputHistory: [], exitCode: null, artifactEvidence: true }))
        .toEqual({ kind: 'success-unverified', reason: 'final PTY screen has no success evidence', evidence: null });
    },
  );

  test.each(['rg --files -g AGENTS.md', 'grep -q target missing.txt', 'diff a.txt b.txt'])(
    '%s exit 1 alone does not provide success evidence', (command) => {
      expect(verdictForFinalPtyScreen({ screen: `• Failed (exit 1) ${command}`, inputHistory: [], exitCode: null }))
        .toEqual({ kind: 'success-unverified', reason: 'final PTY screen has no success evidence', evidence: null });
    },
  );

  test('a failed non-search tool in scrollback cannot override a verified artifact without a failure in the final answer', () => {
    expect(verdictForFinalPtyScreen({ screen: '• Failed (exit 2) bun test broken.test.ts\n└ Error: test failed\nThe artifact is ready.', inputHistory: [], exitCode: null, artifactEvidence: true }))
      .toEqual({ kind: 'success-unverified', reason: 'final PTY screen has no success evidence', evidence: null });
  });

  test('an actual final-answer error mentioning rg exit 1 still blocks artifact-backed success', () => {
    expect(verdictForFinalPtyScreen({ screen: 'Error: rg exit 1 caused the build to fail', inputHistory: [], exitCode: null, artifactEvidence: true }))
      .toEqual({ kind: 'done-but-failed', reason: 'Error: rg exit 1 caused the build to fail', evidence: null });
  });

  test('a non-search tool failure still blocks success without verified artifacts', () => {
    expect(verdictForFinalPtyScreen({ screen: '• Failed (exit 2) bun test broken.test.ts', inputHistory: [], exitCode: null }))
      .toEqual({ kind: 'done-but-failed', reason: '• Failed (exit 2) bun test broken.test.ts', evidence: null });
  });

  test('an error in the last answer still rejects verified artifacts', () => {
    expect(verdictForFinalPtyScreen({ screen: '• Failed (exit 1) rg --files -g AGENTS.md\nThe task failed: Error: build failed', inputHistory: [], exitCode: null, artifactEvidence: true }))
      .toEqual({ kind: 'done-but-failed', reason: 'The task failed: Error: build failed', evidence: null });
  });

  test('recognizes a positive output line with no failure', () => {
    expect(verdictForFinalPtyScreen({ screen: '\x1b[32m7 pass\x1b[0m\n0 fail', inputHistory: ['bun test file.test.ts\r'], exitCode: 0 }))
      .toEqual({ kind: 'success', reason: 'final PTY screen has success evidence', evidence: '7 pass' });
  });

  test('a zero exit code or brain done without output evidence is unverified', () => {
    expect(verdictForFinalPtyScreen({ screen: 'running...\n0 pass\n0 fail', inputHistory: [], exitCode: 0 }))
      .toEqual({ kind: 'success-unverified', reason: 'final PTY screen has no success evidence', evidence: null });
  });

  test.each(['echo GOAL-COMPLETE', 'echo "GOAL-COMPLETE"', "echo 'GOAL-COMPLETE'"])(
    'does not count input-derived marker from %s as success evidence', (input) => {
      expect(verdictForFinalPtyScreen({ screen: `$ ${input}\nGOAL-COMPLETE`, inputHistory: [`${input}\r`], exitCode: 0 }))
        .toEqual({ kind: 'success-unverified', reason: 'final PTY screen has no success evidence', evidence: null });
    },
  );

  test.each(['echo "7 pass"', "echo '3 tests passed'", 'printf "build successful\\n"', 'echo -n 5 pass'])(
    'does not count output of %s as success evidence', (input) => {
      const printed = input.replace(/^(?:echo(?:\s+-n)?|printf)\s+/, '').replace(/^(['"])(.*)\1$/, '$2').replace(/\\n$/, '');
      expect(verdictForFinalPtyScreen({ screen: `$ ${input}\n${printed}`, inputHistory: [`${input}\r`], exitCode: 0 }))
        .toEqual({ kind: 'success-unverified', reason: 'final PTY screen has no success evidence', evidence: null });
    },
  );
});
