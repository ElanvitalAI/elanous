import { describe, expect, test } from 'bun:test';
import {
  SCOPE_ESCAPE_HELD_KEYS,
  implementationDeficitChildResult,
  renderScopeEscapeLift,
  scopeEscapeChildResult,
  scopeStopChildResult,
  simScopeEscapeLift,
  simScopeEscapeLiftPair,
} from './fault-scope-escape-lift.js';
import { SCOPE_STOP_REASONS } from '../self-implement/scope-adjacency.js';

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

  test('control: the deficit input plus outOfScopeEdits alone is a new scope, not a failure (SCOPE-ESCAPE-AS-REFINE)', () => {
    // held 넷 중 outOfScopeEdits 한 칸만 더한다 — 정지 사유가 없으면 «구현이 알려준 새 범위»로 기록되고 분류는 구현 결손 그대로다.
    const obs = simScopeEscapeLift('scope-escape', { ...implementationDeficitChildResult(), outOfScopeEdits: ['LICENSE'] });
    expect(obs.childEvidence).toMatchObject({ classification: 'implementation-deficit', newScope: ['LICENSE'], outOfScopeEdits: ['LICENSE'] });
    expect(obs.childEvidence).not.toHaveProperty('scopeEscape');
    expect(obs.childEvidence).not.toHaveProperty('detail');
    expect(obs.stop?.class).toBe('pod-died');
    expect(obs.incident?.reason).toBe('pod-failure');
  });

  test('out-of-scope edit without a stop reason → newScope recorded at every parent field and the run continues (base: scope-escape → needs-owner)', () => {
    const obs = simScopeEscapeLift('scope-escape');
    console.log(`[scope-escape-as-refine] newScope=${JSON.stringify(obs.newScope)} stop=${obs.stop?.class} autoheal=${obs.autohealAction} incident=${obs.incident?.reason}`);
    expect(obs.childEvidence).toMatchObject({ classification: 'implementation-deficit', newScope: ['LICENSE'], outOfScopeEdits: ['LICENSE'] });
    expect(obs.childEvidence).not.toHaveProperty('scopeEscape');
    expect(obs.childEvidence).not.toHaveProperty('scopeStopReasons');
    expect(obs.newScope).toEqual(['LICENSE']);
    expect(obs.disposition.failureClassification).toBe('implementation-deficit');
    expect(obs.ledgerChildEvidence).toEqual(obs.childEvidence);
    expect(obs.parentExitReason).toBe('pod-failure');
    expect(obs.stop?.class).not.toBe('scope-escape');
    expect(obs.stop?.class).toBe('pod-died');
    expect(obs.autohealAction).toBe('resume-from-salvage');
    expect(obs.stop?.cause).toStartWith('Pod exit 1: pod-failure');
    expect(obs.stop?.childEvidence).toEqual(obs.childEvidence);
    expect(obs.incident?.reason).toBe('pod-failure');
    expect(obs.incident?.childEvidence).toEqual(obs.childEvidence);
  });

  test('a deletion stop reason still lifts to scope-escape and stops for the owner', () => {
    const obs = simScopeEscapeLift('scope-stop');
    expect(scopeStopChildResult()).toMatchObject({ scopeStopReasons: ['deletion'], outOfScopeEdits: ['LICENSE'] });
    expect(obs.childEvidence).toMatchObject({ classification: 'scope-escape', scopeEscape: true, scopeStopReasons: ['deletion'], outOfScopeEdits: ['LICENSE'] });
    expect(obs.childEvidence).not.toHaveProperty('newScope');
    expect(obs.newScope).toBeUndefined();
    expect(obs.stop?.class).toBe('scope-escape');
    expect(obs.autohealAction).toBe('needs-owner');
    expect(obs.stop?.cause).toStartWith('Pod exit 1: scope-escape');
    expect(obs.incident?.reason).toBe('scope-escape');
  });

  test('every orchestrator stop reason (SCOPE_STOP_REASONS · one source) carried by the child still stops', () => {
    for (const reason of SCOPE_STOP_REASONS) {
      const obs = simScopeEscapeLift('scope-stop', { ...scopeEscapeChildResult(), scopeStopReasons: [reason] });
      expect(obs.childEvidence?.scopeStopReasons).toContain(reason);
      expect(obs.stop?.class).toBe('scope-escape');
    }
  });

  test('a protected path or over-cap stops even when the child named no reason (derived from the names)', () => {
    const protectedObs = simScopeEscapeLift('scope-stop', { ...scopeEscapeChildResult(), outOfScopeEdits: ['.env'] });
    expect(protectedObs.childEvidence).toMatchObject({ classification: 'scope-escape', scopeEscape: true, scopeStopReasons: ['protected-path'] });
    expect(protectedObs.stop?.class).toBe('scope-escape');
    const many = Array.from({ length: 11 }, (_, i) => `lib/o${i}.ts`);
    const overCap = simScopeEscapeLift('scope-stop', { ...scopeEscapeChildResult(), outOfScopeEdits: many, outsideCount: 11 });
    expect(overCap.childEvidence).toMatchObject({ scopeEscape: true, scopeStopReasons: ['over-cap'] });
    const nameCap = simScopeEscapeLift('scope-stop', { ...scopeEscapeChildResult(), nameCapReached: true });
    expect(nameCap.childEvidence).toMatchObject({ scopeEscape: true, scopeStopReasons: ['name-cap'] });
    expect([overCap.stop?.class, nameCap.stop?.class]).toEqual(['scope-escape', 'scope-escape']);
  });

  test('implementation deficit keeps the deficit only in childEvidence; stop and incident carry the Pod exit class', () => {
    const obs = simScopeEscapeLift('implementation-deficit');
    expect(obs.childEvidence).toMatchObject({ classification: 'implementation-deficit' });
    expect(obs.childEvidence).not.toHaveProperty('scopeEscape');
    expect(obs.childEvidence).not.toHaveProperty('outOfScopeEdits');
    expect(obs.childEvidence).not.toHaveProperty('newScope');
    expect(obs.disposition.failureClassification).toBe('implementation-deficit');
    expect(obs.parentExitReason).toBe('pod-failure');
    // 발견: 구현 결손은 stop class·incident reason 에 이름이 없다 — Pod 종료 분류(pod-died · pod-failure)로 남는다.
    expect(obs.stop?.class).toBe('pod-died');
    expect(obs.stop?.cause).toStartWith('Pod exit 1: pod-failure');
    expect(obs.stop?.childEvidence).toEqual(obs.childEvidence);
    expect(obs.incident?.reason).toBe('pod-failure');
    expect(obs.incident?.childEvidence).toEqual(obs.childEvidence);
  });

  test('pair names exactly the fields that diverge — the new-scope case no longer differs at stop/incident', () => {
    const pair = simScopeEscapeLiftPair();
    expect(pair.differingFields).toEqual([
      'childEvidence.outOfScopeEdits',
      'childEvidence.newScope',
      'childEvidence.detail',
    ]);
    expect(pair.sameFields).toEqual(['disposition.stage', 'disposition.failureClassification', 'childEvidence.classification',
      'childEvidence.scopeEscape', 'parentExitReason', 'stop.class', 'stop.cause', 'incident.reason', 'autohealAction']);
  });

  test('render prints both classifications side by side (L1 원문)', () => {
    const lines = renderScopeEscapeLift(simScopeEscapeLiftPair());
    for (const line of lines) console.log(line);
    expect(lines[0]).toBe('scope-escape-lift · 층 L1 · 운영 함수 직접 호출(kubectl·네트워크 0)');
    expect(lines.some((l) => l.startsWith('  scope-escape ·') && l.includes('newScope=["LICENSE"]') && l.includes('stop=pod-died') && l.includes('autoheal=resume-from-salvage'))).toBe(true);
    expect(lines.some((l) => l.startsWith('  scope-stop ·') && l.includes('classification=scope-escape') && l.includes('stop=scope-escape') && l.includes('autoheal=needs-owner'))).toBe(true);
    expect(lines.some((l) => l.includes('implementation-deficit') && l.includes('classification=implementation-deficit') && l.includes('stop=pod-died') && l.includes('incident=pod-failure'))).toBe(true);
    expect(lines.some((l) => l.startsWith('  다른 칸: '))).toBe(true);
  });
});
