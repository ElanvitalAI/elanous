import { setDefaultTimeout, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const script = fileURLToPath(new URL('./goal-premise-mocked-by-signal.ts', import.meta.url));

const cleanSource = '이 축은 아직 없다. 새로 만든다.\n판정 신호: 조건 = 실물을 친다; 관측 = 결과; 기대 = 된다.\n';
const findingSource = [
  '서버 문은 이미 있다. `GET /v1/sessions`.',
  '판정 신호: 조건 = `/v1/sessions` 를 흉내 내는 목 서버를 띄운다; 관측 = 기록; 기대 = 받았다.',
].join('\n');

function run(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runCli(sources: readonly string[], includeMissing = false): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'goal-premise-mocked-by-signal-'));
  try {
    const paths = sources.map((source, index) => {
      const path = join(dir, `source-${index}.md`);
      writeFileSync(path, source);
      return path;
    });
    if (includeMissing) paths.unshift(join(dir, 'missing.md'));
    return run(paths);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('goal premise mocked by signal — CLI read outcomes', () => {
  it('preserves the --self-check exit code and output', () => {
    const result = run(['--self-check']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[self-check]');
    expect(result.stderr).toBe('');
  });

  it('exits 0 and reports one readable clean file', () => {
    const result = runCli([cleanSource]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('검사 1개 · 못 읽음 0개 · 잡힌 것 0건');
    expect(result.stderr).toBe('');
  });

  it('exits 1 when a readable file has a finding', () => {
    const result = runCli([findingSource]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('⛔ ');
    expect(result.stdout).toContain('검사 1개 · 못 읽음 0개 · 잡힌 것 1건');
  });

  it('exits 2 and reports an unreadable path separately from inspected files', () => {
    const result = runCli([], true);

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('⚪ ');
    expect(result.stdout).toContain('검사 0개 · 못 읽음 1개 · 잡힌 것 0건');
  });

  it('continues inspecting readable files after a read failure', () => {
    const result = runCli([findingSource], true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('⚪ ');
    expect(result.stdout).toContain('⛔ ');
    expect(result.stdout).toContain('검사 1개 · 못 읽음 1개 · 잡힌 것 1건');
  });
});
