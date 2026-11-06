import { expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as llmModule from '../llm.js';
import { streamLLMWithTools } from '../llm.js';
import { TEST_FAKE_LLM_CAPTURE_ENV, testFakeLlmProvider } from '../ux-sim/fake-llm.js';
import { bootDashboardAcpSession } from './acp-boot.js';

test('ACP async preamble yields the event loop before the provider turn', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'acp-async-preamble-'));
  const capturePath = join(temp, 'request.jsonl');
  const previousCapture = process.env[TEST_FAKE_LLM_CAPTURE_ENV];
  process.env[TEST_FAKE_LLM_CAPTURE_ENV] = capturePath;

  let releasePreamble!: (messages: readonly llmModule.LLMMessage[]) => void;
  const pendingPreamble = new Promise<readonly llmModule.LLMMessage[]>((resolve) => {
    releasePreamble = resolve;
  });
  let preambleCalls = 0;
  const realStreamLLMWithTools = streamLLMWithTools;
  const streamSpy = spyOn(llmModule, 'streamLLMWithTools').mockImplementation((messages, handlers, options = {}) =>
    realStreamLLMWithTools(messages, handlers, { ...options, provider: testFakeLlmProvider }));

  let boot: Awaited<ReturnType<typeof bootDashboardAcpSession>> | undefined;
  try {
    boot = await bootDashboardAcpSession({
      getCwd: () => process.cwd(),
      getChatHistory: () => [],
      getPreamble: async () => {
        preambleCalls += 1;
        return pendingPreamble;
      },
      getTools: () => [],
      getActiveModel: () => null,
      dispatchTool: async () => ({}),
      pushTurnToolHistory: () => {},
    });

    const send = boot.session.send({ userText: 'async preamble probe', onText: () => {} });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(preambleCalls).toBe(1);
    expect(existsSync(capturePath)).toBe(false);
    releasePreamble([{ role: 'system', content: 'async preamble resolved' }]);
    await send;

    const captured = readFileSync(capturePath, 'utf8');
    expect(captured).toContain('async preamble resolved');
    expect(captured).toContain('async preamble probe');
  } finally {
    releasePreamble([{ role: 'system', content: 'async preamble cleanup' }]);
    if (boot) await boot.session.close();
    streamSpy.mockRestore();
    if (previousCapture === undefined) delete process.env[TEST_FAKE_LLM_CAPTURE_ENV];
    else process.env[TEST_FAKE_LLM_CAPTURE_ENV] = previousCapture;
    rmSync(temp, { recursive: true, force: true });
  }
});
