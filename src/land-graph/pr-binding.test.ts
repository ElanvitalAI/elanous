// JUDGE-GREEN-PR-BINDING-LEGACY (11-28) — the ONE binding rule both green lanes use, over literal replays of the 0.3.39 ledger
// (evidence lines · writers · PR titles/bodies copied from features.sqlite and GitHub 11-28 04:00Z). Expected values are literals
// (rule 11) — never rendered by the code under test.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { addItem, checklistTrails, claimItem, setItem, type ChecklistItem } from '../release-loop/checklist.js';
import { evidenceAdd } from '../release-loop/feature-store.js';
import { parseMergeLog, triageGreen } from '../release-loop/green-triage.js';
import { collectPrFacts, type CollectorDeps } from '../judge-butler/collector.js';
import { judgeCell } from '../judge-butler/done-when.js';
import { bindsCell, ownEvidenceCite, prCellBinding, type CellTrail } from './cell-link.js';
import { bindingOf, boundPrs, loadPrBindingPolicy, parsePrBindingPolicy, PR_BINDING_FALLBACK, PR_BINDING_POLICY, type BindingContext } from './pr-binding.js';

const OWN = PR_BINDING_POLICY.ownEvidence;
const trail = (lines: ReadonlyArray<readonly [string, string]>, claimants: string[] = []): CellTrail =>
  ({ writes: lines.map(([by, text], i) => ({ at: `2026-11-27T0${i}:00:00.000Z`, by, text })), claimants, writers: [] });

describe('graphs/policies/pr-binding.yaml — the one policy', () => {
  test('the shipped file parses, names the five bases and keeps the fallback in step', () => {
    const p = loadPrBindingPolicy();
    expect(p.bases).toEqual(['cell-line', 'title', 'branch', 'pipeline', 'own-evidence']);
    expect(p.ownEvidence.authors).toEqual(['owner', 'writer', 'claimant', 'owner-hand', 'unattributed']);
    expect(p.ownEvidence.neverAuthors).toEqual(['JUDGE-BUTLER', 'JUD', 'JUD-*']);
    expect(p.ownEvidence.excludeCells).toEqual(['*-E4']);
    expect(p).toEqual(PR_BINDING_FALLBACK);
  });
  test('a malformed policy throws (the loader falls back) · an unknown basis is refused', () => {
    expect(() => parsePrBindingPolicy('bases: [cell-line, bogus]\nown_evidence: {authors: [owner], never_authors: [JUD], implementation: [merged], negation: [무관]}')).toThrow('unknown bases bogus');
    expect(() => parsePrBindingPolicy('bases: []')).toThrow('bases must be a non-empty list of strings');
    expect(loadPrBindingPolicy('/nonexistent/pr-binding.yaml')).toEqual(PR_BINDING_FALLBACK);
  });
});

