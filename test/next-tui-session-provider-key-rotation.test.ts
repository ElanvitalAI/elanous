import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../src/ux-sim/mock-seat-pty-sequence.js';

// 출처: #37872 세션 한정 provider 시험; 동일 PTY의 두 턴과 종료를 포함한다.
const PTY_TEST_TIMEOUT_MS = 90_000;

test('a running Next TUI child reads the rotated key on its next real local-provider request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-provider-key-turn-'));
  const authorizations: string[] = [];
  const server = createServer((request, response) => {
    authorizations.push(request.headers.authorization ?? '');
    request.resume();
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const configPath = join(root, 'config.json');
  const writeConfig = (key: string) => writeFileSync(configPath, JSON.stringify({
    onboarding: { completed: true }, errorReports: { enabled: false },
    llm: { provider: 'local', model: 'local-model', apiKey: key, baseUrl: `http://127.0.0.1:${port}/v1` },
  }));
  writeConfig('fixture-key-one');
  try {
    const evidence = await mockSeatPtySequence({
      runId: 'next-provider-key-rotation', executable: process.execPath,
      args: [join(import.meta.dir, '../bin/elanous.mjs'), '--test={root}', '--config-dir', '{root}',
        '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 30, cols: 100,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions') },
      ready: { label: 'local provider ready', until: (screen) => screen.includes('Enter 전송') && screen.includes('local/') },
      steps: [
        { label: 'first key turn', text: 'first', until: (screen) => screen.includes('턴 완료 · 모델 local/') && authorizations.length === 1 },
        { label: 'rotated key turn', text: () => { writeConfig('fixture-key-two'); return 'second'; },
          until: (screen) => screen.includes('턴 완료 · 모델 local/') && authorizations.length === 2 },
      ],
      quitKeys: '/quit\r',
    });
    expect(evidence.exitCode).toBe(0);
    expect(authorizations).toEqual(['Bearer fixture-key-one', 'Bearer fixture-key-two']);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, { timeout: PTY_TEST_TIMEOUT_MS });
