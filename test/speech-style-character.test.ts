// 완료 경계 실물: `bun test test/speech-style-character.test.ts` → 0 fail
//
// 출처 보존 기준(고정, 조각 7/9): persona 적용 시점의 출처 — personaId,
// displayName, sources[].id, sources[].length, sources[].preview, 적용
// systemPrompt — 을 registry와 별개 저장소(세션 meta `chatPersonaId`와
// 적용 시점 캡처 스냅샷)에 저장하고, 적용 후 registry를 교체·오염시켜도
// 저장된 출처가 적용 시점 값을 유지·반환해야 한다. 매 호출 registry
// 재조회·재조립은 '보존'으로 인정하지 않는다.
//
// TUI-SPEECH-STYLE-CHARACTER(특) — 완료 경계 실물: bun test test/speech-style-character.test.ts
//
// src/persona/loader.ts 가 persona YAML 의 `speechStyle` 키를 PersonaProfile 로
// «키 단위 명시로» 읽어내는지 잰다. ⛔ 레포 규율(src/persona/loader.test.ts):
// 「타입에 있다」와 「파서가 읽는다»는 다른 값이다 — 키는 파서에 명시로
// 추가되어야 읽힌다.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  awaitGlobalPersonaLoad,
  getGlobalPersonaRegistry,
  reloadGlobalPersonaRegistry,
  _resetGlobalPersonaRegistryForTest,
} from '../src/persona/global-registry.js';
import {
  handleTuiChatPersona,
  TuiChatPersonaSelection,
  tuiChatPersonaMessages,
  tuiChatPersonaSources,
} from '../src/dashboard/slash-runtime/chat-persona.js';
import { parsePersonaYaml } from '../src/persona/loader.js';

describe('TUI-SPEECH-STYLE-CHARACTER — 출처 보존 경계 회귀', () => {
  test('적용 후 registry를 교체·오염해도 출처 필드와 적용 프롬프트가 적용 시점 원본을 유지·반환한다', async () => {
    const originalDir = mkdtempSync(join(tmpdir(), 'speech-style-origin-'));
    const contaminatedDir = mkdtempSync(join(tmpdir(), 'speech-style-contam-'));
    const replacedDir = mkdtempSync(join(tmpdir(), 'speech-style-replace-'));
    try {
      writeFileSync(join(originalDir, 'probe.yaml'), [
        'personaId: speech-style-preserve-probe',
        'displayName: 적용 시점 출처 이름',
        'systemPrompt: 적용 시점 시스템 프롬프트',
        '',
      ].join('\n'));
      await reloadGlobalPersonaRegistry(originalDir);
      const selection = new TuiChatPersonaSelection();
      const sessionId = 'speech-style-character-preservation-probe';
      expect(tuiChatPersonaSources(sessionId, selection)).toBeUndefined();
      await handleTuiChatPersona(['speech-style-preserve-probe'], sessionId, selection);
      const applied = tuiChatPersonaSources(sessionId, selection);
      expect(applied?.personaId).toBe('speech-style-preserve-probe');
      expect(applied?.displayName).toBe('적용 시점 출처 이름');
      expect(tuiChatPersonaMessages(sessionId, selection))
        .toEqual([{ role: 'system', content: '적용 시점 시스템 프롬프트' }]);

      // registry 교체·오염 — 같은 id, 다른 displayName·systemPrompt
      writeFileSync(join(contaminatedDir, 'probe.yaml'), [
        'personaId: speech-style-preserve-probe',
        'displayName: 오염된 출처 이름',
        'systemPrompt: 오염된 시스템 프롬프트',
        '',
      ].join('\n'));
      await reloadGlobalPersonaRegistry(contaminatedDir);
      const contaminated = getGlobalPersonaRegistry().get('speech-style-preserve-probe');
      expect(contaminated?.displayName).toBe('오염된 출처 이름');
      expect(contaminated?.systemPrompt).not.toBe('적용 시점 시스템 프롬프트');

      // 보존 관측: 조회는 적용 시점 스냅샷을 반환한다 — registry 현재값이 아니다
      const preserved = tuiChatPersonaSources(sessionId, selection);
      expect(preserved?.personaId).toBe('speech-style-preserve-probe');
      expect(preserved?.displayName).toBe('적용 시점 출처 이름');
      const preservedSource = preserved?.sources.find(source => source.kind === 'persona');
      expect(preservedSource?.id).toBe('speech-style-preserve-probe');
      expect(preservedSource?.length).toBe('적용 시점 시스템 프롬프트'.length);
      expect(preservedSource?.preview).toContain('적용 시점');
      expect(tuiChatPersonaMessages(sessionId, selection))
        .toEqual([{ role: 'system', content: '적용 시점 시스템 프롬프트' }]);

      // registry 교체 — 적용한 persona가 registry에서 사라져도 출처는 유지된다
      writeFileSync(join(replacedDir, 'other.yaml'), [
        'personaId: speech-style-other-persona',
        'displayName: 다른 페르소나',
        'systemPrompt: 다른 시스템 프롬프트',
        '',
      ].join('\n'));
      await reloadGlobalPersonaRegistry(replacedDir);
      expect(getGlobalPersonaRegistry().get('speech-style-preserve-probe')).toBeUndefined();
      expect(tuiChatPersonaSources(sessionId, selection)?.displayName)
        .toBe('적용 시점 출처 이름');
      expect(tuiChatPersonaMessages(sessionId, selection))
        .toEqual([{ role: 'system', content: '적용 시점 시스템 프롬프트' }]);

      // 제거 — 출처도 함께 사라진다
      await handleTuiChatPersona(['-'], sessionId, selection);
      expect(tuiChatPersonaSources(sessionId, selection)).toBeUndefined();
      expect(tuiChatPersonaMessages(sessionId, selection)).toEqual([]);
    } finally {
      _resetGlobalPersonaRegistryForTest();
      await awaitGlobalPersonaLoad();
      rmSync(originalDir, { recursive: true, force: true });
      rmSync(contaminatedDir, { recursive: true, force: true });
      rmSync(replacedDir, { recursive: true, force: true });
    }
  });
});

