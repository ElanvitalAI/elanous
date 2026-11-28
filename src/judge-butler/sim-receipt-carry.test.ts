// SIM-RECEIPT-CARRY — receipt name parts · carry binding in the kit · landedIn on a real repo · the scene run decision ·
// publish to the shared root · the three sim world scenes (5 seeds · legacy + graph). Expectations are literals (rule 11).
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gitAt } from '../git-fs/smart-run.js';
import { landedIn } from '../git-smart/delta.js';
import { assessSimEvidence, loadSimEvidencePolicy, publishSimReceipt } from '../kit/requirement-judge/sim-evidence.js';
import { receiptNameParts } from '../land-graph/pr-binding.js';
import { simWorldScenarios as scenes } from '../ux-sim/sim-world/supervisors/sim-receipt-carry.js';
import type { SimWorldScenarioContext } from '../ux-sim/sim-world/types.js';
import { explicitTestRootArgv, runNamedScene } from '../kit/requirement-judge/sim-run.js';
import { extractTestFlag, findTreeRoot, resolveTestRoot } from '../cli/test-flag.js';
import { evidenceHeadSha } from '../cli/release-checklist-read-cli.js';
import { installedBuildSha } from '../fed-observe/sources-live.js';

const tmp = (tag: string) => mkdtempSync(join(tmpdir(), `sim-carry-${tag}-`));
const H = 'ab'.repeat(20); const O = 'cd'.repeat(20);
const rec = (scenario: string, engine: 'legacy' | 'graph', seed: number) => ({ world: 'supervisors', scenario, engine, seed, expected: 'green', actual: 'pass', verdict: 'pass', diffFirstLine: null, observedReason: null, dir: 'd', wallMs: 1 });
const on = (head: string) => [1, 2, 3, 4, 5].map(seed => ({ runId: `40700-${head.slice(0, 12)}-s${seed}-JB-CRIT-EMPTY`, summary: { scenarios: [rec('JB-CRIT-EMPTY', 'legacy', seed), rec('JB-CRIT-EMPTY', 'graph', seed)] } })) as never;
const index = new Map([['JB-CRIT-EMPTY', 'supervisors']]);
const prs = [{ pr: 40700, head: H, scenes: [] }];

describe('receipt name parts (pr-binding kit)', () => {
  test('pr · head12 from «<pr>-<head12>…» · anything else null', () => {
    expect(receiptNameParts('40707-aa82748ebbda-s1-SM-CARRY-CONTEXT-MOVED')).toEqual({ pr: 40707, head12: 'aa82748ebbda' });
    expect(receiptNameParts('40707-AA82748EBBDA')).toEqual({ pr: 40707, head12: 'aa82748ebbda' });
    expect(receiptNameParts('seed-1-20261128T100000Z-123')).toBeNull();
    expect(receiptNameParts('40707-aa82748ebbd')).toBeNull();
    expect(receiptNameParts('40707-aa82748ebbdaf-s1')).toBeNull();
  });
});

describe('carry binding (sim-evidence kit)', () => {
  test('older head + carries ok → met, the note names the head it came from', () => {
    const r = assessSimEvidence({ cellId: 'C', criterion: 'JB-CRIT-EMPTY green', e4Line: null, prs }, { summaries: on(O), index, carries: () => ({ ok: true }) });
    expect(r.need).toBe('met');
    expect(r.need === 'met' && r.note).toBe('sim JB-CRIT-EMPTY 시드 5·graph+legacy·regression 0 (승계 ← cdcdcdcdcdcd · PR 고유 변경 동일)');
  });
  test('older head + carries refused → missing, the reason is named · no carry port → plain missing', () => {
    const r = assessSimEvidence({ cellId: 'C', criterion: 'JB-CRIT-EMPTY green', e4Line: null, prs }, { summaries: on(O), index, carries: () => ({ ok: false, reason: 'PR-own change differs' }) });
    expect(r.need === 'missing' && r.why).toBe('시뮬 영수 미충족 — 장면 JB-CRIT-EMPTY 영수 없음(같은 PR head 의 sim world summary · 옛 head cdcdcdcdcdcd 영수 승계 불가 — PR-own change differs)');
    const n = assessSimEvidence({ cellId: 'C', criterion: 'JB-CRIT-EMPTY green', e4Line: null, prs }, { summaries: on(O), index });
    expect(n.need === 'missing' && n.why).toBe('시뮬 영수 미충족 — 장면 JB-CRIT-EMPTY 영수 없음(같은 PR head 의 sim world summary)');
    expect(n.need === 'missing' && n.request).toBe(`eln --test sim world run supervisors --seed 1..5 --engine both --only JB-CRIT-EMPTY --run-id 40700-${H.slice(0, 12)}-s1..5-JB-CRIT-EMPTY`);
  });
  test('another PR number never asks the carry port', () => {
    let asked = 0;
    const r = assessSimEvidence({ cellId: 'C', criterion: 'JB-CRIT-EMPTY green', e4Line: null, prs: [{ pr: 40701, head: H, scenes: [] }] }, { summaries: on(O), index, carries: () => { asked++; return { ok: true }; } });
    expect(r.need).toBe('missing'); expect(asked).toBe(0);
  });
});

