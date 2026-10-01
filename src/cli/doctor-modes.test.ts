import { describe, expect, test } from 'bun:test';
import { describeModes, formatModeLine } from './doctor-modes.js';

describe('doctor mode descriptions', () => {
  test('empty config reports all three defaults, none used by chat', () => {
    const rows = describeModes({});
    expect(rows).toEqual([
      { id: 'model-tier', value: 'balanced', source: 'default', usedByChat: false, note: '대화 턴 모델 선택에 쓰이지 않는다(표시·전환 계획만)' },
      { id: 'auto-route', value: false, source: 'default', usedByChat: false, note: '오토파일럿 턴만 읽는다 · 켜기 = elanous config set llm.autoRoute.enabled true' },
      { id: 'fast-mode', value: 'none', source: 'none', usedByChat: false, note: '스위치 없음(분류기 호출부 0)' },
    ]);
    expect(rows.map(formatModeLine)).toEqual([
      'smart·등급: balanced(기본) · 대화에 안 쓰임 — 대화 턴 모델 선택에 쓰이지 않는다(표시·전환 계획만)',
      'smart·자동 라우팅: false(기본) · 대화에 안 쓰임 — 오토파일럿 턴만 읽는다 · 켜기 = elanous config set llm.autoRoute.enabled true',
      '빠른 모드: none(없음) · 대화에 안 쓰임 — 스위치 없음(분류기 호출부 0)',
    ]);
  });

  test('explicit best tier and enabled auto-routing keep config provenance without claiming chat uses them', () => {
    const cfg = { modelTier: { llm: 'best' }, llm: { autoRoute: { enabled: true } } };
    expect(describeModes(cfg).map(({ id, value, source, usedByChat }) => ({ id, value, source, usedByChat }))).toEqual([
      { id: 'model-tier', value: 'best', source: 'config', usedByChat: false },
      { id: 'auto-route', value: true, source: 'config', usedByChat: false },
      { id: 'fast-mode', value: 'none', source: 'none', usedByChat: false },
    ]);
    expect(describeModes(cfg).map(formatModeLine)).toEqual([
      'smart·등급: best(설정) · 대화에 안 쓰임 — 대화 턴 모델 선택에 쓰이지 않는다(표시·전환 계획만)',
      'smart·자동 라우팅: true(설정) · 대화에 안 쓰임 — 오토파일럿 턴만 읽는다 · 켜기 = elanous config set llm.autoRoute.enabled true',
      '빠른 모드: none(없음) · 대화에 안 쓰임 — 스위치 없음(분류기 호출부 0)',
    ]);
    expect(cfg).toEqual({ modelTier: { llm: 'best' }, llm: { autoRoute: { enabled: true } } });
  });

  test('invalid tier and auto-route settings do not report an invented enabled switch or leak arbitrary values', () => {
    const cfg = { modelTier: { llm: 'not-a-tier' }, llm: { autoRoute: { enabled: 'true' } } };
    expect(describeModes(cfg).map(({ value, source }) => ({ value, source }))).toEqual([
      { value: 'balanced', source: 'default' },
      { value: false, source: 'default' },
      { value: 'none', source: 'none' },
    ]);
    expect(JSON.stringify(describeModes(cfg))).not.toContain('not-a-tier');
  });
});
