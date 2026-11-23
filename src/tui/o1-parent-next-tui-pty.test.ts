import { expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

test('Next TUI opens one turn for a matching real background output line', async () => {
  const root = mkdtempSync(join(tmpdir(), 'o1-watch-pty-'));
  const capture = join(root, 'requests.jsonl');
  writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
  const done = join(root, 'O1_PTY_DONE');
  const started = join(root, 'O1_PTY_STARTED');
  const deliveries = (): string[] => !existsSync(capture) ? [] : readFileSync(capture, 'utf8').split('\n').filter(Boolean)
    .flatMap(line => {
      const last = JSON.parse(line).messages.filter((m: { role: string }) => m.role === 'user').at(-1);
      return Array.isArray(last?.content) ? last.content.flatMap((part: { type?: string; text?: string }) =>
        part.type === 'text' && part.text?.startsWith('[notice · event-watch]') ? [part.text] : []) : [];
    });
  try {
    await mockSeatPtySequence({ executable: process.execPath,
      args: [join(import.meta.dir, '../../bin/elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 40, cols: 100,
      artifactPath: join(root, 'frames.json'),
      onOutput: chunk => appendFileSync(join(root, 'pty.raw'), chunk),
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_CONFIG_DIR: root, ELANOUS_TRACK: 'O1-PTY-FIXTURE',
        ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: 'O1_ACK', ELANOUS_TEST_FAKE_LLM_CAPTURE: capture,
        ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify({ when: 'O1_PTY_PARENT', name: 'RunShell', args: {
          command: ['sh', '-c', 'touch O1_PTY_STARTED; sleep 3; echo O1_PTY_IGNORE; sleep 1; echo O1_PTY_MATCH; sleep 15; touch O1_PTY_DONE'],
          mode: 'bg', watchPattern: '^O1_PTY_MATCH$', approval: 'always',
        } }) },
      ready: { label: 'boot', until: 'Ctrl+Q quit' },
      steps: [
        { label: 'approval card', text: 'O1_PTY_PARENT', until: screen => {
          if (!screen.includes('Bash approval') || !screen.includes('RunShell (one execution)')) return false;
          expect(existsSync(started)).toBe(false);
          return true;
        }, timeoutMs: 30_000 }, // 출처: #38775 PTY 부팅·가짜 모델·승인 카드 대기 상한
        { label: 'watch notice turn', keys: 'y', until: () => {
          if (existsSync(done)) throw new Error('watch turn arrived only after command completion');
          return deliveries().some(text => text.includes('O1_PTY_MATCH'));
        }, timeoutMs: 30_000 }, // 출처: #38775 PTY 부팅·가짜 모델·감시 줄 완료 대기 상한
        { label: 'command completed', until: () => existsSync(done), timeoutMs: 25_000 }, // 출처: #38775 실제 시험 명령 15초 종료 지연 + 여유
        { label: 'no duplicate', until: (() => { let after = 0; return () => { after ||= Date.now(); return Date.now() - after >= 3_000; }; })(), timeoutMs: 8_000 }, // 출처: #38775 중복 턴 관찰 3초 + PTY 여유
      ],
    });
    expect(deliveries()).toHaveLength(1);
    expect(deliveries()[0]).toContain('O1_PTY_MATCH');
    expect(deliveries()[0]).not.toContain('O1_PTY_IGNORE');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 65_000); // 출처: #38775 전체 PTY 종단 상한(부팅 30s + 종료 15s + 여유)
