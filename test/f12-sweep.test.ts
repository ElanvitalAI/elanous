import { setDefaultTimeout, afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { formatF12Report, sweepF12 } from '../scripts/f12-sweep.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'f12-sweep-'));
  roots.push(root);
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true }, include: ['src/**/*.ts', 'test/**/*.ts', 'scripts/**/*.ts', 'apps/pwa/src/**/*.ts'] }));
  for (const [file, content] of Object.entries(files)) {
    const target = join(root, file);
    mkdirSync(resolve(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

const registry = [
  'import { findNativeTool } from "../native-tool-catalog.js";',
  'const registry = new Map<string, unknown>();',
  'export function registerToolRuntime(value: { id: string }): void { registry.set(value.id, value); }',
  'export function getToolRuntime(nameOrAlias: string): unknown { const entry = findNativeTool(nameOrAlias); return entry ? registry.get(entry.id) : undefined; }',
].join('\n');

const catalog = [
  'export function findNativeTool(nameOrAlias: string): { id: string } | undefined {',
  '  return [{ id: "canonical-runtime", aliases: ["alias-runtime"] }, { id: "canonical-only" }].find((entry) => entry.id === nameOrAlias || entry.aliases?.includes(nameOrAlias));',
  '}',
].join('\n');

function runtimeFixture(registrySource = registry): Record<string, string> {
  return {
    'src/tool-runtime/registry.ts': registrySource,
    'src/native-tool-catalog.ts': catalog,
    'src/exports.ts': [
      'export const registeredOnly = { id: "registered-only" };',
      'export const aliasRuntime = { id: "canonical-runtime" };',
      'export const canonicalRuntime = { id: "canonical-only" };',
      'export enum OrphanEnum { One }',
      'export function orphanFunction() {}',
    ].join('\n'),
    'src/register.ts': 'import { registerToolRuntime } from "./tool-runtime/registry.js"; import { registeredOnly, aliasRuntime, canonicalRuntime } from "./exports.js"; registerToolRuntime(registeredOnly); registerToolRuntime(aliasRuntime); registerToolRuntime(canonicalRuntime);',
    'src/consumer.ts': 'import { getToolRuntime } from "./tool-runtime/registry.js"; getToolRuntime("alias-runtime"); getToolRuntime("canonical-only");',
  };
}

// Only the nightly audit runs the whole-repository sweep; gate cases use small fixed trees.
const nightly = process.env.ELANOUS_NIGHTLY_AUDIT === '1' ? it : it.skip;
let realSweep: ReturnType<typeof sweepF12> | undefined;
function realRepositorySweep(): ReturnType<typeof sweepF12> {
  realSweep ??= sweepF12(resolve(import.meta.dir, '..'));
  return realSweep;
}

describe('f12 sweep', () => {
  it('classifies only registry runtime IDs reached through dynamic lookup, including aliases and canonical IDs without aliases', async () => {
    const report = await sweepF12(fixture(runtimeFixture()));
    expect(report.bucketD.map((item) => item.name).sort()).toEqual(['aliasRuntime', 'canonicalRuntime']);
    expect(report.bucketD.map((item) => item.name)).not.toContain('registeredOnly');
    expect(report.bucketA.map((item) => item.name).sort()).toEqual(['OrphanEnum', 'orphanFunction']);
    expect(report.bucketA.find((item) => item.name === 'OrphanEnum')?.kind).toBe('enum');
    expect(report.filesScanned).toBeGreaterThan(0);
    expect(report.exportsScanned).toBeGreaterThan(0);
    expect(report.referencedElsewhere + report.referencedOnlyFromTests + report.unreferencedTypeOnly.length + report.bucketA.length + report.bucketD.length).toBe(report.exportsScanned);
    const aKeys = new Set(report.bucketA.map((s) => `${s.file}#${s.name}`));
    expect(report.bucketD.filter((s) => aKeys.has(`${s.file}#${s.name}`))).toEqual([]);
    expect(report.unreferencedTypeOnly.every((s) => s.kind === 'interface' || s.kind === 'type')).toBe(true);
    expect(report.bucketA.every((s) => s.kind !== 'interface' && s.kind !== 'type')).toBe(true);
    expect(report.elapsedSeconds).toBeGreaterThanOrEqual(0);
  });

  it('does not mistake unrelated findNativeTool and registry.get calls for alias resolution', async () => {
    const unrelatedRegistry = [
      'import { findNativeTool } from "../native-tool-catalog.js";',
      'const registry = new Map<string, unknown>();',
      'export function registerToolRuntime(value: { id: string }): void { registry.set(value.id, value); }',
      'export function getToolRuntime(nameOrAlias: string): unknown { findNativeTool("unrelated"); const entry = { id: "unrelated" }; return registry.get(entry.id); }',
    ].join('\n');
    const report = await sweepF12(fixture(runtimeFixture(unrelatedRegistry)));
    expect(report.bucketD).toHaveLength(0);
    expect(report.bucketA.map((item) => item.name).sort()).toEqual(['OrphanEnum', 'orphanFunction']);
  });

  it('keeps all expected bucket b scopes measured in a small fixture', async () => {
    const report = await sweepF12(fixture({
      'src/constant.ts': 'export const DELIMITER = "__";',
      'scripts/copy.ts': 'export const copy = "__";',
      'test/copy.test.ts': 'export const copy = "__";',
      'apps/pwa/src/copy.ts': 'export const copy = "__";',
    }));
    expect(report.bucketB.scanRoots).toEqual(['src', 'scripts', 'test', 'apps/pwa/src']);
    expect(report.bucketB.unavailableScopes).toEqual([]);
    expect(report.bucketB.filesScanned).toBeGreaterThan(report.filesScanned);
    expect(report.bucketB.literalsScanned).toBeGreaterThan(0);
    expect(report.bucketB.constantsScanned).toBeGreaterThan(0);
    expect(report.bucketB.sites.every((site) => site.constFile !== site.file)).toBe(true);
  });

  it('prints the denominator first, reports enum counts, explicit B/C boundaries, and elapsed seconds last', async () => {
    const lines = formatF12Report(await sweepF12(fixture({ 'src/one.ts': 'export enum OrphanEnum { One }' })));
    expect(lines[0]).toMatch(/^\[f12-sweep\] denominator: named exports=1; files=1; ruler=/);
    expect(lines.find((line) => line.includes('bucket a'))).toContain('enum=1');
    expect(lines.find((line) => line.includes('bucket b bypassed constant candidates'))).toMatch(/bypassed constant candidates: \d+; ruler=.+; denominator=string literals \d+ in files \d+ against exported string const values \d+; scope=.+; unmeasured scopes=/);
    expect(lines.find((line) => line.includes('bucket b scarcest'))).toContain('ordered by how few distinct files carry them');
    expect(lines.find((line) => line.includes('bucket b remaining'))).toContain('not-measured');
    expect(lines.find((line) => line.includes('bucket c'))).toContain('not-measured');
    expect(lines.at(-1)).toMatch(/^\[f12-sweep\] elapsed: \d+\.\d{2}s$/);
  });

  it('accepts a root argument and emits a root-aware compiler failure after the denominator', () => {
    const root = fixture({ 'src/one.ts': 'export const orphan = 1;' });
    const run = Bun.spawnSync(['bun', 'run', resolve(import.meta.dir, '../scripts/f12-sweep.ts'), root], { stdout: 'pipe', stderr: 'pipe' });
    const output = new TextDecoder().decode(run.stdout).trim().split('\n');
    expect(run.exitCode).toBe(0);
    expect(output[0]).toContain(`root=${root}`);
    expect(output[0]).toContain('denominator: named exports=1; files=1');
    expect(output.at(-1)).toMatch(/^\[f12-sweep\] elapsed: \d+\.\d{2}s$/);

    const isolated = mkdtempSync(join(tmpdir(), 'f12-sweep-no-compiler-'));
    roots.push(isolated);
    const script = join(isolated, 'f12-sweep.ts');
    writeFileSync(script, readFileSync(resolve(import.meta.dir, '../scripts/f12-sweep.ts'), 'utf8'));
    const missing = Bun.spawnSync(['bun', 'run', script, isolated], { stdout: 'pipe', stderr: 'pipe' });
    const missingOutput = new TextDecoder().decode(missing.stdout).trim().split('\n');
    expect(missing.exitCode).toBe(1);
    expect(missingOutput).toHaveLength(2);
    expect(missingOutput[0]).toContain(`denominator: unavailable; root=${isolated}`);
    expect(missingOutput[1]).toContain(`cannot measure root=${isolated}; reason=TypeScript compiler dependency was not found; searched`);
    expect(new TextDecoder().decode(missing.stderr)).toBe('');
  });

  it('names a site that copies an exported string constant, and says whether the import was already available there', async () => {
    const report = await sweepF12(fixture({
      'src/wire.ts': 'export const DELIMITER = "__";\nexport function encode(name: string): string { return name.replaceAll(".", DELIMITER); }',
      'src/reader-with-import.ts': 'import { encode } from "./wire.js";\nexport function serverOf(name: string): string { encode(name); const at = name.indexOf("__"); return at > 0 ? name.slice(0, at) : ""; }',
      'src/reader-without-import.ts': 'export function split(name: string): string[] { return name.split("__"); }',
      'src/honest.ts': 'import { DELIMITER } from "./wire.js";\nexport function honestSplit(name: string): string[] { return name.split(DELIMITER); }',
    }));

    const delimiterSites = report.bucketB.sites.filter((site) => site.value === '__');
    expect(delimiterSites.map((site) => site.file).sort()).toEqual(['src/reader-with-import.ts', 'src/reader-without-import.ts']);
    expect(delimiterSites.every((site) => site.constName === 'DELIMITER' && site.constFile === 'src/wire.ts')).toBe(true);
    // ⭐ 두 자리는 «같은 결함»이 아니다 — 한쪽은 그 모듈을 이미 import 하고 있어서 «막은 것이 없었다».
    expect(delimiterSites.find((site) => site.file === 'src/reader-with-import.ts')?.declaringModuleImported).toBe(true);
    expect(delimiterSites.find((site) => site.file === 'src/reader-without-import.ts')?.declaringModuleImported).toBe(false);
    // ⛔ 선언한 자리와 «정직하게 import 한» 자리는 결함이 아니다.
    expect(report.bucketB.sites.map((site) => site.file)).not.toContain('src/wire.ts');
    expect(report.bucketB.sites.map((site) => site.file)).not.toContain('src/honest.ts');
    expect(report.bucketB.literalsScanned).toBeGreaterThan(0);
    expect(report.bucketB.constantsScanned).toBeGreaterThan(0);
  }, 60_000);

  it('does not count module specifiers, and marks a test-file copy as binding only its own side', async () => {
    const report = await sweepF12(fixture({
      'src/paths.ts': 'export const WIRE_MODULE = "./wire.js";\nexport const DELIMITER = "__";',
      'src/wire.ts': 'export const encoded = "x";',
      'src/importer.ts': 'import { encoded } from "./wire.js";\nexport const echoed = encoded;',
      'test/copy.test.ts': 'export const copied = "__";',
    }));

    // ⛔ `./wire.js` 는 import 경로다 — 상수를 «베낀» 것이 아니다.
    expect(report.bucketB.sites.filter((site) => site.value === './wire.js')).toEqual([]);
    const copied = report.bucketB.sites.filter((site) => site.value === '__');
    expect(copied.map((site) => site.file)).toEqual(['test/copy.test.ts']);
    expect(copied[0]?.inTest).toBe(true);
  }, 60_000);

  it('marks a scarcest value as [test-only] when every bypassing site is a test, and leaves production copies unmarked', async () => {
    // 📏 2026-08-22 (17th `[F]`): a human judged the five scarcest values and **four were
    //   deliberate test fixtures**. The sweep already knew (`site.inTest`) but did not say it
    //   where the human reads. ⇒ this marks it in the scarcest line.
    //   ⛔ It is a hint, never a verdict — a test copy can still be real drift.
    const report = await sweepF12(fixture({
      'src/consts.ts': 'export const ONLY_IN_TEST = "fixture-only-value";\nexport const ALSO_IN_PROD = "prod-copied-value";',
      'test/a.test.ts': 'export const a = "fixture-only-value";\nexport const b = "prod-copied-value";',
      'src/user.ts': 'export const c = "prod-copied-value";',
    }));
    const line = formatF12Report(report).find((l) => l.includes('bucket b scarcest'))!;

    expect(line).toContain('"fixture-only-value" in 1 files [test-only]');
    // ⛔ 프로덕션 자리가 «하나라도» 있으면 표시하지 않는다 — 그것이 이 표시의 전부다.
    expect(line).toContain('"prod-copied-value" in 2 files');
    expect(line).not.toContain('"prod-copied-value" in 2 files [test-only]');
    // ⭐ 그리고 그 뜻을 «줄이 스스로» 말한다(자를 읽는 사람이 뜻을 추측하지 않도록).
    expect(line).toContain('[test-only]=every bypassing site is in a test file');
  }, 60_000);

  nightly('measures bucket b over apps/pwa on the real repository, and never folds an unreadable scope into zero', async () => {
    const report = await realRepositorySweep();

    // ⭐ 이 자가 14차에 결함 열둘이 살던 표면을 «본다» — 안 보면 그 축의 「0」은 거짓이다.
    expect(report.bucketB.scanRoots).toContain('apps/pwa/src');
    expect(report.bucketB.unavailableScopes).not.toContain('apps/pwa/src');
    // ⭐⭐ 「측정 불가」는 「없다」가 아니다 — 기대 스코프는 잰 것과 못 잰 것으로 «전부» 갈리고, 못 잰 것은 이름으로 남는다.
    expect([...report.bucketB.scanRoots, ...report.bucketB.unavailableScopes].sort()).toEqual(['apps/pwa/src', 'scripts', 'src', 'test']);
    // ⭐ 퇴화 검사: 분모가 0이면 이 자는 아무것도 재고 있지 않다.
    expect(report.bucketB.literalsScanned).toBeGreaterThan(1_000);
    expect(report.bucketB.constantsScanned).toBeGreaterThan(10);
    expect(report.bucketB.filesScanned).toBeGreaterThan(report.filesScanned);
    // ⭐ 「측정 불가」와 「없다」를 다른 값으로 — 못 읽은 스코프는 이름으로 남는다.
    expect(report.bucketB.sites.every((site) => site.constFile !== site.file)).toBe(true);
  }, 180_000);

  nightly('partitions the denominator across every bucket on the real repository, without freezing drifting counts', async () => {
    const report = await realRepositorySweep();

    // ⭐ 분모는 «존재»해야 한다 — 퇴화(0)면 이 자는 아무것도 재고 있지 않다.
    expect(report.filesScanned).toBeGreaterThan(100);
    expect(report.exportsScanned).toBeGreaterThan(1_000);

    // ⭐⭐ 진짜 계약: 다섯 버킷이 분모를 «정확히 분할»한다.
    //    ⛔ 언 수(3711/21458/…)를 고정하면 무관한 export 하나에도 깨져 공용 게이트를 막는다.
    //       분할은 «분류 결함»을 잡으면서 저장소 표류를 견딘다.
    const partition =
      report.referencedElsewhere +
      report.referencedOnlyFromTests +
      report.unreferencedTypeOnly.length +
      report.bucketA.length +
      report.bucketD.length;
    expect(partition).toBe(report.exportsScanned);

    // ⭐ bucket d 는 «자의 사각»이지 결함이 아니다 — bucket a 와 겹치면 없는 결함을 만든다.
    const keyOf = (s: { file: string; name: string }) => `${s.file}#${s.name}`;
    const aKeys = new Set(report.bucketA.map(keyOf));
    expect(report.bucketD.filter((s) => aKeys.has(keyOf(s)))).toEqual([]);

    // ⭐ 종류 계약: 타입 전용은 interface|type 만, bucket a 는 값 export 만.
    expect(report.unreferencedTypeOnly.every((s) => s.kind === 'interface' || s.kind === 'type')).toBe(true);
    expect(report.bucketA.every((s) => s.kind !== 'interface' && s.kind !== 'type')).toBe(true);

    expect(report.elapsedSeconds).toBeGreaterThanOrEqual(0);
  }, 120_000);
});