describe('ownEvidenceCite — the 0.3.39 live lines', () => {
  test('COORD-RIGHTS-INVENTORY: OP (owner) attached «#40345» as a bare line → cites', () => {
    const cell = { id: 'COORD-RIGHTS-INVENTORY', title: '조율자 전 탭 관측·범위 제어 권한 확대 — 기존 수리 PR 통합 검증', owner: 'OP', evidence: '디스패처 건너뜀: TC #192466 읽기 전용 대조\n#40345\n#40347' };
    expect(ownEvidenceCite(cell, 40345, trail([['HAND-TUI-D', '디스패처 건너뜀: TC #192466 읽기 전용 대조'], ['OP', '#40345'], ['OP', '#40347']]), OWN))
      .toEqual({ kind: 'cites', by: 'OP', clause: '#40345' });
  });
  test('BULLETIN-NOW-STALE: «#40268 merged; head …» by an unattributed writer (cli) → cites', () => {
    const line = '#40268 merged; head 4de17ab2342caba2a27e3680dfaa538ab24cc2c5; focused exit 0: seat-state/RES/evidence/PREGATE-GREEN/40268-4de17ab2342c-minim5/receipt.json';
    expect(ownEvidenceCite({ id: 'BULLETIN-NOW-STALE', owner: 'OP', evidence: line }, 40268, trail([['cli', line]]), OWN)).toEqual({ kind: 'cites', by: 'cli', clause: '#40268 merged' });
  });
  test('SEAT-MAIL-EXCHANGE-CORE: a negated clause («실행 build 아님») does not cancel the clean «착지 sha» clause beside it', () => {
    const ev = '착지 sha(대응표 seat-state/TC/REL-MAIL-CORE-MAP-1119.md): #13 #38969 207337fd9884 · #14 #38869 4e4397eb9f20\n#38969 merge 207337fd9884는 실행 build 아님';
    expect(ownEvidenceCite({ id: 'SEAT-MAIL-EXCHANGE-CORE', owner: 'OP', evidence: ev }, 38969, trail([['cli', ev]]), OWN))
      .toEqual({ kind: 'cites', by: 'cli', clause: '착지 sha(대응표 seat-state/TC/REL-MAIL-CORE-MAP-1119.md): #13 #38969 207337fd9884' });
  });
  test('WORK-NEXT-ROSTER-SCOPE-FU: «#40622는 무관한 병합 PWA PR» (a hand that held it) → none', () => {
    const ev = '디스패처 건너뜀 [16f695fd41b035d6]: TC-H-CC-1 #201591 담당 수락. #40622는 무관한 병합 PWA PR (TC #201587)';
    expect(ownEvidenceCite({ id: 'WORK-NEXT-ROSTER-SCOPE-FU', owner: 'TC', evidence: ev }, 40622, trail([['TC-H-CX-7', ev]], ['TC-H-CX-7']), OWN))
      .toEqual({ kind: 'none', why: 'every own clause citing it is negated («무관» · TC-H-CX-7)' });
  });
  test('the subject PR never binds — LAND-PREGATE-BYPASS-40606 (id) · ELS-INPUT-FRAMING-HARDEN «#39373 셀프리뷰 후보» (title)', () => {
    expect(ownEvidenceCite({ id: 'LAND-PREGATE-BYPASS-40606', owner: 'OP', evidence: '#40606 merged without a same-head receipt' }, 40606, trail([['OP', '#40606 merged without a same-head receipt']]), OWN))
      .toEqual({ kind: 'none', why: "#40606 is the cell's subject (its id/title names it)" });
    const els = { id: 'ELS-INPUT-FRAMING-HARDEN', title: '대상 경로: src/els/ — #39373 셀프리뷰 후보 4건(재현 전)', evidence: 'OP #117393 FU: #39373 58dfdf43175f의 R 수동 해제는 전환 범위' };
    expect(ownEvidenceCite(els, 39373, trail([['OP', els.evidence]], ['OP']), OWN)).toEqual({ kind: 'none', why: "#39373 is the cell's subject (its id/title names it)" });
  });
  test('a judge\'s line never binds (JUD · JUDGE-BUTLER) · a seat that never held the cell does not either · an E4 cell is excluded', () => {
    const jud = 'JUD 2026-11-27: #40604 MERGED head 97471f0e798c3f0ef4a9314789f93b1d521721e8';
    expect(ownEvidenceCite({ id: 'WORKTREE-EPHEMERAL', owner: 'OP', evidence: jud }, 40604, trail([['JUD', jud]]), OWN)).toEqual({ kind: 'none', why: "no implementation clause by the cell's own seat" });
    expect(ownEvidenceCite({ id: 'GOAL-AUTHORING-VERIFY-PLAN', owner: 'TC', evidence: '#40390 merged' }, 40390, trail([['MK', '#40390 merged']]), OWN)).toEqual({ kind: 'none', why: "no implementation clause by the cell's own seat" });
    expect(ownEvidenceCite({ id: 'COND-WATCH-E4', owner: 'TC', evidence: '#40586 merged' }, 40586, trail([['TC', '#40586 merged']]), OWN)).toEqual({ kind: 'none', why: 'cell kind is never bound by its evidence (own_evidence.exclude_cells)' });
  });
  test('a mention without an implementation word or shape does not bind (LAND-RECEIPT-RAW-RETENTION «#40350 finisher 로 끝»)', () => {
    const ev = '판 이동 0.3.38→0.3.39 · 새 요구: 자동 재실행은 #40350 finisher 로 끝 · R 착지 집사 / A TC';
    expect(ownEvidenceCite({ id: 'LAND-RECEIPT-RAW-RETENTION', owner: 'OP', evidence: ev }, 40350, trail([['OP', ev]]), OWN)).toEqual({ kind: 'none', why: "no implementation clause by the cell's own seat" });
  });
});

