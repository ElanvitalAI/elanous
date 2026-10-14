// KPACK6 스모크 계약 시험 — 실제 LLM 호출 없이 미측정·CLI 계약 오류·인용 실패를 구분한다.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  Kpack6CliContractError,
  KPACK6_TARGET_SLUGS,
  askViaCli,
  kpack6ExitCode,
  packCitationIn,
  runKpack6LiveSmoke,
  type Kpack6Deps,
} from './verify-kpack6-live.js';

const semiconductor = { id: 'semiconductor-process-public@0.1.0', title: '반도체 공정 표본 팩' };
const b2b = { id: 'b2b-sales-public@0.1.0', title: 'B2B 세일즈 표본 팩' };
const cards = {
  [semiconductor.id]: { id: 'content/process-overview.md', title: '공개 반도체 공정 개관', ref: `${semiconductor.id}#content/process-overview.md` },
  [b2b.id]: { id: 'content/playbook.md', title: 'B2B 영업 플레이북 (새로 작성한 범용 표본)', ref: `${b2b.id}#content/playbook.md` },
};

function depsFor(overrides: Partial<Kpack6Deps> = {}): Kpack6Deps {
  return {
    env: { KPACK6_LIVE: '1' },
    installedPacks: () => [semiconductor, b2b],
    queryTopCard: (packId) => cards[packId as keyof typeof cards],
    ...overrides,
  };
}

describe('KPACK6 선택 실행 게이트', () => {
  test('KPACK6_LIVE=1 없이는 skipped 상태로 돌지 않는다', async () => {
    const report = await runKpack6LiveSmoke(depsFor({ env: {} }));
    expect(report.status).toBe('skipped');
    expect(report.packs).toEqual([]);
    expect(kpack6ExitCode(report)).toBe(3);
  });
});

describe('KPACK6 미측정 구분', () => {
  test('팩 미설치는 pack-not-installed (미측정)', async () => {
    const report = await runKpack6LiveSmoke(depsFor({ installedPacks: () => [] }));
    expect(report.status).toBe('not-measured');
    expect(report.packs.map((pack) => pack.slug)).toEqual([...KPACK6_TARGET_SLUGS]);
    for (const pack of report.packs) {
      expect(pack.status).toBe('pack-not-installed');
      expect(pack.measured).toBe(false);
    }
  });

  test('스토어 조회 불가는 pack-unreadable (미측정)', async () => {
    const report = await runKpack6LiveSmoke(
      depsFor({ installedPacks: () => { throw new Error('sqlite: no such table'); } }),
    );
    expect(report.status).toBe('not-measured');
    for (const pack of report.packs) {
      expect(pack.status).toBe('pack-unreadable');
      expect(pack.measured).toBe(false);
    }
  });

  test('LLM 호출 불가는 llm-unavailable (미측정)', async () => {
    const report = await runKpack6LiveSmoke(
      depsFor({ ask: async () => { throw new Error('provider 429'); } }),
    );
    expect(report.status).toBe('not-measured');
    for (const pack of report.packs) {
      expect(pack.status).toBe('llm-unavailable');
      expect(pack.measured).toBe(false);
      expect(pack.reason).toContain('CLI 채팅 LLM 호출 불가');
    }
  });
});