/** main M0 → PR A · main M1 · PR merges main → B · main squashes B «(#7)» → S. */
function squashRepo() {
  const dir = tmp('repo'); const g = gitAt(dir);
  const run = (a: string[]) => { const r = g(a); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
  const id = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
  const commit = (m: string) => { run(['add', '-A']); run([...id, 'commit', '-q', '-m', m]); return run(['rev-parse', 'HEAD']); };
  run(['init', '-q', '-b', 'main']); writeFileSync(join(dir, 'b.txt'), 'b\n'); commit('base');
  run(['checkout', '-q', '-b', 'pr']); writeFileSync(join(dir, 'own.ts'), 'own\n'); commit('own');
  run(['checkout', '-q', 'main']); writeFileSync(join(dir, 'o.txt'), 'o\n'); const m1 = commit('main');
  run(['checkout', '-q', 'pr']); run([...id, 'merge', '-q', '--no-ff', '-m', 'merge main', 'main']); const b = run(['rev-parse', 'HEAD']);
  run(['checkout', '-q', 'main']); run(['merge', '-q', '--squash', b]); const s = commit('feat: x (#7)');
  writeFileSync(join(dir, 'b.txt'), 'b2\n'); const later = commit('later (#8)');
  return { dir, g, m1, b, s, later };
}

describe('landedIn (delta kit) · runNamedScene (the butler\'s own run)', () => {
  test('squash landing: the «(#pr)» squash with the same own lines carries the head · before it no · another PR no', () => {
    const r = squashRepo();
    expect(landedIn(r.g, 7, r.b, r.later)).toEqual({ ok: true, via: 'squash', commit: r.s });
    expect(landedIn(r.g, 7, r.b, r.m1)).toEqual({ ok: false, reason: `no commit of #7 on ${r.m1.slice(0, 12)}` });
    expect(landedIn(r.g, 8, r.b, r.later)).toEqual({ ok: false, reason: `commit ${r.later.slice(0, 12)} of #8 is not this head's PR-own change` });
  });
  test('the run: five seeds with scene-suffixed run ids · a kept summary is not re-run · an uncarried build runs nothing', () => {
    const r = squashRepo(); const ran: string[] = [];
    const policy = loadSimEvidencePolicy();
    const deps = { policy, git: r.g, runRoot: '/x/.elanous-test', exists: (p: string) => p === `/x/.elanous-test/sim-world/7-${r.b.slice(0, 12)}-s2-JB-CRIT-EMPTY/summary.json`,
      run: (argv: readonly string[]) => { ran.push(argv[argv.indexOf('--run-id') + 1]!); return { rc: 0, out: '' }; } };
    expect(runNamedScene({ ...deps, buildSha: r.later }, 'supervisors', 'JB-CRIT-EMPTY', 7, r.b)).toEqual({ rc: 0, out: `s1 rc 0 · s2 kept · s3 rc 0 · s4 rc 0 · s5 rc 0 (build ${r.later.slice(0, 12)} carries #7 via squash)` });
    expect(ran).toEqual([1, 3, 4, 5].map(s => `7-${r.b.slice(0, 12)}-s${s}-JB-CRIT-EMPTY`));
    ran.length = 0;
    expect(runNamedScene({ ...deps, buildSha: r.m1 }, 'supervisors', 'JB-CRIT-EMPTY', 7, r.b).rc).toBe(-1);
    expect(runNamedScene({ ...deps, buildSha: null }, 'supervisors', 'JB-CRIT-EMPTY', 7, r.b).rc).toBe(-1);
    expect(ran).toEqual([]);
  });
});

describe('JUDGE-BUTLER-SELF-RUN-FIX — explicit test root · installed head sha', () => {
  test('explicitTestRootArgv: only the bare «--test» right after the cli word becomes «--test=<root>»', () => {
    expect(explicitTestRootArgv(['eln', '--test', 'sim', 'world', 'run', 'supervisors'], '/r/.elanous-test')).toEqual(['eln', '--test=/r/.elanous-test', 'sim', 'world', 'run', 'supervisors']);
    expect(explicitTestRootArgv(['eln', 'sim', '--test'], '/r/.elanous-test')).toEqual(['eln', 'sim', '--test']);
  });
  test('a runRoot outside any git tree: the child argv names the root explicitly and the real parser resolves exactly it', () => {
    const r = squashRepo();
    const home = realpathSync(tmp('home')); const runRoot = join(home, '.elanous-test');
    expect(findTreeRoot(home)).toBeNull(); // the installed box: cwd = dirname(runRoot) = ~ · no .git above
    const argvs: string[][] = [];
    const out = runNamedScene({ policy: loadSimEvidencePolicy(), git: r.g, buildSha: r.later, runRoot, exists: () => false,
      run: argv => { argvs.push([...argv]); return { rc: 0, out: '' }; } }, 'supervisors', 'JB-CRIT-EMPTY', 7, r.b);
    expect(out.rc).toBe(0);
    expect(argvs.map(a => a[0])).toEqual([1, 2, 3, 4, 5].map(() => `--test=${runRoot}`));
    expect(argvs[0]!.slice(1, 5)).toEqual(['sim', 'world', 'run', 'supervisors']);
    const flag = extractTestFlag(['bun', 'eln', ...argvs[0]!]);
    expect(flag.globalExplicitDir).toBe(runRoot);
    expect(resolveTestRoot(dirname(runRoot), flag.globalExplicitDir)).toBe(runRoot);
    expect(resolveTestRoot(dirname(runRoot), undefined)).toBeNull(); // the bare form: «격리 루트를 정할 수 없습니다» rc 1
  });
  test('evidenceHeadSha: git HEAD first · no .git → the installed install.json commit · short / missing → null', () => {
    const base = tmp('pkg'); const root = join(base, 'current', 'node_modules', 'elanous'); mkdirSync(root, { recursive: true });
    const sha = '0123456789abcdef0123456789abcdef01234567';
    writeFileSync(join(base, 'current', 'install.json'), JSON.stringify({ version: '0.3.40-dev.0', commit: sha }));
    const installed = (p: string) => installedBuildSha(p, { gitSha: () => null });
    expect(evidenceHeadSha(root, { installed })).toBe('0123456789abcdef0123456789abcdef01234567');
    expect(evidenceHeadSha(root, { gitHead: () => 'f'.repeat(40), installed })).toBe('ffffffffffffffffffffffffffffffffffffffff');
    writeFileSync(join(base, 'current', 'install.json'), JSON.stringify({ commit: 'abc1234' }));
    expect(evidenceHeadSha(root, { installed })).toBeNull();
    writeFileSync(join(base, 'current', 'install.json'), '{}');
    expect(evidenceHeadSha(root, { installed })).toBeNull();
  });
});

describe('publish to the shared receipt root', () => {
  test('a PR-bound run id is copied (this host) or sent over ssh (another host) · other run ids are not published', () => {
    const src = join(tmp('src'), 'summary.json'); writeFileSync(src, '{"scenarios":[]}\n');
    const root = tmp('root'); const policy = { ...loadSimEvidencePolicy(), publish: { root, host: 'hq-box' } };
    expect(publishSimReceipt(src, '40700-abababababab-s1-X', policy, { onPublishHost: () => true })).toBe(`sim receipt published: ${root}/sim-world/40700-abababababab-s1-X/summary.json`);
    expect(readFileSync(join(root, 'sim-world', '40700-abababababab-s1-X', 'summary.json'), 'utf8')).toBe('{"scenarios":[]}\n');
    const sent: string[] = [];
    expect(publishSimReceipt(src, '40700-abababababab-s1-X', policy, { onPublishHost: () => false, ssh: (h, cmd, input) => { sent.push(`${h}|${cmd}|${input}`); return 0; } }))
      .toBe(`sim receipt published: hq-box:${root}/sim-world/40700-abababababab-s1-X/summary.json`);
    expect(sent).toEqual([`hq-box|mkdir -p '${root}'/sim-world/'40700-abababababab-s1-X' && cat > '${root}'/sim-world/'40700-abababababab-s1-X'/summary.json|{"scenarios":[]}\n`]);
    expect(publishSimReceipt(src, 'seed-1-20261128T100000Z-9', policy, { onPublishHost: () => true })).toBeNull();
  });
  test('the shipped policy publishes to its last reader root, on the HQ host', () => {
    const p = loadSimEvidencePolicy();
    expect(p.publish).toEqual({ root: p.roots[2], host: 'hq' });
    expect(p.roots.length).toBe(3);
  });
  test('«hq» resolves through the facts port · no HQ named → the copy stays local', () => {
    const src = join(tmp('src2'), 'summary.json'); writeFileSync(src, '{}\n');
    const root = tmp('root2'); const policy = { ...loadSimEvidencePolicy(), publish: { root, host: 'hq' } };
    const asked: string[] = [];
    expect(publishSimReceipt(src, '40700-abababababab-s1-X', policy, { hqHost: () => 'hq-host', onPublishHost: h => { asked.push(h); return true; } })).toBe(`sim receipt published: ${root}/sim-world/40700-abababababab-s1-X/summary.json`);
    expect(asked).toEqual(['hq-host']);
    expect(publishSimReceipt(src, '40700-abababababab-s2-X', policy, { hqHost: () => null, onPublishHost: () => false })).toBe(`sim receipt published: ${root}/sim-world/40700-abababababab-s2-X/summary.json`);
  });
});

describe('sim world — supervisors SIM-RECEIPT-CARRY scenes (5 seeds · legacy + graph)', () => {
  const ids = ['JB-SIM-CARRY-MERGE', 'JB-SIM-CARRY-OWN-CHANGED', 'SUP-EXEC-BUTLER-SQUASH-RUN', 'JB-SELF-RUN-SCENE-ROOT'];
  const ctxOf = (id: string, engine: 'legacy' | 'graph', events: Array<{ kind: string; data: unknown }>): SimWorldScenarioContext => ({
    world: 'supervisors', scenarioId: id, seed: 1, engine, universeRoot: tmp(`${id}-${engine}`),
    recorder: { event: (kind: string, data: unknown) => { events.push({ kind, data }); } },
    random: () => 0.5, device: () => { throw new Error('no device'); },
  }) as unknown as SimWorldScenarioContext;
  test('scenes registered', () => { expect(scenes.map(s => s.id)).toEqual(ids); });
  for (const id of ids) for (const engine of ['legacy', 'graph'] as const) {
    test(`${id} · ${engine}`, async () => {
      const events: Array<{ kind: string; data: unknown }> = [];
      expect(await scenes.find(s => s.id === id)!.run(ctxOf(id, engine, events))).toEqual({ ok: true });
      expect(events.filter(e => e.kind === 'sim-carry:scene').length).toBe(1);
      expect(events.filter(e => e.kind.startsWith('sim-carry:') && e.kind !== 'sim-carry:scene').length).toBe(5);
    }, 120_000); // real git repos: 5 seeds × ~15 git calls (one repo · two for the squash scene) — slow on a loaded host
  }
});
