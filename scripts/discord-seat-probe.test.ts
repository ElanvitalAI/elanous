import { describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as ceoCommands from '../src/seat-dispatch/ceo-commands.js';
import * as intakeWork from '../src/intake-plane/submit-intake-work.js';
import type { UserConfig } from '../src/user-config.js';
import { probeDiscordSeatWork, runbookTexts, runProbeCli } from './discord-seat-probe.js';
import { assertTuiSeatAskRestartContract } from '../test/seat-ask-tui-restart-contract.js';

const config = { raw: { decisions: { discordOwnerId: '11111' } }, discord: { allowedUsers: ['11111'] } } as unknown as UserConfig;

// The production registry maps COO/CTO/CMO/CXO to OP/TC/MK/UX; config supplies the real owner decision.
describe('Discord seat probe', () => {
  test('TUI reconnect recovers CTO seat answers and overdue notices', assertTuiSeatAskRestartContract);
  test('dry CLI runs three messages without reaching real dispatch, submit or Discord transport', async () => {
    const effects: string[] = [];
    const dispatch = spyOn(ceoCommands, 'dispatchCeoTask').mockImplementation((async () => {
      effects.push('dispatch');
      throw Error('real dispatch invoked');
    }) as typeof ceoCommands.dispatchCeoTask);
    const submit = spyOn(intakeWork, 'submitIntakeWork').mockImplementation((async () => {
      effects.push('submit');
      throw Error('real submit invoked');
    }) as typeof intakeWork.submitIntakeWork);
    const send = spyOn(globalThis, 'fetch').mockImplementation((async (_input: RequestInfo | URL, _init?: RequestInit) => {
      effects.push('Discord send');
      throw Error('Discord send invoked');
    }) as unknown as typeof fetch);
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const [result] = await runProbeCli(['--text', '@cmo 내일 행사 공지 써 줘', '--dm', '--json'], config);
      // #24523: a seat task travels the seat-ask path (so the answer can come back), so the probe records `ask`.
      expect(result?.route).toBe('ask');
      expect(result?.seat).toBe('MK');
      expect(result?.body).toStartWith('일: 내일 행사 공지 써 줘\n답장 요청: ');
      // The seat-ask path writes its own receipt even in dry mode; «nothing really delegated» is held by the effects assertions below.
      expect(result?.reply).toContain('결과를 이 대화로 돌려드립니다');
      // A dry run never reads as a real assignment (EV12 follow-up · 10-07).
      expect(result?.reply).toStartWith('마른 실행 (실제 맡김 없음) — ');
      expect(result?.ms).toBeGreaterThanOrEqual(0);
      const [ordinary] = await runProbeCli(['--text', '일반 글', '--json'], config);
      expect(['submit', 'none']).toContain(ordinary?.route);
      const [unknown] = await runProbeCli(['--text', '@xyz 테스트', '--json'], config);
      expect(unknown?.reply).toContain('등록된 좌석이 아닙니다');
      expect(effects).toEqual([]);
      expect(dispatch).toHaveBeenCalledTimes(0);
      expect(submit).toHaveBeenCalledTimes(0);
      expect(send).toHaveBeenCalledTimes(0);
    } finally {
      log.mockRestore();
      send.mockRestore();
      submit.mockRestore();
      dispatch.mockRestore();
    }
  });

  test('unaddressed chat goes to none; unknown seat replies without dispatch, submission or sending', async () => {
    const ordinary = await probeDiscordSeatWork('일반 글', { config });
    expect(ordinary.route).toBe('none');
    expect(ordinary.reply).toBeNull();
    const unknown = await probeDiscordSeatWork('@xyz 테스트', { config });
    expect(unknown.route).toBe('none');
    expect(unknown.reply).toContain('등록된 좌석이 아닙니다');
  });

  test('four registered seats route to graph intake in a channel without submitting or sending', async () => {
    for (const [title, id] of [['coo', 'OP'], ['cto', 'TC'], ['cmo', 'MK'], ['cxo', 'UX']]) {
      const result = await probeDiscordSeatWork(`@${title} 내일 행사 공지 써 줘`, { config });
      expect(result.route).toBe('submit');
      expect(result.seat).toBe(id);
      expect(result.body).toBe(`@${title.toUpperCase()} 내일 행사 공지 써 줘`);
      expect(result.reply).toContain('DRY-RUN (모의 · 실제 접수 없음)');
    }
  });

  test('owner question and CTO ask use only dry dependencies', async () => {
    const question = await probeDiscordSeatWork('@cmo 행사 준비 어디까지야?', { config, dm: true });
    expect(question.route).toBe('submit');
    expect(question.reply).toContain('모의');
    const asked = await probeDiscordSeatWork('CTO에게 물어봐: 행사 준비 어디까지야?', { config, dm: true });
    expect(asked.route).toBe('ask');
    expect(asked.seat).toBe('TC');
    expect(asked.reply).toContain('CTO에게 물었습니다');
  });

  test('the five verbatim runbook messages run in order and are never actually submitted', async () => {
    const path = 'docs/marketing/RUNBOOK-discord-cmo-demo-2026-10-04.md';
    const texts = runbookTexts(readFileSync(path, 'utf8'));
    expect(texts).toHaveLength(5);
    expect(texts[0]).toBe('@cmo 테스트');
    expect(texts[4]).toContain('플러그인');
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const results = await runProbeCli(['--runbook', path, '--json'], config);
      expect(results.map((result) => result.route)).toEqual(Array(5).fill('submit'));
      expect(results.map((result) => result.seat)).toEqual(Array(5).fill('MK'));
      expect(results.map((result) => result.text)).toEqual(texts.map((text) => Array.from(text).slice(0, 80).join('')));
      expect(log).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(results);
    } finally { log.mockRestore(); }
  });

  test('live mode delegates the authorized task; CLI --text remains dry by default', async () => {
    const delivered: string[] = [];
    const live = await probeDiscordSeatWork('@cmo 내일 행사 공지 써 줘', { config, dm: true, live: true,
      liveDeps: { dispatch: async (seat, text) => {
        delivered.push(`${seat}:${text}`);
        return { channel: 'posted', reply: '받음 — MK에 전했습니다.' };
      } },
    });
    expect(delivered).toHaveLength(1);
    // The forwarded task now carries the reply request (#24523) after the original line.
    expect(delivered[0]).toStartWith('MK:일: 내일 행사 공지 써 줘\n답장 요청: ');
    // The seat-ask path answers with its own receipt (request id · result returns to this conversation).
    expect(live.reply).toContain('결과를 이 대화로 돌려드립니다');
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const [dry] = await runProbeCli(['--text', '@cmo 내일 행사 공지 써 줘', '--dm', '--json'], config);
      expect(dry?.route).toBe('ask');
      expect(dry?.seat).toBe('MK');
      expect(delivered).toHaveLength(1);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual([dry]);
      await expect(runProbeCli(['--text', '글', '--runbook', 'example.md'], config)).rejects.toThrow('하나만');
    } finally { log.mockRestore(); }
  });

  test('long bodies and replies are bounded in the report; missing owner DM fails closed', async () => {
    const long = await probeDiscordSeatWork(`@cmo ${'가'.repeat(100)} 해 줘`, { config, dm: true });
    expect(Array.from(long.body ?? '')).toHaveLength(80);
    expect(Array.from(long.reply ?? '').length).toBeLessThanOrEqual(120);
    const noOwner = { raw: { decisions: {} }, discord: { allowedUsers: [] } } as unknown as UserConfig;
    await expect(probeDiscordSeatWork('@cmo 맡아 줘', { config: noOwner, dm: true })).rejects.toThrow('소유자 ID');
  });
});