describe('KPACK6 인용 계약', () => {
  test('질문 에코는 출처 증거가 아니므로 실패한다', async () => {
    const report = await runKpack6LiveSmoke(depsFor({
      ask: async (question) => ({ reply: question }),
    }));
    expect(report.status).toBe('fail');
    expect(report.packs.map((pack) => pack.status)).toEqual(['citation-missing', 'citation-missing']);
    for (const pack of report.packs) {
      expect(pack.question).not.toContain(cards[pack.packId as keyof typeof cards].ref);
    }
  });

  test('두 팩 모두 인용 답변이 오면 green', async () => {
    const report = await runKpack6LiveSmoke(depsFor({
      ask: async (question) => ({
        reply: question.includes('반도체')
          ? `공개 반도체 공정 개관: 식각은 웨이퍼 표면을 선택적으로 제거한다. 출처: ${cards[semiconductor.id].ref}`
          : `B2B 영업 플레이북 (새로 작성한 범용 표본): 거래는 도입·검증·확장 단계로 간다. 출처: ${cards[b2b.id].ref}`,
      }),
    }));
    expect(report.status).toBe('green');
    expect(report.packs.every((pack) => pack.status === 'cited')).toBe(true);
    expect(report.packs.map((pack) => pack.ref)).toEqual([
      cards[semiconductor.id].ref,
      cards[b2b.id].ref,
    ]);
    expect(kpack6ExitCode(report)).toBe(0);
  });

  test('답변은 왔으나 인용이 없으면 citation-missing (실패)', async () => {
    const report = await runKpack6LiveSmoke(depsFor({
      ask: async () => ({ reply: '식각은 웨이퍼 표면을 선택적으로 제거한다.' }),
    }));
    expect(report.status).toBe('fail');
    expect(report.packs.every((pack) => pack.status === 'citation-missing')).toBe(true);
    for (const pack of report.packs) {
      expect(pack.measured).toBe(true);
      expect(pack.reason).toContain('실패');
    }
    expect(kpack6ExitCode(report)).toBe(1);
  });

  test('한 팩만 인용해도 green 금지 — 실패', async () => {
    const report = await runKpack6LiveSmoke(depsFor({
      ask: async (question) => ({
        reply: question.includes('반도체')
          ? `공개 반도체 공정 개관. 출처: ${cards[semiconductor.id].ref}`
          : '파이프라인 개요.',
      }),
    }));
    expect(report.status).toBe('fail');
    expect(kpack6ExitCode(report)).toBe(1);
  });

  test('존재하지 않는 카드 ID 인용은 green으로 인정하지 않는다', async () => {
    const report = await runKpack6LiveSmoke(depsFor({
      ask: async (question) => ({
        reply: question.includes('반도체')
          ? `공개 반도체 공정 개관. 출처: ${semiconductor.id}#content/nonexistent.md`
          : `B2B 영업 플레이북 (새로 작성한 범용 표본). 출처: ${cards[b2b.id].ref}`,
      }),
    }));
    expect(report.status).toBe('fail');
    expect(report.packs[0]?.status).toBe('citation-missing');
    expect(report.packs[1]?.status).toBe('cited');
    expect(kpack6ExitCode(report)).toBe(1);
  });

  test('실존해도 조회 카드와 다른 카드 인용이나 제목 누락은 실패', async () => {
    const report = await runKpack6LiveSmoke(depsFor({
      ask: async (question) => ({
        reply: question.includes('반도체')
          ? `공개 반도체 공정 개관. 출처: ${semiconductor.id}#content/questions.md`
          : `다른 내용. 출처: ${cards[b2b.id].ref}`,
      }),
    }));
    expect(report.status).toBe('fail');
    expect(report.packs.map((pack) => pack.status)).toEqual(['citation-missing', 'citation-missing']);
  });
});

