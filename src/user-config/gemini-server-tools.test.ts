import { expect, test } from 'bun:test';
import { parseGeminiServerTools } from './gemini-server-tools.js';

test('Gemini server tools accept true flags only and omit empty config', () => {
  expect(parseGeminiServerTools(null)).toBeUndefined();
  expect(parseGeminiServerTools({ googleSearch: false, codeExecution: 'true', urlContext: 1 }))
    .toBeUndefined();
  expect(parseGeminiServerTools({ googleSearch: true, codeExecution: false, urlContext: true }))
    .toEqual({ googleSearch: true, urlContext: true });
});
