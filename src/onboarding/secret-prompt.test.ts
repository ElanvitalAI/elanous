import { PassThrough, Writable } from 'node:stream';
import { describe, expect, test } from 'bun:test';
import { createSecretPrompt } from './secret-prompt.js';

describe('createSecretPrompt', () => {
  test('collects a complete hidden multi-line .env paste through its blank-line terminator', async () => {
    const input = new PassThrough();
    let outputText = '';
    const output = new Writable({ write(chunk, _encoding, callback) { outputText += chunk.toString(); callback(); } });
    const prompt = createSecretPrompt(input, output);
    const result = prompt('.env 형식 키를 붙여 넣고 빈 줄로 끝내세요: ');
    input.end('ANTHROPIC_API_KEY=secret-one\nOPENAI_API_KEY=secret-two\n\n');

    expect(await result).toBe('ANTHROPIC_API_KEY=secret-one\nOPENAI_API_KEY=secret-two');
    expect(outputText).toBe('.env 형식 키를 붙여 넣고 빈 줄로 끝내세요: \n');
    expect(outputText).not.toContain('secret-one');
    expect(outputText).not.toContain('secret-two');
  });
});
