import { describe, expect, test } from 'bun:test';
import { parseGateScenario } from './gate-scenario.js';

const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const changedFiles = ['src/a.ts'];
const scenario = () => ({
  version: 1, baseSha, headSha, changedFiles,
  selectedTests: [{ path: 'test/a.test.ts', reasons: ['import'] }],
  coverage: { status: 'measured', unmeasured: [], reach: [{ path: 'src/a.ts', changed: [], import: ['test/a.test.ts'], spawn: [], unmeasured: [] }] },
});

describe('gate scenario v0', () => {
  test('accepts a bound, measured JSON document', () => {
    const raw = JSON.parse(JSON.stringify(scenario()));
    expect(parseGateScenario(raw, { baseSha, headSha, changedFiles }).selectedTests[0]?.path).toBe('test/a.test.ts');
    expect(parseGateScenario({ ...scenario(), selectedTests: [], coverage: { status: 'measured', unmeasured: [], reach: [{ path: 'src/a.ts', changed: [], import: [], spawn: [], unmeasured: [] }] } }, { baseSha, headSha, changedFiles }).selectedTests).toEqual([]);
  });
  test('rejects stale heads, incomplete coverage, unsafe paths and unknown schema fields', () => {
    const valid = scenario();
    expect(() => parseGateScenario(valid, { baseSha, headSha: 'c'.repeat(40), changedFiles })).toThrow('stale head/base');
    expect(() => parseGateScenario({ ...valid, coverage: { ...valid.coverage, status: 'unmeasured', unmeasured: ['spawn lane unknown'] } }, { baseSha, headSha, changedFiles })).toThrow('unmeasured coverage');
    expect(() => parseGateScenario({ ...valid, selectedTests: [{ path: '../escape.test.ts', reasons: ['import'] }] }, { baseSha, headSha, changedFiles })).toThrow('test path');
    expect(() => parseGateScenario({ ...valid, extra: true }, { baseSha, headSha, changedFiles })).toThrow('schema');
    expect(() => parseGateScenario(valid, { baseSha, headSha, changedFiles: ['src/other.ts'] })).toThrow('changed file mismatch');
    expect(() => parseGateScenario({ ...valid, coverage: { ...valid.coverage, reach: [] } }, { baseSha, headSha, changedFiles })).toThrow('reach incomplete');
    expect(() => parseGateScenario({ ...valid, coverage: { ...valid.coverage, reach: [{ path: 'src/a.ts', changed: [], import: [], spawn: [], unmeasured: [] }] } }, { baseSha, headSha, changedFiles })).toThrow('selected tests do not match reach');
    expect(() => parseGateScenario({ ...valid, coverage: { ...valid.coverage, reach: [{ ...valid.coverage.reach[0], unmeasured: ['spawn lookup failed'] }] } }, { baseSha, headSha, changedFiles })).toThrow('unmeasured reach');
  });
});
