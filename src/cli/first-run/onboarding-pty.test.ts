import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const expectBin = Bun.which('expect');
const scriptBin = process.platform === 'linux' ? Bun.which('script') : null;
const fixture = resolve(import.meta.dir, 'onboarding-pty-fixture.ts');

async function drive(mode: 'codex' | 'openrouter' | 'interrupt'): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'onboard-pty-'));
  try {
    if (!expectBin) {
      const childLine = [process.execPath, fixture, mode, join(root, 'config.json')]
        .map((value) => `'${value.replace(/'/g, `'\\''`)}'`).join(' ');
      const child = spawn(scriptBin!, ['-q', '-e', '-c', childLine, '/dev/null'], {
        cwd: resolve(import.meta.dir, '../../..'),
        env: { ...process.env, HOME: root }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '';
      let next = 0;
      const replies = mode === 'codex'
        ? [{ marker: '선택: ', value: '1' }]
        : mode === 'interrupt'
          ? [
            { marker: 'SECRET_FOR_INTERRUPT: ', value: 'interrupt-secret-never-output' },
            { marker: 'AFTER_SECRET: ', value: '\x03' },
            { marker: 'INTERRUPT_CALLBACK', value: 'done' },
          ]
          : [
          { marker: '선택: ', value: '2' },
          { marker: '키 공급 선택: ', value: '3' },
          { marker: 'OPENROUTER_API_KEY (Enter=건너뜀): ', value: 'pty-sentinel-never-output' },
          { marker: 'OpenRouter 모델 (', value: '\x1b[A5' },
        ];
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
        const reply = replies[next];
        if (reply && output.includes(reply.marker)) {
          next += 1;
          setTimeout(() => child.stdin.write(reply.value + (reply.value === '\x03' ? '' : '\n')), 80);
        }
      });
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
      const status = await new Promise<number | null>((done) => {
        // 출처: 내부 문서 `MANUAL-ux-simulation-devices-2026-08-23` §1 — same 30s PTY child budget as the Expect driver.
        const timer = setTimeout(() => { child.kill('SIGKILL'); done(null); }, 30_000);
        child.on('close', (code) => { clearTimeout(timer); done(code); });
        child.on('error', () => { clearTimeout(timer); done(null); });
      });
      if (status !== 0 || next !== replies.length) throw new Error(`PTY child ${mode} exit=${status}, replies=${next}: ${output.slice(-1000)}`);
      return output;
    }
    const driver = [
      'set timeout 30',
      'match_max 100000',
      'spawn $env(PTY_BUN) $env(PTY_FIXTURE) $env(PTY_MODE) $env(PTY_CONFIG)',
      'if {$env(PTY_MODE) eq "interrupt"} {',
      '  expect "SECRET_FOR_INTERRUPT: "',
      '  send "interrupt-secret-never-output\\r"',
      '  expect "AFTER_SECRET: "',
      '  send "\\003"',
      '  expect "INTERRUPT_CALLBACK"',
      '  send "done\\r"',
      '  expect "INTERRUPT_RESULT true"',
      '} elseif {$env(PTY_MODE) eq "codex"} { expect "선택: "; send "1\\r" } else {',
      '  expect "선택: "',
      '  send "2\\r"',
      '  expect "키 공급 선택: "',
      '  send "3\\r"',
      '  expect "OPENROUTER_API_KEY (Enter=건너뜀): "',
      '  send "pty-sentinel-never-output\\r"',
      '  expect "OpenRouter 모델 ("',
      '  send "\\033\\[A5\\r"',
      '}',
      'if {$env(PTY_MODE) ne "interrupt"} { expect "PTY_RESULT " }',
      'expect eof',
      'exit [lindex [wait] 3]',
    ].join('\n');
    const result = spawnSync(expectBin!, ['-c', driver], {
      // 출처: 내부 문서 `MANUAL-ux-simulation-devices-2026-08-23` §1 — 30s PTY child budget + 5s teardown.
      cwd: resolve(import.meta.dir, '../../..'), timeout: 35_000, encoding: 'utf8',
      env: { ...process.env, HOME: root, PTY_BUN: process.execPath, PTY_FIXTURE: fixture,
        PTY_MODE: mode, PTY_CONFIG: join(root, 'config.json') },
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status !== 0) throw new Error(`PTY child ${mode} exit=${result.status}: ${output.slice(-1000)}`);
    return output;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test.skipIf(!expectBin && !scriptBin)('first-run registered interrupt survives secret readline replacement', async () => {
  const output = await drive('interrupt');
  expect(output).toContain('INTERRUPT_CALLBACK');
  expect(output).toContain('INTERRUPT_RESULT true');
  expect(output).not.toContain('interrupt-secret-never-output');
}, 70_000);

test.skipIf(!expectBin && !scriptBin)('first-run PTY completes Codex and OpenRouter with no credential output', async () => {
  const codex = await drive('codex');
  const openrouter = await drive('openrouter');
  expect(codex).toContain('"provider":"openai-codex"');
  expect(codex).toContain('"ready":true');
  expect(openrouter).toContain('"provider":"openrouter"');
  expect(openrouter).toContain('"model":"openrouter/upstage/solar-pro4"');
  expect(openrouter).toContain('"ready":true');
  expect(openrouter).toContain('"isTTY":true');
  expect(openrouter).not.toContain('pty-sentinel-never-output');
}, 70_000);
