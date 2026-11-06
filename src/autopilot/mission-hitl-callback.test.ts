import { describe, it, expect, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { debug } from '../debug/log.js';
import { hitlToken, buildHitlCallbackData, parseHitlCallbackData, HITL_REVISE_PRESETS } from './mission-notify.js';
import { describeCronKo, describeApproval, approvalNextStepText, registerMissionHitlCallback } from './mission-hitl-callback.js';
import type { TelegramBot, TgCallbackQuery } from '../telegram.js';

// 미션 HITL 콜백 데이터 — telegram callback_data 64byte 캡 회피(한글 slug 미션 id)의 핵심.
describe('mission HITL callback data', () => {
  it('SWALLOW-TO-BOUNDARY: 다른 명령·화면의 기본 동작과 원장 형식은 지금과 같게 유지하고, 삭제·보호 경로는 건', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'mission-hitl-callback-'));
    const invalidStateRoot = join(tempRoot, 'not-a-directory');
    writeFileSync(invalidStateRoot, '');
    const previousStateRoot = process.env.ELANOUS_STATE_DIR;
    const logSpy = spyOn(debug, 'log');
    logSpy.mockImplementation(() => {});
    let callbackHandler: ((query: TgCallbackQuery) => Promise<void>) | undefined;
    const answers: { id: string; text?: string }[] = [];
    const bot = {
      onCallbackQuery(handler: (query: TgCallbackQuery) => Promise<void>) {
        callbackHandler = handler;
        return () => {};
      },
      answerCallbackQuery: async (id: string, options?: { text?: string }) => {
        answers.push({ id, ...(options?.text !== undefined ? { text: options.text } : {}) });
      },
    } as unknown as TelegramBot;
    try {
      process.env.ELANOUS_STATE_DIR = invalidStateRoot;
      registerMissionHitlCallback(bot);
      await callbackHandler!({ id: 'cb-1', data: 'apm-hitl:6196e5:approve' } as TgCallbackQuery);
      expect(logSpy).toHaveBeenCalledWith(
        'mission.hitl.token.resolve.failed',
        '6196e5',
        { error: expect.any(String) },
      );
      expect(answers).toEqual([{ id: 'cb-1', text: '만료된 미션(이미 처리?)' }]);
    } finally {
      if (previousStateRoot === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousStateRoot;
      logSpy.mockRestore();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('SWALLOW-TO-BOUNDARY: debug logging failure preserves the existing callback response', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'mission-hitl-callback-log-failure-'));
    const invalidStateRoot = join(tempRoot, 'not-a-directory');
    writeFileSync(invalidStateRoot, '');
    const previousStateRoot = process.env.ELANOUS_STATE_DIR;
    const logSpy = spyOn(debug, 'log').mockImplementation((category) => {
      if (category === 'mission.hitl.token.resolve.failed') throw new Error('log sink unavailable');
    });
    let callbackHandler: ((query: TgCallbackQuery) => Promise<void>) | undefined;
    const answers: { id: string; text?: string }[] = [];
    const bot = {
      onCallbackQuery(handler: (query: TgCallbackQuery) => Promise<void>) {
        callbackHandler = handler;
        return () => {};
      },
      answerCallbackQuery: async (id: string, options?: { text?: string }) => {
        answers.push({ id, ...(options?.text !== undefined ? { text: options.text } : {}) });
      },
    } as unknown as TelegramBot;
    try {
      process.env.ELANOUS_STATE_DIR = invalidStateRoot;
      registerMissionHitlCallback(bot);
      await callbackHandler!({ id: 'cb-log-failure', data: 'apm-hitl:6196e5:approve' } as TgCallbackQuery);
      expect(logSpy).toHaveBeenCalledWith(
        'mission.hitl.token.resolve.failed',
        '6196e5',
        { error: expect.any(String) },
      );
      expect(answers).toEqual([{ id: 'cb-log-failure', text: '만료된 미션(이미 처리?)' }]);
    } finally {
      if (previousStateRoot === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousStateRoot;
      logSpy.mockRestore();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  // 실제 파일럿 미션 id(한글 slug 포함) — 전체를 실으면 64byte 초과.
  const koreanId = 'apm_202607112101_인프라-복원-파일럿-비투자-인프라-크_6196e5';

  it('hitlToken 은 id 끝 hash 세그먼트(ascii)만 뽑는다', () => {
    expect(hitlToken(koreanId)).toBe('6196e5');
    expect(hitlToken('apm_202607100500_흡수-codex-codex-rs-co_2cf15b')).toBe('2cf15b');
  });

  it('callback_data 는 64byte 이내 ascii', () => {
    const data = buildHitlCallbackData(koreanId, 'approve');
    expect(data).toBe('apm-hitl:6196e5:approve');
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(buildHitlCallbackData(koreanId, 'reject'), 'utf8')).toBeLessThanOrEqual(64);
  });

  it('빌드→파싱 라운드트립', () => {
    for (const decision of ['approve', 'reject', 'redecompose', 'redecompose-opus', 'opus-fallback'] as const) {
      const parsed = parseHitlCallbackData(buildHitlCallbackData(koreanId, decision));
      expect(parsed).not.toBeNull();
      expect(parsed!.token).toBe('6196e5');
      expect(parsed!.decision).toBe(decision);
    }
  });

  // ★ 게이팅 revise Opus 옵션(대표 2026-07-17) — redecompose 와 redecompose-opus 가 구분 파싱(prefix 혼동 X).
  it('redecompose vs redecompose-opus 구분 파싱', () => {
    expect(parseHitlCallbackData('apm-hitl:6196e5:redecompose')?.decision).toBe('redecompose');
    expect(parseHitlCallbackData('apm-hitl:6196e5:redecompose-opus')?.decision).toBe('redecompose-opus');
  });

  it('미션 HITL 이 아닌 콜백은 null(형제 핸들러 소관)', () => {
    expect(parseHitlCallbackData('elanous-hitl:req123:yes')).toBeNull();
    expect(parseHitlCallbackData('mq:sid:0:opt')).toBeNull();
    expect(parseHitlCallbackData('apm-hitl:6196e5:maybe')).toBeNull(); // 잘못된 decision
    expect(parseHitlCallbackData('garbage')).toBeNull();
  });

  it('정정 프리셋(revise-*) 콜백 빌드→파싱 + 64byte 이내', () => {
    for (const p of HITL_REVISE_PRESETS) {
      const data = buildHitlCallbackData(koreanId, p.action);
      expect(data).toBe(`apm-hitl:6196e5:${p.action}`);
      expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
      expect(parseHitlCallbackData(data)?.decision).toBe(p.action);
    }
  });

  it('프리셋 5개 · 각 라벨+재분해 comment 보유', () => {
    expect(HITL_REVISE_PRESETS.length).toBe(5);
    expect(HITL_REVISE_PRESETS.every((p) => p.label.length > 0 && p.comment.length > 0)).toBe(true);
    expect(HITL_REVISE_PRESETS.map((p) => p.action)).toEqual(
      ['revise-smaller', 'revise-simpler', 'revise-scope', 'revise-reuse', 'revise-research'],
    );
  });
});

// 승인 후 "어떻게 해석해 넣었는지" 피드백 — 예약 vs 즉시실행 오해 방지(대표 2026-07-12).
describe('mission approval feedback summary', () => {
  it('describeCronKo — 요일/평일/매일 해석', () => {
    expect(describeCronKo('0 3 * * 0')).toBe('매주 일요일 3시');
    expect(describeCronKo('30 9 * * 1')).toBe('매주 월요일 9시 30분');
    expect(describeCronKo('0 8 * * 1-5')).toBe('평일 8시');
    expect(describeCronKo('0 7 * * *')).toBe('매일 7시');
  });

  it('describeCronKo — 파싱 실패 시 원문 반환', () => {
    expect(describeCronKo('bogus')).toBe('bogus');
  });

  it('describeApproval — scheduler(예약)는 즉시실행 아님을 명시', () => {
    const s = describeApproval({ ok: true, activated: 1, scheduledCron: '0 3 * * 0' });
    expect(s).toContain('예약');
    expect(s).toContain('매주 일요일 3시');
    expect(s).toContain('0 3 * * 0');
    expect(s).toContain('즉시 실행이 아니라'); // "실행 시작"으로 오해하지 않도록
  });

  it('describeApproval — task(즉시실행)는 실행 시작 표기', () => {
    const s = describeApproval({ ok: true, activated: 2 });
    expect(s).toContain('실행 시작');
    expect(s).toContain('2건');
  });
});

describe('approvalNextStepText — 승인 후 안내 domain-aware(대표 2026-07-16)', () => {
  it('코어(elanous) 미션엔 매매 안전관문 문구 없음 · approve 로 빌드 착수', () => {
    const s = approvalNextStepText('apm_x', 'elanous');
    expect(s).toContain('빌드 착수');
    expect(s).toContain('autopilot approve apm_x');
    expect(s).not.toContain('매매');
    expect(s).not.toContain('mandate');
  });

  it('domain 미상(null)도 코어 안내(투자 문구 안 붙임)', () => {
    const s = approvalNextStepText('apm_y', null);
    expect(s).toContain('빌드 착수');
    expect(s).not.toContain('매매');
  });

  it('투자(investment/finance) 미션에만 mandate 매매 안전관문 안내', () => {
    expect(approvalNextStepText('apm_z', 'investment')).toContain('mandate 안전관문');
    expect(approvalNextStepText('apm_z', 'finance')).toContain('매매');
  });
});