describe('KPACK6 CLI JSON 계약', () => {
  test('기본 agent 진입점은 --new, --json 및 텍스트 인자를 받는다', () => {
    const help = spawnSync(process.execPath, ['bin/elanous.mjs', 'agent', '--help'], {
      cwd: join(import.meta.dir, '..'), encoding: 'utf8', timeout: 15_000,
    });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('elanous agent [options]');
    expect(help.stdout).toContain('text');
    expect(help.stdout).toContain('--new');
    expect(help.stdout).toContain('--json');
    expect(help.stdout).toContain('reply');
  }, 20_000);

  test('실제 CLI 턴의 JSON 출력에서 두 설치 카드 ref를 읽는다', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'kpack6-cli-'));
    const state = join(temp, 'state');
    const scriptPath = join(temp, 'agent-json.mjs');
    mkdirSync(state);
    const replies = {
      semiconductor: `공개 반도체 공정 개관. 출처: ${cards[semiconductor.id].ref}`,
      b2b: `B2B 영업 플레이북 (새로 작성한 범용 표본). 출처: ${cards[b2b.id].ref}`,
    };
    writeFileSync(scriptPath, `
      const { runChatTurnCli } = await import(${JSON.stringify(new URL('../src/cli/agent-cli.ts', import.meta.url).href)});
      const userText = process.argv.at(-1);
      const reply = userText.includes('반도체') ? ${JSON.stringify(replies.semiconductor)} : ${JSON.stringify(replies.b2b)};
      await runChatTurnCli({
        cfg: { llm: { provider: 'auto', model: '' }, chat: { toolDeny: [] } },
        userText, explicitSessionId: undefined, reuseActive: false, forceNew: true, json: true,
        runTurn: async ({ sessionId }) => ({ text: reply, provider: 'test', model: 'test',
          meta: { id: sessionId }, usedTokens: 0, droppedMessages: 0, memoryIds: [] }),
      });
    `);
    try {
      const env = {
        KPACK6_LIVE: '1', KPACK6_AGENT_CMD: `${process.execPath} ${scriptPath}`,
        HOME: temp, ELANOUS_CONFIG_DIR: state, ELANOUS_STATE_DIR: state,
        ELANOUS_SESSION_ROOT: join(temp, 'sessions'),
      };
      const report = await runKpack6LiveSmoke(depsFor({ env, ask: undefined }));
      expect(report.status).toBe('green');
      expect(report.packs.map((pack) => pack.ref)).toEqual([cards[semiconductor.id].ref, cards[b2b.id].ref]);
      expect(report.packs.every((pack) => pack.question && !pack.question.includes(pack.ref ?? 'NO_REF'))).toBe(true);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }, 30_000);

  test('CLI가 성공 종료해도 reply JSON이 없으면 LLM unavailable과 별도 실패', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'kpack6-cli-bad-'));
    const scriptPath = join(temp, 'bad-json.mjs');
    writeFileSync(scriptPath, 'console.log(JSON.stringify({ sessionId: "s", finalReply: "without reply" }));\n');
    try {
      const env = { KPACK6_LIVE: '1', KPACK6_AGENT_CMD: `${process.execPath} ${scriptPath}` };
      await expect(askViaCli('질문', env)).rejects.toBeInstanceOf(Kpack6CliContractError);
      const report = await runKpack6LiveSmoke(depsFor({ env, ask: undefined }));
      expect(report.status).toBe('fail');
      expect(report.packs.map((pack) => pack.status)).toEqual(['cli-contract-error', 'cli-contract-error']);
      expect(report.packs.every((pack) => pack.measured === false)).toBe(true);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test('CLI 인자 오류와 실행 실패는 미측정 LLM 오류로 숨기지 않는다', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'kpack6-cli-exit-'));
    const scriptPath = join(temp, 'bad-args.mjs');
    writeFileSync(scriptPath, 'console.error("error: unknown option --json"); process.exit(1);\n');
    try {
      const env = { KPACK6_LIVE: '1', KPACK6_AGENT_CMD: `${process.execPath} ${scriptPath}` };
      const report = await runKpack6LiveSmoke(depsFor({ env, ask: undefined }));
      expect(report.status).toBe('fail');
      expect(report.packs.map((pack) => pack.status)).toEqual(['cli-contract-error', 'cli-contract-error']);
      expect(report.packs.every((pack) => pack.reason?.includes('unknown option'))).toBe(true);

      const missing = await runKpack6LiveSmoke(depsFor({
        env: { KPACK6_LIVE: '1', KPACK6_AGENT_CMD: join(temp, 'missing-agent') }, ask: undefined,
      }));
      expect(missing.status).toBe('fail');
      expect(missing.packs.map((pack) => pack.status)).toEqual(['cli-contract-error', 'cli-contract-error']);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test('CLI의 명시적 provider unavailable은 미측정으로 분류한다', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'kpack6-provider-'));
    const scriptPath = join(temp, 'no-provider.mjs');
    writeFileSync(scriptPath, 'console.error("No LLM provider available."); process.exit(2);\n');
    try {
      const report = await runKpack6LiveSmoke(depsFor({
        env: { KPACK6_LIVE: '1', KPACK6_AGENT_CMD: `${process.execPath} ${scriptPath}` }, ask: undefined,
      }));
      expect(report.status).toBe('not-measured');
      expect(report.packs.map((pack) => pack.status)).toEqual(['llm-unavailable', 'llm-unavailable']);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test('LLM 응답 지연에 따른 SIGKILL은 CLI 계약 오류와 별도 미측정', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'kpack6-timeout-'));
    const scriptPath = join(temp, 'hanging-agent.mjs');
    writeFileSync(scriptPath, 'setTimeout(() => {}, 10_000);\n');
    try {
      const report = await runKpack6LiveSmoke(depsFor({
        env: {
          KPACK6_LIVE: '1', KPACK6_AGENT_CMD: `${process.execPath} ${scriptPath}`,
          KPACK6_TIMEOUT_MS: '50',
        },
        ask: undefined,
      }));
      expect(report.status).toBe('not-measured');
      expect(report.packs.map((pack) => pack.status)).toEqual(['llm-timeout', 'llm-timeout']);
      expect(report.packs.every((pack) => pack.reason?.includes('시간 초과'))).toBe(true);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

describe('packCitationIn', () => {
  test('조회 카드의 ref를 정확히 인용하면 추출한다', () => {
    const reply = `요약. 출처: ${cards[semiconductor.id].ref}`;
    expect(packCitationIn(reply, cards[semiconductor.id].ref)).toBe(cards[semiconductor.id].ref);
  });

  test('인용이 없으면 null', () => {
    expect(packCitationIn('인용 없는 답변', cards[semiconductor.id].ref)).toBeNull();
  });

  test('정확한 ref 뒤에 다른 카드 ID 문자가 붙으면 null', () => {
    expect(packCitationIn(`${cards[semiconductor.id].ref}-fake`, cards[semiconductor.id].ref)).toBeNull();
    expect(packCitationIn(`fake-${cards[semiconductor.id].ref}`, cards[semiconductor.id].ref)).toBeNull();
    expect(packCitationIn(`${cards[semiconductor.id].ref}#fake`, cards[semiconductor.id].ref)).toBeNull();
    expect(packCitationIn(`fake@${cards[semiconductor.id].ref}`, cards[semiconductor.id].ref)).toBeNull();
  });
});
