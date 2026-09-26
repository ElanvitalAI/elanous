import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  behaviorSupported,
  defaultIntakeCheckDeps,
  deriveRuler,
  INTAKE_CHECK_MODE,
  intakeCheckReportJson,
  loadIntakeCheckInput,
  renderIntakeCheckReport,
  runIntakeCheck,
  type IntakeCheckDeps,
  type IntakeCheckFact,
  type IntakeCheckRuler,
} from '../src/intake-plane/check.js';
import { handleIntakePost } from '../src/nexus/api/meta-api.js';
import { createIntakeStore } from '../src/intake-plane/store.js';

const ROLE_FACT = '`--role-llm` 으로 역할별 LLM 을 고른다';
const MISSING_FACT = '`zzz-nonexistent-capability-7f3a` 를 지원한다';
const RANDOM_FACT = '`--role-llm` 은 모델을 매 턴 무작위로 고른다';
const hasPrivateRules = existsSync(join(import.meta.dir, '../.rules/README.md'));

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'intake-check-'));
  tempDirs.push(dir);
  return dir;
}

function repoDeps(over: Partial<IntakeCheckDeps> = {}): IntakeCheckDeps {
  const root = join(import.meta.dir, '..');
  return {
    root,
    readFile: (abs) => readFileSync(abs, 'utf8'),
    commit: () => 'test-commit',
    log: () => {},
    ...over,
  };
}

