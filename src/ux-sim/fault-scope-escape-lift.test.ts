import { describe, expect, test } from 'bun:test';
import {
  SCOPE_ESCAPE_HELD_KEYS,
  implementationDeficitChildResult,
  renderScopeEscapeLift,
  scopeEscapeChildResult,
  simScopeEscapeLift,
  simScopeEscapeLiftPair,
} from './fault-scope-escape-lift.js';

describe('simScopeEscapeLift — 결함 주입 «범위 이탈 vs 구현 결손» (FAULT-SCOPE-ESCAPE-LIFT · POD-RESULT-LIFT 반증 짝)', () => {
  test('the two child failures differ only in the held keys', () => {
    const scope = scopeEscapeChildResult();
    const deficit = implementationDeficitChildResult();
    // 두 입력은 «held» 칸(SCOPE_ESCAPE_HELD_KEYS)만 다르다 — 그 밖의 칸은 키 집합·값이 모두 같다.
    const held = new Set<string>(SCOPE_ESCAPE_HELD_KEYS);
    const differingKeys = [...new Set([...Object.keys(scope), ...Object.keys(deficit)])]
      .filter((key) => JSON.stringify(scope[key]) !== JSON.stringify(deficit[key])).sort();
    expect(differingKeys).toEqual([...SCOPE_ESCAPE_HELD_KEYS].sort());
    const withoutHeld = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([key]) => !held.has(key)));
    expect(withoutHeld(scope)).toEqual(deficit);
    for (const key of SCOPE_ESCAPE_HELD_KEYS) expect(deficit).not.toHaveProperty(key);
    expect(scope).toMatchObject({ stage: 'soft-stopped', ok: false, outOfScopeEdits: ['LICENSE'] });
    expect(String(scope.detail)).toStartWith('Out-of-scope edits held in the worktree');
  });

  test('control: the deficit input plus outOfScopeEdits alone already lifts to scope-escape', () => {
    // held 넷 중 outOfScopeEdits 한 칸만 더해도 갈린다 — 분류 차이의 원인이 held 편집임을 한 칸으로 격리한다.
    const obs = simScopeEscapeLift('scope-escape', { ...implementationDeficitChildResult(), outOfScopeEdits: ['LICENSE'] });
    expect(obs.childEvidence).toMatchObject({ classification: 'scope-escape', scopeEscape: true, outOfScopeEdits: ['LICENSE'] });
    expect(obs.childEvidence).not.toHaveProperty('detail');
    expect(obs.stop?.class).toBe('scope-escape');
    expect(obs.incident?.reason).toBe('scope-escape');
  });

  test('scope escape lifts to scope-escape at every parent field', () => {
    const obs = simScopeEscapeLift('scope-escape');
    expect(obs.childEvidence).toMatchObject({ classification: 'scope-escape', scopeEscape: true, outOfScopeEdits: ['LICENSE'] });
    expect(obs.disposition.failureClassification).toBe('implementation-deficit');
    expect(obs.ledgerChildEvidence).toEqual(obs.childEvidence);
    expect(obs.parentExitReason).toBe('pod-failure');
    expect(obs.stop?.class).toBe('scope-escape');
    expect(obs.stop?.cause).toStartWith('Pod exit 1: scope-escape');
    expect(obs.stop?.childEvidence).toEqual(obs.childEvidence);
    expect(obs.incident?.reason).toBe('scope-escape');
    expect(obs.incident?.childEvidence).toEqual(obs.childEvidence);
  });

  test('implementation deficit keeps the deficit only in childEvidence; stop and incident carry the Pod exit class', () => {
    const obs = simScopeEscapeLift('implementation-deficit');
    expect(obs.childEvidence).toMatchObject({ classification: 'implementation-deficit' });
    expect(obs.childEvidence).not.toHaveProperty('scopeEscape');
    expect(obs.childEvidence).not.toHaveProperty('outOfScopeEdits');
    expect(obs.disposition.failureClassification).toBe('implementation-deficit');
    expect(obs.parentExitReason).toBe('pod-failure');
    // 발견: 구현 결손은 stop class·incident reason 에 이름이 없다 — Pod 종료 분류(pod-died · pod-failure)로 남는다.
    expect(obs.stop?.class).toBe('pod-died');
    expect(obs.stop?.cause).toStartWith('Pod exit 1: pod-failure');
    expect(obs.stop?.childEvidence).toEqual(obs.childEvidence);
    expect(obs.incident?.reason).toBe('pod-failure');
    expect(obs.incident?.childEvidence).toEqual(obs.childEvidence);
  });

  test('pair names exactly the fields that diverge', () => {
    const pair = simScopeEscapeLiftPair();
    expect(pair.differingFields).toEqual([
      'childEvidence.classification',
      'childEvidence.scopeEscape',
      'childEvidence.outOfScopeEdits',
      'childEvidence.detail',
      'stop.class',
      'stop.cause',
      'incident.reason',
    ]);
    expect(pair.sameFields).toEqual(['disposition.stage', 'disposition.failureClassification', 'parentExitReason']);
  });

  test('render prints both classifications side by side (L1 원문)', () => {
    const lines = renderScopeEscapeLift(simScopeEscapeLiftPair());
    for (const line of lines) console.log(line);
    expect(lines[0]).toBe('scope-escape-lift · 층 L1 · 운영 함수 직접 호출(kubectl·네트워크 0)');
    expect(lines.some((l) => l.includes('scope-escape') && l.includes('classification=scope-escape') && l.includes('stop=scope-escape') && l.includes('incident=scope-escape'))).toBe(true);
    expect(lines.some((l) => l.includes('implementation-deficit') && l.includes('classification=implementation-deficit') && l.includes('stop=pod-died') && l.includes('incident=pod-failure'))).toBe(true);
    expect(lines.some((l) => l.startsWith('  다른 칸: '))).toBe(true);
  });
});
