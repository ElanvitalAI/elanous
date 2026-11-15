import { describe, expect, test } from 'bun:test';
import type { LLMToolSpec } from '../../llm/tool-spec.js';
import { dispatchToolSearch } from './tool-search.js';

const discovery = (whenToUse: string, name: string): LLMToolSpec => ({
  name,
  description: `${name}\n\nCapability discovery:\n${JSON.stringify({ whenToUse })}`,
  parameters: { type: 'object', properties: {} },
});

const matched = (query: string, specs: readonly LLMToolSpec[]): string[] =>
  dispatchToolSearch({ query }, { specs, requireQueryCoverage: true }).matched;

describe('Korean explicit verb suffix', () => {
  const specs = [
    discovery('병원을 찾습니다', 'HospitalFinder'),
    discovery('사내설문앱을 만듭니다', 'SurveyApp'),
    discovery('문서를 수정합니다', 'DocEditor'),
  ];

  test('병원을 keeps the one-character subject attached to the declared word', () => {
    expect(matched('병원을 찾아줘', specs)).toEqual(['HospitalFinder']);
  });

  test('사내설문앱으로만들어줘 still reaches the declared multi-character word', () => {
    expect(matched('사내설문앱으로만들어줘', specs)).toEqual(['SurveyApp']);
  });

  test('수정해줘 is an explicit verb and does not split an unrelated one-character subject', () => {
    expect(matched('계약서수정해줘', specs)).toEqual([]);
    expect(matched('문서를 수정해줘', specs)).toEqual(['DocEditor']);
  });
});