describe('bindsCell · own-evidence counts only for a PR silent about every cell', () => {
  const IDS = ['COORD-RIGHTS-INVENTORY', 'YAML-DEF-LOADER', 'LEDGER-DRIVEN-UMBRELLA', 'YAML-DEFINABLE-AUDIT', 'JEV-DECIDE-KIT', 'JEV-GOAL-CONTINUE'].map(id => ({ id }));
  test('#40348 (no «칸» line · title «COORD-RIGHTS 11-27» names no cell) + own evidence → bound by own-evidence', () => {
    const b = prCellBinding({ title: 'fix(els): every coordinator observes every pane · interrupt in scope (COORD-RIGHTS 11-27)', body: 'Inventory (seat-state/OP/COORD-RIGHTS-INVENTORY-1127.md): a named sub-coordinator could read only its own pane', headRef: 'fix/coord-rights-els-1127' }, IDS, [], ['COORD-RIGHTS-INVENTORY']);
    expect(b).toEqual({ declared: [], title: [], branch: [], pipeline: [], selfDeclared: false, evidence: ['COORD-RIGHTS-INVENTORY'] });
    expect(bindsCell(b, 'COORD-RIGHTS-INVENTORY')).toEqual({ ok: true, basis: 'own-evidence' });
    expect(bindsCell(b, 'COORD-RIGHTS-INVENTORY', ['cell-line', 'title', 'branch', 'pipeline'])).toEqual({ ok: false, why: 'declares no cell (no «칸:» line · title · branch)' });
  });
  test('#40588 «칸: JEV-DECIDE-KIT» — JEV-GOAL-CONTINUE\'s evidence cannot add itself', () => {
    const b = prCellBinding({ title: 'feat(kit): jev-decide — one Jev kit for every site', body: '칸: JEV-DECIDE-KIT (0.3.39 P0 · owner OP/claude)\n- **C**: 다음 칸(JEV-MEMORY-RECALL 하루 ~6,900회 · JEV-GOAL-CONTINUE)이 이 배관 위에 얹힌다.', headRef: 'jev-decide-kit' }, IDS, [], ['JEV-GOAL-CONTINUE']);
    expect(bindsCell(b, 'JEV-GOAL-CONTINUE')).toEqual({ ok: false, why: "is JEV-DECIDE-KIT's PR" });
  });
  test('#40445 «칸: FED-FACT-OP-ACTIONS» (a 0.3.38 cell) — the umbrella\'s «implementing: PR #40445» does not bind it', () => {
    const b = prCellBinding({ title: 'feat(fed-state): FED-FACT-OP-ACTIONS — assign/veto/reassign/decision as fed facts', body: '칸: FED-FACT-OP-ACTIONS (0.3.38 P1 · OP 11-27)', headRef: 'op/fed-fact-op-actions' }, IDS, [], ['LEDGER-DRIVEN-UMBRELLA']);
    expect(bindsCell(b, 'LEDGER-DRIVEN-UMBRELLA')).toEqual({ ok: false, why: 'declares a cell of another release (its «칸» line names no cell of this one)' });
  });
  test('#40436 umbrella: «- 등록 칸: YAML-DEF-LOADER · …» binds the cells it lists, not LEDGER-DRIVEN-UMBRELLA', () => {
    const b = prCellBinding({ title: 'docs(conductor): YAML-SYSTEM 우산 — 정의만으로 도는 시스템 (YAML-DEFINABLE-AUDIT)', body: '칸 **YAML-DEFINABLE-AUDIT**(0.3.38) — 우산 설계 정본.\n- 등록 칸: YAML-DEF-LOADER · YAML-POLICY-PACK-CAPS · YAML-POLICY-PACK-ROUTING(0.3.38)', headRef: 'op/yaml-definable-system' }, IDS);
    expect(b.declared).toEqual(['YAML-DEFINABLE-AUDIT', 'YAML-DEF-LOADER']);
    expect(bindsCell(b, 'YAML-DEF-LOADER')).toEqual({ ok: true, basis: 'cell-line' });
    expect(bindsCell(b, 'LEDGER-DRIVEN-UMBRELLA')).toEqual({ ok: false, why: "is YAML-DEFINABLE-AUDIT, YAML-DEF-LOADER's PR" });
  });
  test('«다음 칸: …» / «선행 칸: …» name cells the PR is not — they never bind', () => {
    const b = prCellBinding({ title: 'feat(kit): one kit', body: '- 다음 칸: JEV-GOAL-CONTINUE\n- 선행 칸: YAML-DEF-LOADER', headRef: 'feat/one-kit' }, IDS);
    expect([b.declared, b.selfDeclared]).toEqual([[], false]);
  });
});