describe('TUI-SPEECH-STYLE-CHARACTER: parsePersonaYaml speechStyle', () => {
  const base = 'personaId: mira\ndisplayName: 미라 · Mira\n';

  test('parsePersonaYaml: speechStyle 키를 포함한 persona YAML 을 로드하면 반환된 PersonaProfile 에 speechStyle 가 담긴다', () => {
    const result = parsePersonaYaml(
      `${base}speechStyle: 따뜻하고 차분하게 — 결론 먼저, 근거 한 줄\n`,
      'mira.yaml',
    );

    expect(result).toEqual({
      ok: true,
      profile: {
        personaId: 'mira',
        displayName: '미라 · Mira',
        speechStyle: '따뜻하고 차분하게 — 결론 먼저, 근거 한 줄',
      },
    });
    if (result.ok) expect(Object.isFrozen(result.profile)).toBe(true);
  });

  test('personaId 와 나란히 읽힌다 — 기존 키(seat)와 함께 담긴다', () => {
    const result = parsePersonaYaml(
      'personaId: kai\ndisplayName: 카이 · Kai\nseat: MK\n'
        + 'speechStyle: 군더더기 없이 — 바꾼 것 · 시험한 것 · 남은 것을 나눠 말한다\n',
      'kai.yaml',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.personaId).toBe('kai');
    expect(result.profile.seat).toBe('MK');
    expect(result.profile.speechStyle).toBe('군더더기 없이 — 바꾼 것 · 시험한 것 · 남은 것을 나눠 말한다');
  });

  test('안 적으면 «없다» — 기본 말투를 조용히 채우지 않는다', () => {
    const result = parsePersonaYaml(base, 'mira.yaml');

    expect(result).toEqual({ ok: true, profile: { personaId: 'mira', displayName: '미라 · Mira' } });
    if (result.ok) expect(result.profile.speechStyle).toBeUndefined();
  });

  test('⛔ 선언했는데 비었으면 거부한다 — 「선언했는데 안 적었다」로 읽는다', () => {
    expect(parsePersonaYaml(`${base}speechStyle: "  "\n`, 'mira.yaml')).toEqual({
      ok: false,
      error: { code: 'invalid-shape', path: 'mira.yaml', message: 'speechStyle must be a non-empty string' },
    });
  });

  test('⛔ 문자열이 아니면 거부한다 — 조용히 넘기지 않는다', () => {
    const result = parsePersonaYaml(`${base}speechStyle:\n  - 짧게\n`, 'mira.yaml');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('speechStyle');
  });
});
