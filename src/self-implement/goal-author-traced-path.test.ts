import { describe, expect, test } from 'bun:test';

import { lintGoalFile, tracedPathReferences } from './goal-author.js';

const goalWithTracedPaths = (paths: string) => `## PROBLEM
problem

## WHAT TO BUILD
build

## ACCEPTANCE CRITERIA
criteria

## REQUIRED EVIDENCE
- [proof] a checkable result

## TRACED PATHS
${paths}

## SCOPE BOUNDARY
boundary

## 답하지 못하는 것
none

## 불변식
keep

## 판정 신호
signals
`;

describe('lintGoalFile traced paths', () => {
  test('excludes a related-but-not-here description from traced paths and records its classification', () => {
    const document = goalWithTracedPaths('- src/dashboard/input — contains related modules, but searches showed the implementation is elsewhere');
    const findings = lintGoalFile(document, 'main', { readReferencedFile: () => ({ kind: 'directory' }) });

    expect(tracedPathReferences(document)).toEqual([]);
    expect(findings.tracedPathExclusionCount).toBe(1);
    expect(findings).not.toContainEqual(expect.objectContaining({ level: 'ERROR' }));
    expect(findings).not.toContainEqual(expect.objectContaining({ tag: 'traced-path' }));
  });

  test('reports an existing directory without treating it as an unreadable file', () => {
    const findings = lintGoalFile(goalWithTracedPaths('- src/dashboard/input — related directory'), 'main', {
      readReferencedFile: () => ({ kind: 'directory' }),
    });

    expect(findings).toContainEqual({ level: 'WARN', tag: 'traced-path', message: 'traced path is a directory: src/dashboard/input' });
    expect(findings).not.toContainEqual(expect.objectContaining({ message: expect.stringContaining('could not be read') }));
  });

  test('keeps a missing file as a blocking traced-path error', () => {
    const findings = lintGoalFile(goalWithTracedPaths('- src/missing.ts — required implementation file'), 'main', {
      readReferencedFile: () => ({ kind: 'missing' }),
    });

    expect(findings).toContainEqual({ level: 'ERROR', tag: 'traced-path', message: 'traced path does not exist: src/missing.ts' });
  });

  test('traces real files while excluding related-but-not-here descriptions', () => {
    const document = goalWithTracedPaths('- src/dashboard/input — contains related modules, but searches showed the implementation is elsewhere\n- src/self-implement/goal-author.ts — implementation target');
    const findings = lintGoalFile(document, 'main', {
      readReferencedFile: (path) => path === 'src/self-implement/goal-author.ts' ? 'export {}\n' : ({ kind: 'missing' }),
    });

    expect(tracedPathReferences(document)).toEqual([{ path: 'src/self-implement/goal-author.ts', line: null, endLine: null }]);
    expect(findings.tracedPathExclusionCount).toBe(1);
    expect(findings).not.toContainEqual(expect.objectContaining({ level: 'ERROR', tag: 'traced-path' }));
  });

  test('preserves evidence-unavailable exclusions', () => {
    const unavailable = 'Evidence unavailable — grounding found no persistent evidence and the cause remains undifferentiated. Grounding needs behavior and causation, not only locations: state what the target code does today and why that is a problem, and name a function, constant, or type that the target file exports. A pure-addition ask ("also record field X") often fails here because it names no current behavior to ground. Re-authoring the same input may also produce different evidence, but try that first. See docs/manual/MANUAL-goal-authoring-method-2026-08-03.md';
    const document = goalWithTracedPaths(`- ${unavailable}`);

    const findings = lintGoalFile(document, 'main', { readReferencedFile: () => ({ kind: 'missing' }) });

    expect(tracedPathReferences(document)).toEqual([]);
    expect(findings.tracedPathExclusionCount).toBe(0);
    expect(findings).not.toContainEqual(expect.objectContaining({ tag: 'traced-path' }));
  });

  test('keeps an unresolved filename visible without passing it to repository path checks', () => {
    const document = goalWithTracedPaths('- src/self-implement/goal-author.ts\n- 미해석: plugin-trust.json — bare filename');
    const inspected: string[] = [];
    const findings = lintGoalFile(document, 'main', {
      readReferencedFile: (path) => { inspected.push(path); return 'export {};\n'; },
    });

    expect(tracedPathReferences(document).map(({ path }) => path)).toEqual(['src/self-implement/goal-author.ts']);
    expect(inspected).toEqual(['src/self-implement/goal-author.ts']);
    expect(findings).toContainEqual({ level: 'WARN', tag: 'traced-path', message: '미해석: plugin-trust.json — bare filename' });
  });
});
