// SEAT-AREA-GUARD — the seat-roles reader and rule. Expectations are independent literals (rule 11).
import { describe, expect, test } from 'bun:test';
import { cellAreaPaths, globMatch, isPoolSeat, legacySeatRoles, loadSeatRoles, parseSeatRoles, pickByArea, seatRuleOf, seatTakesCell } from './index.js';

const shipped = loadSeatRoles();

describe('shipped graphs/policies/seat-roles.yaml', () => {
  test('the 11-28 incident cells never fit MK; MK docs cells do', () => {
    const cases: Array<[string, string]> = [
      ['RES-ABSORB-GUARDIAN', '자원국 흡수: 정책 설정화 · 수호자 순찰 실가동 · 그림자 1일(eln res shadow-report) → RES 탭 잠재움'],
      ['ELS-REMOTE-TAB-RELAY', 'Remote tabs stage 2: through the relay (no direct ssh/tailnet) — OIDC auth, relay route, host badge, same new/attach/close/list'],
      ['ELN-OP-SELF-HEAL-LOOP', '셀프 인지로 스스로 고치는 능력 — eln OP 상주 루프'],
      ['LAND-RECEIPT-RAW-RETENTION', '착지 전 pregate focused 원문이 보존 정리로 지워져 «raw swept → re-run pregate» 대기 12건'],
    ];
    for (const [id, title] of cases) expect([id, seatTakesCell('MK', { id, title, owner: 'OP' }, shipped).ok]).toEqual([id, false]);
    for (const id of ['DOCS-USER-FIRST', 'DOCS-ELS', 'WEB-DEPLOY-ONE-PLACE', 'SIM-DOCS']) expect([id, seatTakesCell('MK', { id, title: 'x', owner: 'OP' }, shipped).ok]).toEqual([id, true]);
  });

  test('rule strings name what matched', () => {
    expect(seatTakesCell('MK', { id: 'DOCS-ELS', title: 'els section' }, shipped)).toEqual({ ok: true, rule: 'cell DOCS-ELS ~ DOCS-*', area: true });
    expect(seatTakesCell('MK', { id: 'PUBLIC-NOTES', title: 'notes', body: '대상 경로: release/public/docs/start.md' }, shipped)).toEqual({ ok: true, rule: 'path release/public/docs/start.md ~ release/public/**', area: true });
    expect(seatTakesCell('UX', { id: 'SIDE-TAB-HANG', title: '대상 경로: src/els/side-tab.ts — attach never hangs' }, shipped)).toEqual({ ok: true, rule: 'path src/els/side-tab.ts ~ src/els/**', area: true });
    expect(seatTakesCell('UX', { id: 'PWA-REACHABLE-NARROW', title: 'narrow screens' }, shipped)).toEqual({ ok: true, rule: 'cell PWA-REACHABLE-NARROW ~ PWA-*', area: true });
    expect(seatTakesCell('TC-H-3', { id: 'ANY-CELL', title: 'no path' }, shipped)).toEqual({ ok: true, rule: 'pool hand (any area)', area: false });
    expect(seatTakesCell('TC', { id: 'ANY-CELL', title: 'no path' }, shipped)).toEqual({ ok: true, rule: 'TC coordinator (any area)', area: false });
  });

  test('refusals: no area · off area · not in the pool · the owner always fits', () => {
    expect(seatTakesCell('MK', { id: 'LAND-X', title: 'no path here' }, shipped)).toMatchObject({ ok: false, code: 'no-area' });
    expect(seatTakesCell('MK', { id: 'LAND-Y', title: '대상 경로: src/land-graph/land-graph.ts' }, shipped)).toMatchObject({ ok: false, code: 'off-area' });
    expect(seatTakesCell('UX', { id: 'LAND-Y', title: '대상 경로: src/land-graph/land-graph.ts' }, shipped)).toMatchObject({ ok: false, code: 'off-area' });
    expect(seatTakesCell('OP', { id: 'ANY', title: 'x' }, shipped)).toMatchObject({ ok: false, code: 'not-pool' });
    expect(seatTakesCell('MK', { id: 'LAND-X', title: 'no path here', owner: 'MK/docs' }, shipped)).toEqual({ ok: true, rule: 'owner (MK holds LAND-X)', area: true });
    expect(seatTakesCell('JUD-3', { id: 'ANY', title: 'x' }, shipped).ok).toBe(true); // maker ≠ judge rules decide
  });

  test('pool seats', () => {
    expect(['OP', 'MK', 'UX', 'TC', 'TC-H-1', 'JUD', 'JUD-B', 'REVIEW-2'].map((s) => [s, isPoolSeat(s, shipped)])).toEqual([
      ['OP', false], ['MK', true], ['UX', true], ['TC', true], ['TC-H-1', true], ['JUD', false], ['JUD-B', false], ['REVIEW-2', false]]);
    expect(seatRuleOf('judge-a', shipped).key).toBe('JUD*');
  });
});

describe('reader', () => {
  test('legacy board: every seat a pool hand, any cell', () => {
    expect(seatTakesCell('MK', { id: 'LAND-X', title: 'x' }, legacySeatRoles())).toEqual({ ok: true, rule: 'pool hand (any area)', area: false });
  });
  test('malformed files are refused with the field named', () => {
    expect(() => parseSeatRoles('version: 2\n')).toThrow('version must be 1');
    expect(() => parseSeatRoles('version: 1\nseats:\n  MK: { kind: boss, pool: true }\n')).toThrow('seats.MK.kind');
    expect(() => parseSeatRoles('version: 1\nseats:\n  MK: { kind: hand }\n')).toThrow('seats.MK.pool');
    expect(() => parseSeatRoles('version: 1\nseats:\n  MK: { kind: hand, pool: true, areas: {} }\n')).toThrow('needs paths or cells');
  });
  test('pickByArea: the area fit first, else the first general fit, else -1 · no fit = the first', () => {
    const hands = ['TC-H-1', 'TC-H-2', 'UX', 'MK'];
    const docs = { id: 'DOCS-ELS', title: 'x' };
    const infra = { id: 'LAND-X', title: 'x' };
    expect(pickByArea(hands, (h) => h, (seat) => seatTakesCell(seat, docs, shipped))).toBe(3);
    expect(pickByArea(hands, (h) => h, (seat) => seatTakesCell(seat, infra, shipped))).toBe(0);
    expect(pickByArea(['MK', 'UX'], (h) => h, (seat) => seatTakesCell(seat, infra, shipped))).toBe(-1);
    expect(pickByArea(['MK', 'UX'], (h) => h)).toBe(0);
  });
  test('globs', () => {
    expect([globMatch('website/**', 'website'), globMatch('website/**', 'website/a/b.md'), globMatch('src/els/**', 'src/elsx/a.ts'), globMatch('release/next.md', 'release/next.md'),
      globMatch('src/*.ts', 'src/a/b.ts'), globMatch('DOCS-*', 'DOCS-ELS', { segments: false }), globMatch('*-DOCS', 'SIM-DOCS', { segments: false })]).toEqual([true, true, false, true, false, true, true]);
  });
  test('area paths: labelled line ⊕ path tokens in title/body/done-when · no urls · no ..', () => {
    expect(cellAreaPaths({ id: 'X', title: 'docs.elanous.ai(website/ Docusaurus)', body: 'see https://x.y/z and ../up', doneCriterion: '`release/next.md` updated' }).sort())
      .toEqual(['release/next.md', 'website']);
  });
});
