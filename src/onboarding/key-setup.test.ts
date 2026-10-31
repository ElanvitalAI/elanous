import { describe, expect, test } from 'bun:test';
import type { UserConfig } from '../user-config.js';
import { collectServiceKeys } from './key-setup.js';

describe('collectServiceKeys', () => {
  test('imports every .env line, stores each key once, and probes only supplied providers', async () => {
    const secret = 'hidden-key-value';
    const stored = new Map<string, string>();
    const probed: string[] = [];
    const promptLines: string[] = [];
    const results = await collectServiceKeys({
      config: { llm: { provider: 'auto', rotation: [] } } as unknown as UserConfig,
      promptSecret: async (message) => {
        promptLines.push(message);
        return message.includes('.env')
          ? `ANTHROPIC_API_KEY=${secret}\nOPENAI_API_KEY=${secret}`
          : '';
      },
      print: () => {},
      getSecret: async (id) => stored.get(id),
      setSecret: async (id, value) => { stored.set(id, value); },
      probe: async (provider) => { probed.push(provider.name); return { success: true }; },
    });

    expect(stored).toEqual(new Map([['ANTHROPIC_API_KEY', secret], ['OPENAI_API_KEY', secret]]));
    expect(probed).toHaveLength(2);
    expect(results.filter((result) => result.status === 'success')).toHaveLength(2);
    expect(promptLines[0]).toContain('빈 줄로 끝내세요');
  });
});
