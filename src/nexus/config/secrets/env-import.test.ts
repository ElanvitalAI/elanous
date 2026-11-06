import { expect, test } from 'bun:test';
import { parseSecretEnvFile, renderSecretEnvExports } from './env-import.js';

test('imports literal zsh export assignments and shell-escapes requested environment values', () => {
  const secrets = parseSecretEnvFile([
    '# fake API credentials',
    "export EXA_API_KEY='fake-exa-value'",
    'export TAVILY_KEY="fake-tavily-value"',
    'export OPENAI_API_KEY=fake-openai-value',
  ].join('\n'));
  expect(secrets).toEqual({
    EXA_API_KEY: 'fake-exa-value',
    TAVILY_KEY: 'fake-tavily-value',
    OPENAI_API_KEY: 'fake-openai-value',
  });
  expect(renderSecretEnvExports({ EXA_API_KEY: "fake value's key", OTHER: 'fake-other-value' }, ['EXA_API_KEY']))
    .toBe("export EXA_API_KEY='fake value'\\''s key'\n");
});

test('duplicate names, shell expressions, malformed lines, and oversized files fail closed', () => {
  expect(() => parseSecretEnvFile('export EXA_API_KEY=one\nexport EXA_API_KEY=two')).toThrow('duplicate environment variable name');
  expect(() => parseSecretEnvFile('export EXA_API_KEY=$(cat hidden-file)')).toThrow('unsupported API-key export syntax');
  expect(() => parseSecretEnvFile('export EXA_API_KEY=~')).toThrow('unsupported API-key export syntax');
  expect(() => parseSecretEnvFile('export EXA_API_KEY=~someuser')).toThrow('unsupported API-key export syntax');
  expect(() => parseSecretEnvFile('export EXA_API_KEY=one; echo leaked')).toThrow('unsupported API-key export syntax');
  expect(() => parseSecretEnvFile('export =missing-name')).toThrow('unsupported API-key export syntax');
  expect(() => parseSecretEnvFile('x'.repeat(1024 * 1024 + 1))).toThrow('environment file is too large');
});

test('environment output rejects missing or invalid requested names before rendering any assignment', () => {
  expect(() => renderSecretEnvExports({ EXA_API_KEY: 'fake-exa-value' }, ['EXA_API_KEY', 'MISSING_KEY']))
    .toThrow('missing secrets: MISSING_KEY');
  expect(() => renderSecretEnvExports({ EXA_API_KEY: 'fake-exa-value' }, ['EXA_API_KEY;touch']))
    .toThrow('invalid environment variable name');
});
