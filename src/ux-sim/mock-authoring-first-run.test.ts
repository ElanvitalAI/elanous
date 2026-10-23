import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockAuthoringFirstRun } from './mock-authoring-first-run.js';
import { unattendedNextStepLine } from '../onboarding/entry-hints.js';

// must-fix 1 인과 red: 부모 러너의 LANG 을 'C.UTF-8' 로 고정(저장·복원)해도 한국어
// 단언이 통과해야 한다 — 자식 env 의 ELANOUS_LANG 고정이 문구를 결정하기 때문이다.
// 자식 env 에 ELANOUS_LANG 을 고정하지 않는 제품(base)은 LANG=C.UTF-8 로 영어
// fallback 을 내 이 단언과 어긋나 실패한다. 부모 env 조작은 bun test 가 process.env
// 를 파일 간 공유하므로 반드시 복원해 새로운 전역 누수를 만들지 않는다.
const savedMockLang = process.env.LANG;
const savedMockLcAll = process.env.LC_ALL;
const savedMockLcMessages = process.env.LC_MESSAGES;
beforeAll(() => {
  process.env.LANG = 'C.UTF-8';
  delete process.env.LC_ALL;
  delete process.env.LC_MESSAGES;
});
afterAll(() => {
  if (savedMockLang === undefined) delete process.env.LANG;
  else process.env.LANG = savedMockLang;
  if (savedMockLcAll === undefined) delete process.env.LC_ALL;
  else process.env.LC_ALL = savedMockLcAll;
  if (savedMockLcMessages === undefined) delete process.env.LC_MESSAGES;
  else process.env.LC_MESSAGES = savedMockLcMessages;
});

test('N08 runs production first-run in an isolated child with a detected subscription', () => {
  const dir = mkdtempSync(join(tmpdir(), 'n08-proof-'));
  try {
    const artifactPath = join(dir, 'ready.json');
    const result = mockAuthoringFirstRun({ runId: 'first10-ready',
      detected: [{ provider: 'openai-codex', auth: 'oauth' }], artifactPath });
    expect(result.exitCode).toBe(0);
    expect(result.outcome).toBe('ready');
    expect(result.inputs).toBe(0);
    expect(result.provider).toBe('openai-codex');
    expect(result.configReady).toBe(true);
    expect(result.credentialSource).toBe('none');
    expect(result.detectionMode).toBe('fixture');
    expect(result.detectedProviders).toEqual(['openai-codex']);
    expect(result.lines).toContain('감지: codex 구독 → openai-codex');
    expect(result.stateDirSource).toBe('explicit');
    expect(result.binarySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.entrySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.firstRunSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.userConfigSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(readFileSync(artifactPath, 'utf8'))).toEqual(result);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('N08 empty HOME with no subscription shows the next step and does not mark ready', () => {
  const result = mockAuthoringFirstRun({ runId: 'first10-empty', detected: [] });
  expect(result.exitCode).toBe(0);
  expect(result.outcome).toBe('needs-llm');
  expect(result.inputs).toBe(0);
  expect(result.configReady).toBe(false);
  expect(result.credentialSource).toBe('not-selected');
  expect(result.detectionMode).toBe('fixture');
  expect(result.detectedProviders).toEqual([]);
  expect(result.lines[0]).toBe('eln setup llm 으로 고르세요');
  expect(result.lines[1]).toBe(unattendedNextStepLine());
  expect(result.lines.some(line => line.includes('token'))).toBe(false);
});

test('N08 real detection sees no subscriptions in the isolated empty HOME', () => {
  const result = mockAuthoringFirstRun({ runId: 'first10-real-empty' });
  expect(result.exitCode).toBe(0);
  expect(result.detectionMode).toBe('real');
  expect(result.detectedProviders).toEqual([]);
  expect(result.outcome).toBe('needs-llm');
  expect(result.configReady).toBe(false);
  expect(result.lines[1]).toBe(unattendedNextStepLine());
});