describe('intake check verdicts', () => {
  test('a missing unnamed count is not measured zero; an explicit zero is rendered', () => {
    const report = runIntakeCheck([], repoDeps({ listFiles: () => [] }));
    const withKeptOnly = { ...report, keptClaims: 1 };
    expect(renderIntakeCheckReport(withKeptOnly)).toContain('keptClaims: 1');
    expect(renderIntakeCheckReport(withKeptOnly)).not.toContain('unnamedClaims:');
    expect(intakeCheckReportJson(withKeptOnly)).not.toHaveProperty('unnamedClaims');
    const measuredZero = { ...withKeptOnly, unnamedClaims: 0 };
    expect(renderIntakeCheckReport(measuredZero)).toContain('unnamedClaims: 0');
    expect(intakeCheckReportJson(measuredZero)).toHaveProperty('unnamedClaims', 0);
  });

  test.skipIf(!hasPrivateRules)('private AGENTS role-llm real ruler: entrance description and missing capability', () => {
    const agents = readFileSync(join(import.meta.dir, '../AGENTS.md'), 'utf8');
    expect(agents).toContain('--role-llm <role>=<provider>[/<tier>]      🧑 «부모» 프로세스의 역할 LLM');
    const report = runIntakeCheck(
      [{ text: ROLE_FACT, quote: 'quote-role' }, { text: MISSING_FACT, quote: 'quote-missing' }],
      repoDeps(),
    );
    const present = report.items.find((item) => item.fact === ROLE_FACT);
    const absent = report.items.find((item) => item.fact === MISSING_FACT);
    expect(present?.verdict).toBe('있음');
    const entrance = present?.evidence.find((row) => row.axis === 'surface' && row.summary.includes('--role-llm') && row.contrary !== true);
    expect(entrance?.summary).toContain('역할별 LLM');
    expect(entrance?.summary).not.toContain('무효한 옵션');
    expect(present?.current).not.toContain('무효한 옵션');
    expect(entrance?.path && typeof entrance.line === 'number' && entrance.line > 0).toBe(true);
    const located = entrance?.path && entrance.line
      ? readFileSync(join(import.meta.dir, '..', entrance.path), 'utf8').split('\n')[entrance.line - 1] ?? ''
      : '';
    expect(`${located}\n${entrance?.summary}`).toContain('--role-llm');
    expect(`${located}\n${entrance?.summary}`).toContain('역할별 LLM');
    expect(absent?.verdict).toBe('없음');
    expect(absent?.patterns.some((pattern) => pattern.includes('zzz-nonexistent-capability-7f3a'))).toBe(true);
    expect(report.harnessLaunches).toBe(0);
  });

  test.skipIf(!hasPrivateRules)('private AGENTS role-llm: a comparer that marks both absent fails this case', () => {
    const facts = [{ text: ROLE_FACT }, { text: MISSING_FACT }];
    const real = runIntakeCheck(facts, repoDeps());
    expect(real.items).toHaveLength(2);
    const roleItem = real.items.find((item) => item.fact === ROLE_FACT);
    expect(roleItem?.verdict).toBe('있음');
    expect(roleItem?.current).not.toContain('무효한 옵션');
    expect(roleItem?.evidence.some((row) => row.summary.includes('역할별 LLM') && row.contrary !== true)).toBe(true);
    expect(real.items.find((item) => item.fact === MISSING_FACT)?.verdict).toBe('없음');

    const alwaysAbsent: IntakeCheckDeps = {
      ...repoDeps(),
      comparer: () => ({
        verdict: '없음',
        current: 'forced absent',
        evidence: [],
        patterns: ['forced-absent'],
        failures: [],
      }),
    };
    const report = runIntakeCheck(facts, alwaysAbsent);
    expect(report.items).toHaveLength(2);
    expect(report.items.every((item) => item.verdict === '없음')).toBe(true);
    const role = report.items.find((item) => item.fact === ROLE_FACT);
    expect(role?.verdict).not.toBe('있음');
  });

  test('a failed search is 못 쟀다 and carries the failure, never 없음', () => {
    const report = runIntakeCheck(
      [{ text: '`probe-failure` 를 지원한다' }],
      {
        ...repoDeps(),
        listFiles: () => { throw new Error('probe exploded'); },
      },
    );
    const item = report.items[0];
    expect(item?.verdict).toBe('못 쟀다');
    expect(item?.failures.join(' ')).toContain('probe exploded');
    expect(item?.verdict).not.toBe('없음');
  });

  test('a copied resources.yaml row appears on the capability axis without a code change', () => {
    const root = tempDir();
    mkdirSync(join(root, 'catalog'), { recursive: true });
    const source = readFileSync(join(import.meta.dir, '..', 'catalog/resources.yaml'), 'utf8');
    writeFileSync(join(root, 'catalog/resources.yaml'), `${source}\n  - id: probe-only\n    required_for: [probe-capability-x]\n`);
    writeFileSync(join(root, 'catalog/external-commands.yaml'), 'commands: []\n');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/index.ts'), '');
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs/FAQ.md'), '# faq\n');
    writeFileSync(join(root, 'docs/PRFAQ-elanous-docs-working-backwards-2026-09-22.md'), '# pr\n');
    const ruler = deriveRuler({
      root,
      readFile: (abs) => readFileSync(abs, 'utf8'),
    });
    const hit = ruler.capabilities.find((row) => row.id === 'probe-capability-x');
    expect(hit?.source).toBe('catalog/resources.yaml');
  });

  test('a gap writes a real goal draft whose first line is 대상 경로: and never launches harness', () => {
    const root = tempDir();
    mkdirSync(join(root, 'src/cli'), { recursive: true });
    const draftDir = join(root, 'docs', 'goals', 'intake-check');
    let launches = 0;
    const launchHarness = (_goalPath: string): void => { launches += 1; };
    const report = runIntakeCheck(
      [{ text: MISSING_FACT, quote: '원문' }],
      {
        root,
        readFile: () => '',
        listFiles: () => [],
        commit: () => 'abc',
        draftDir,
        launchHarness,
        log: () => {},
      },
    );
    expect(typeof launchHarness).toBe('function');
    expect(launches).toBe(0);
    expect(report.harnessLaunches).toBe(0);
    const draft = report.goalDraftPaths[0];
    expect(draft && draft.startsWith(root)).toBe(true);
    expect(draft).toContain('docs/goals/intake-check/GOAL-intake-check-');
    expect(draft?.endsWith('.md')).toBe(true);
    const body = readFileSync(draft!, 'utf8');
    expect(body.split('\n')[0]).toBe('대상 경로:');
    expect(body).toContain(MISSING_FACT);
    expect(report.items[0]?.verdict).toBe('없음');
  });

  test.skipIf(!hasPrivateRules)('private AGENTS role-llm: 판단 필요 is a design question, not a gap — no goal draft is written', () => {
    const report = runIntakeCheck([{ text: RANDOM_FACT }], repoDeps());
    expect(report.items[0]?.verdict).toBe('판단 필요');
    expect(report.goalDraftPaths).toEqual([]);
    expect(report.items[0]?.goalDraftPath).toBeUndefined();
  });

  test('repeated --fact inputs all survive into the fact list', () => {
    const loaded = loadIntakeCheckInput({ facts: [ROLE_FACT, MISSING_FACT], root: process.cwd() });
    expect(loaded.facts.map((fact) => fact.text)).toEqual([ROLE_FACT, MISSING_FACT]);
  });

  test.skipIf(!hasPrivateRules)('private AGENTS role-llm: a name whose claimed behavior differs is 판단 필요, not 있음', () => {
    const report = runIntakeCheck([{ text: RANDOM_FACT }], repoDeps());
    expect(report.items[0]?.verdict).toBe('판단 필요');
    expect(behaviorSupported(RANDOM_FACT, '--role-llm 역할별 LLM 을 고른다')).toBe(false);
    const rejected = [
      ".option('--role-llm <role=provider[/tier]>', '이 경로에 무효한 옵션')",
    ].join('\n');
    const refused = runIntakeCheck([{ text: ROLE_FACT }], {
      ...repoDeps(),
      readFile: (abs) => abs.endsWith('src/index.ts') ? rejected : '',
      listFiles: () => ['src/index.ts'],
    });
    expect(refused.items[0]?.verdict).not.toBe('있음');
    expect(behaviorSupported(ROLE_FACT, '--role-llm provider tier')).toBe(false);
  });

  test('the same fact with two quotes is stored once and keeps both quotes', () => {
    const facts: IntakeCheckFact[] = [
      { text: MISSING_FACT, quote: '인용-가' },
      { text: MISSING_FACT, quote: '인용-나' },
    ];
    const report = runIntakeCheck(facts, {
      ...repoDeps(),
      listFiles: () => [],
      readFile: () => '',
    });
    expect(report.items).toHaveLength(1);
    expect(report.items[0]?.quotes).toEqual(['인용-가', '인용-나']);
  });

  test('start, per-item, and end events carry tree and commit', () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    runIntakeCheck([{ text: MISSING_FACT }], {
      ...repoDeps(),
      listFiles: () => [],
      readFile: () => '',
      commit: () => 'deadbeef',
      log: (event, data) => { events.push({ event, data }); },
    });
    expect(events.map((row) => row.event)).toEqual(['start', 'item', 'end']);
    const end = events.find((row) => row.event === 'end');
    expect(typeof end?.data.tree).toBe('string');
    expect(end?.data.commit).toBe('deadbeef');
    expect(events.find((row) => row.event === 'item')?.data.verdict).toBeDefined();
  });

  test('POST /v1/intake mode=check returns fact, current, verdict, evidence like the CLI', async () => {
    const store = createIntakeStore({ archiveDir: null });
    const req = new Request('http://127.0.0.1/v1/intake', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: MISSING_FACT,
        mode: 'check',
        facts: [{ text: MISSING_FACT, quote: 'http-quote' }],
      }),
    });
    const res = await handleIntakePost(req, { intakeStore: store, noAuth: true });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      check?: { mode: string; items: Array<{ fact: string; current: string; verdict: string; evidence: unknown[] }> };
    };
    expect(body.check?.mode).toBe(INTAKE_CHECK_MODE);
    const item = body.check?.items[0];
    expect(item?.fact).toBe(MISSING_FACT);
    expect(typeof item?.current).toBe('string');
    expect(typeof item?.verdict).toBe('string');
    expect(Array.isArray(item?.evidence)).toBe(true);
    expect(store.listSessions()).toHaveLength(0);
  });
});

