import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { installTuiStderrOwner } from './tui-stderr-owner.js';

describe('TUI stderr ownership', () => {
  test('process stderr writes become bounded surface notices and restore cleanly', () => {
    const notices: string[] = [];
    const before = process.stderr.write;
    const restore = installTuiStderrOwner((line) => notices.push(line));
    try {
      process.stderr.write('fatal: not a git repository (or any of the parent directories): .git\n');
      expect(notices).toEqual(['fatal: not a git repository (or any of the parent directories): .git']);
      expect(process.stderr.write).not.toBe(before);
    } finally {
      restore();
    }
    expect(process.stderr.write).toBe(before);
  });

  test('both TUI boots install the shared stderr owner and no TUI boot inherits child stderr', () => {
    for (const file of ['src/tui/entry.ts', 'src/dashboard/index.ts']) {
      const source = readFileSync(file, 'utf8');
      expect(source).toContain('installTuiStderrOwner');
      expect(source).not.toMatch(/(?:stdio|stderr)\s*:\s*['"]inherit['"]/);
    }
    const childBoundary = readFileSync('src/surface/child-process.ts', 'utf8');
    expect(childBoundary).toContain("stdin: 'ignore'");
    expect(childBoundary).toContain("stdout: 'pipe'");
    expect(childBoundary).toContain("stderr: 'pipe'");
    expect(readFileSync('src/cli/repo-cli.ts', 'utf8')).not.toContain("stderr: 'inherit'");
    const podDispatch = readFileSync('src/harness/harness-pod-dispatch.ts', 'utf8');
    expect(podDispatch).toContain("stdio: ownsOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit'");
    expect(podDispatch).toContain('forwardChildStderr(child.stderr)');
  });
});
