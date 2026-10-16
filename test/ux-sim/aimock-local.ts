/** OpenAI wire mock for UX tests. The app still runs its real local provider adapter. */
import { LLMock } from '@copilotkit/aimock';
import { getProviderForConfig, type LLMProvider } from '../../src/llm.js';
import type { UserConfig } from '../../src/user-config.js';

export interface AimockLocalSession {
  mock: LLMock;
  provider: LLMProvider;
  close(): Promise<void>;
}

/** Deterministic source events for the existing TUI typeahead scenarios. */
export function installTypeaheadFixtures(mock: LLMock): void {
  for (const marker of ['Q2MARK', 'Q3MARK', 'LIVEQMARK']) {
    mock.onMessage(marker, { content: `${marker}\n` });
  }
  mock.onMessage(/1부터 30|1\s*(?:~|to|-)\s*30/i,
    { content: Array.from({ length: 30 }, (_, index) => `${index + 1}\n`).join('') },
    { chunkSize: 3, streamingProfile: { ttft: 50, tps: 25, jitter: 0 } });
  mock.on({ userMessage: 'Bash 도구', hasToolResult: false },
    { content: '파일 이름을 확인합니다.\n', toolCalls: [{ id: 'fake-bash-list-1', name: 'Bash', arguments: '{"command":"ls"}' }] },
    { streamingProfile: { ttft: 100, tps: 50, jitter: 0 } });
  mock.on({ userMessage: 'Bash 도구', hasToolResult: true },
    { content: '파일 목록을 확인했습니다.\n' });
}

/** Register fixtures before calling this function, then stop the server after the test. */
export async function startAimockLocal(configure: (mock: LLMock) => void): Promise<AimockLocalSession> {
  const mock = new LLMock({ port: 0, host: '127.0.0.1', strict: true });
  configure(mock);
  await mock.start();
  const config = { llm: { provider: 'local', model: 'test-model', baseUrl: `${mock.url}/v1` } } as UserConfig;
  return { mock, provider: getProviderForConfig(config), close: () => mock.stop() };
}