describe('ONE definition — green-triage and the judge butler split a cell\'s PRs the same way', () => {
  const H = (n: number) => String(n).padEnd(40, 'c');
  const metas: Record<number, { title: string; body: string; headRef: string }> = {
    40268: { title: 'fix(op-bulletin): the graph writes BULLETIN-NOW itself', body: 'BULLETIN-NOW.md was last written 11-26 07:09 KST', headRef: 'op/bulletin-deterministic-1126' },
    40622: { title: 'test: simulate synced PWA gate delta and cache lifecycle', body: '', headRef: 'tc/pwa-gate-e4-1127' },
    40630: { title: 'feat(release): CURRENT-RELEASE-ONE-SOURCE — one current-board record', body: '칸: CONTEXT-BUS-FEDERATION (0.3.39 P0)', headRef: 'op/current-release-one-source' },
  };
  const cells: ChecklistItem[] = [
    { id: 'BULLETIN-NOW-STALE', title: 'BULLETIN-NOW stale', status: 'yellow', owner: 'OP', evidence: '#40268 merged; head 4de17ab2342caba2a27e3680dfaa538ab24cc2c5', updatedAt: '', updatedBy: 'OP' },
    { id: 'WORK-NEXT-ROSTER-SCOPE-FU', title: 'roster scope', status: 'yellow', owner: 'TC', evidence: '#40622는 무관한 병합 PWA PR', updatedAt: '', updatedBy: 'TC' },
    { id: 'CONTEXT-BUS-FEDERATION', title: 'bus', status: 'yellow', owner: 'OP', evidence: '#40630 merged', updatedAt: '', updatedBy: 'OP' },
    { id: 'PWA-GATE-E4-1127', title: 'pwa', status: 'green', owner: 'TC', evidence: 'done', updatedAt: '', updatedBy: 'JUD' },
    { id: 'CURRENT-RELEASE-ONE-SOURCE', title: 'one source', status: 'green', owner: 'OP', evidence: 'done', updatedAt: '', updatedBy: 'JUD' },
  ];
  const trails: Record<string, CellTrail> = {
    'BULLETIN-NOW-STALE': trail([['OP', cells[0]!.evidence!]]), 'WORK-NEXT-ROSTER-SCOPE-FU': trail([['TC-H-CX-7', cells[1]!.evidence!]], ['TC-H-CX-7']),
    'CONTEXT-BUS-FEDERATION': trail([['OP', '#40630 merged']]),
  };
  const ctx: BindingContext = { cells, trail: id => trails[id] };
  const log = Object.keys(metas).map(n => `${H(Number(n))}\tsquash (#${n})`).join('\n');
  test('triage judge lane = the cells the butler signs · the unbound PRs are named the same way', () => {
    const triage = triageGreen('0.3.39', cells, { merged: parseMergeLog(log), greenLanes: Object.keys(metas).map(n => `${n}-${H(Number(n)).slice(0, 12)}-minim5`), binding: { meta: pr => metas[pr], context: () => ctx } });
    expect(triage.counts).toEqual({ judge: 1, evidence: 0, supply: 2 });
    expect(triage.rows.judge.map(r => [r.id, r.mergedPrs])).toEqual([['BULLETIN-NOW-STALE', [40268]]]);
    expect(triage.rows.supply.map(r => r.reason)).toEqual([
      "no merged PR of WORK-NEXT-ROSTER-SCOPE-FU — #40622 is PWA-GATE-E4-1127's PR",
      'no merged PR of CONTEXT-BUS-FEDERATION — #40630 «칸: CONTEXT-BUS-FEDERATION» but its title/branch name CURRENT-RELEASE-ONE-SOURCE — mislabelled PR (fix its 칸 line)',
    ]);
    const deps: CollectorDeps = {
      merged: parseMergeLog(log), landedHead: pr => H(pr), prMeta: pr => ({ head: H(pr), files: [`src/p${pr}.ts`], ...metas[pr]! }),
      receipt: (pr, head) => ({ head, dir: `PREGATE-GREEN/${pr}-${head.slice(0, 12)}-minim5`, focusedFiles: 1, focused: { pass: 9, fail: 0 } }),
      security: () => [], cells, trail: id => trails[id],
    };
    const signed = cells.filter(c => c.status === 'yellow').filter(c => judgeCell(c, collectPrFacts([...(c.evidence ?? '').matchAll(/#(\d{5})/gu)].map(m => Number(m[1])), deps)).kind === 'sign').map(c => c.id);
    expect(signed).toEqual(['BULLETIN-NOW-STALE']);
    const split = boundPrs('WORK-NEXT-ROSTER-SCOPE-FU', [40622], pr => bindingOf(pr, metas[pr], ctx));
    expect(split).toEqual({ bound: [], notMine: ["#40622 is PWA-GATE-E4-1127's PR"] });
  });
  test('a PR whose body was not read yet is unbound in both lanes (binding unknown)', () => {
    expect(bindingOf(40268, { title: 'x' }, ctx)).toBeNull();
    expect(boundPrs('BULLETIN-NOW-STALE', [40268], () => null)).toEqual({ bound: [], notMine: ['#40268 PR body not read yet (binding unknown · next tick)'] });
  });
});

describe('checklistTrails — evidence writes ⊕ the seats that held the cell, every release', () => {
  const roots: string[] = [];
  const track = process.env.ELANOUS_TRACK;
  afterEach(() => { if (track === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = track; resetElanousConfigDir(); for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true }); });
  test('set/add evidence by two seats across two releases · a claim → one ordered trail', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-binding-trail-')); roots.push(dir); setElanousConfigDir(dir);
    process.env.ELANOUS_TRACK = 'OP'; // claim needs the owner or OP
    addItem('9.9.8', { id: 'TRAIL-CELL', title: 'trail cell' });
    claimItem('9.9.8', 'TRAIL-CELL', 'TC-7');
    setItem('9.9.8', 'TRAIL-CELL', { evidence: '#40345 merged' }, 'TC-7');
    addItem('9.9.9', { id: 'TRAIL-CELL', title: 'trail cell', owner: 'OP' }, { allowDuplicateId: true });
    evidenceAdd('TRAIL-CELL', '9.9.9', '#40347', 'cli');
    const t = checklistTrails(['TRAIL-CELL', 'NO-SUCH-CELL']);
    expect(t.get('TRAIL-CELL')!.writes.map(w => [w.by, w.text])).toEqual([['TC-7', '#40345 merged'], ['cli', '#40347']]);
    expect(t.get('TRAIL-CELL')!.claimants).toEqual(['TC-7', 'OP']);
    expect(t.has('NO-SUCH-CELL')).toBe(false);
  });
});
