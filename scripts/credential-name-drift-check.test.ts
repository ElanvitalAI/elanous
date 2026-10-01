import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import {
  checkCredentialNameDrift,
  credentialNameDriftCliMain,
} from './credential-name-drift-check.js';

const envExamplePath = '/repo/.env.example';
const resourceMapPath = '/repo/catalog/resources.yaml';

function checkerInputs(envExample: string, resourceMap: string) {
  return {
    envExamplePath,
    resourceMapPath,
    readFile: (path: string) => {
      if (path === envExamplePath) return envExample;
      if (path === resourceMapPath) return resourceMap;
      throw new Error(`unexpected path: ${path}`);
    },
  };
}

describe('checkCredentialNameDrift', () => {
  test('counts commented credentials and classifies both directions deterministically', () => {
    const result = checkCredentialNameDrift(checkerInputs(
      'ACTIVE_KEY=\n# COMMENTED_KEY=\nENV_ONLY_KEY=\n',
      'resources:\n  - env: [ACTIVE_KEY, COMMENTED_KEY, RESOURCE_ONLY_KEY]\n',
    ));

    expect(result).toEqual({
      envExampleOnly: ['ENV_ONLY_KEY'],
      resourceMapOnly: ['RESOURCE_ONLY_KEY'],
      both: ['ACTIVE_KEY', 'COMMENTED_KEY'],
      unreadable: [],
    });
  });

  test('preserves unreadable paths and reasons for missing or malformed inputs', () => {
    const missingEnv = checkCredentialNameDrift({
      envExamplePath: '/missing/.env.example',
      resourceMapPath,
      readFile: (path) => {
        if (path === resourceMapPath) return 'resources:\n  - env: [CATALOG_KEY]\n';
        throw new Error('file missing');
      },
    });
    const malformedMap = checkCredentialNameDrift(checkerInputs('ENV_KEY=\n', 'resources: ['));

    expect(missingEnv.unreadable).toEqual([{ path: '/missing/.env.example', reason: 'file missing' }]);
    expect(missingEnv.resourceMapOnly).toEqual(['CATALOG_KEY']);
    expect(malformedMap.unreadable).toHaveLength(1);
    expect(malformedMap.unreadable[0]).toMatchObject({ path: resourceMapPath });
    expect(malformedMap.unreadable[0]!.reason).not.toBe('');
  });

  test('matches the repository credential names — both documents agree, neither has a name alone', () => {
    const result = checkCredentialNameDrift({
      envExamplePath: `${process.cwd()}/.env.example`,
      resourceMapPath: `${process.cwd()}/catalog/resources.yaml`,
      readFile: (path) => readFileSync(path, 'utf8'),
    });

    // ⛔ 저장소의 «자격 수»를 문자로 고정하지 않는다 — 자격이 하나 늘 때마다 이 시험이 깨지고,
    //    그때 깨지는 것은 «결함»이 아니라 «정상적인 증가»다(📏 2026-09-21: 33 → 41).
    //    이 시험의 계약은 「두 문서가 일치한다」이지 「그 수가 N 이다」가 아니다.
    expect(result).toEqual({ envExampleOnly: [], resourceMapOnly: [], both: expect.any(Array), unreadable: [] });
    // 벙어리 방지 — 목록이 비면 「일치」가 공허하게 참이 된다.
    expect(result.both.length).toBeGreaterThan(20);
    expect(result.both).toContain('ANTHROPIC_API_KEY');
  });
});

describe('credentialNameDriftCliMain', () => {
  test('prints a both count and exits successfully', () => {
    const output: string[] = [];
    const exits: number[] = [];

    credentialNameDriftCliMain({
      out: { log: (line) => output.push(line) },
      setExitCode: (code) => exits.push(code),
    });

    // ⛔ 수를 문자로 고정하지 않는다(위 주석과 같은 이유). 계약은 「드리프트가 0이고 both 를 «낸다»」다.
    expect(output).toContain('envExampleOnly: 0');
    expect(output).toContain('resourceMapOnly: 0');
    expect(output.some((line) => /^both: \d+$/.test(line))).toBe(true);
    expect(exits).toEqual([0]);
  });

  test('exits unsuccessfully for drift or unreadable input', () => {
    for (const inputs of [
      checkerInputs('ENV_ONLY_KEY=\n', 'resources:\n  - env: [RESOURCE_ONLY_KEY]\n'),
      {
        envExamplePath: '/missing/.env.example',
        resourceMapPath,
        readFile: () => { throw new Error('not readable'); },
      },
    ]) {
      const exits: number[] = [];
      credentialNameDriftCliMain({ ...inputs, out: { log: () => {} }, setExitCode: (code) => exits.push(code) });
      expect(exits).toEqual([1]);
    }
  });
});