describe('production check deps', () => {
  test('defaultIntakeCheckDeps passes recall and a launchHarness that check never calls', () => {
    let recalls = 0;
    let launches = 0;
    const deps = defaultIntakeCheckDeps(join(import.meta.dir, '..'), {
      recall: () => { recalls += 1; return ['memory-row']; },
      launchHarness: () => { launches += 1; },
      commit: () => 'sha',
      log: () => {},
      listFiles: () => [],
      readFile: () => '',
      draftDir: tempDir(),
    });
    expect(typeof deps.recall).toBe('function');
    expect(typeof deps.launchHarness).toBe('function');
    const report = runIntakeCheck([{ text: MISSING_FACT, quote: 'q' }], deps);
    expect(recalls).toBe(1);
    expect(launches).toBe(0);
    expect(report.items[0]?.evidence.some((row) => row.axis === 'memory' && row.recall === true)).toBe(true);
  });
});

describe('ruler shape', () => {
  test('deriveRuler reads capability ids from required_for', () => {
    const ruler: IntakeCheckRuler = deriveRuler(repoDeps());
    expect(ruler.capabilities.length).toBeGreaterThan(0);
    expect(ruler.capabilities.every((row) => row.source.length > 0)).toBe(true);
  });
});

describe('intake check — promise axis (🅢 review on #20059)', () => {
  // 약속에만 나오는 토큰 — 저장소 탐색이 이 시험 파일 자신을 잡지 않도록 실행 때 조립한다.
  const PROMISE_ONLY = ['qqq', 'promise', 'only', '4b2c'].join('-');
  const PRFAQ = [
    '# PR/FAQ',
    '## §0 이 문서가 재서 말하는 것',
    `§0 서사 줄 — ${PROMISE_ONLY} 가 여기 있으면 약속이 아니다`,
    '## §1 워킹 백워드가 드러낸 것',
    '§1 서사 줄 — 측정 이야기일 뿐 약속이 아니다',
    '## §4 보도자료 (아직 사실이 아닌 칸은 ⬜)',
    '⬜ 사용자는 한 줄로 설치한다',
    '### 하위 제목도 §4 안이다',
    '⬜ 하위 제목 아래 약속 줄도 §4 다',
    '## §5 FAQ (실측된 것만)',
    '실측 FAQ 한 줄 — 키가 없어도 doctor 가 rc=0 으로 끝난다',
  ].join('\n');
  const FAQ = `# FAQ\n문서만 약속한다 — ${PROMISE_ONLY} 를 지원한다고 적었다\n`;
  const fixtureDeps = () => repoDeps({
    readFile: (abs: string) => abs.endsWith('PRFAQ-elanous-docs-working-backwards-2026-09-22.md')
      ? PRFAQ
      : abs.endsWith('docs/FAQ.md')
        ? FAQ
        : readFileSync(abs, 'utf8'),
  });

  test('PRFAQ contributes only §4 and §5 lines — §0·§1 narrative is not a promise', () => {
    const ruler = deriveRuler(fixtureDeps());
    const prfaq = ruler.promises.filter((row) => row.source.includes('PRFAQ')).map((row) => row.text);
    expect(prfaq).toContain('⬜ 사용자는 한 줄로 설치한다');
    expect(prfaq).toContain('⬜ 하위 제목 아래 약속 줄도 §4 다');
    expect(prfaq).toContain('실측 FAQ 한 줄 — 키가 없어도 doctor 가 rc=0 으로 끝난다');
    expect(prfaq.some((text) => text.startsWith('§0') || text.startsWith('§1'))).toBe(false);
  });

  test('a promise alone is a claim, not evidence — 판단 필요 with 「문서만 있다」', () => {
    const report = runIntakeCheck([{ text: `\`${PROMISE_ONLY}\` 를 지원한다` }], fixtureDeps());
    expect(report.items[0]?.verdict).toBe('판단 필요');
    expect(report.items[0]?.current).toContain('문서만 있다');
    expect(report.items[0]?.evidence.some((row) => row.axis === 'promise')).toBe(true);
    expect(report.goalDraftPaths).toEqual([]);
  });
});
