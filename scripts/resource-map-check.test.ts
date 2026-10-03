import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { checkResourceMap, credentialIdsWithEmptyFreeFallback, runResourceMapCheckCli } from './resource-map-check.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const scriptPath = join(import.meta.dir, 'resource-map-check.ts');

function runEntrypoint(root: string): { exitCode: number; output: string } {
  const child = Bun.spawnSync([process.execPath, scriptPath], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  return { exitCode: child.exitCode, output: new TextDecoder().decode(child.stdout) };
}

function fixture(source: string, resourceMap = 'resources: []\n', sourceFile = 'reads.ts'): string {
  const root = mkdtempSync(join(tmpdir(), 'resource-map-check-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'catalog'), { recursive: true });
  writeFileSync(join(root, 'src', sourceFile), source);
  writeFileSync(join(root, 'catalog', 'resources.yaml'), resourceMap);
  return root;
}

function runCli(root: string, resourceMapPath?: string): { output: string[]; exits: number[] } {
  const output: string[] = [];
  const exits: number[] = [];
  runResourceMapCheckCli({ root, resourceMapPath, write: (text) => output.push(text), setExitCode: (code) => exits.push(code) });
  return { output, exits };
}

describe('resource-map-check', () => {
  test('groups fallback aliases, reads all resource env names, and explains exclusions', () => {
    const root = fixture(
      'const z = process.env.ZHIPU_API_KEY || process.env.GLM_API_KEY || process.env.BIGMODEL_API_KEY;\nconst t = process.env.TAVILY_API_KEY;\nconst c = process.env.ELANOUS_KEY_CACHE_DIR;',
      'resources:\n  - env: [ZHIPU_API_KEY, GLM_API_KEY]\n  - env: [BIGMODEL_API_KEY, TAVILY_API_KEY]\n',
    );
    try {
      const result = checkResourceMap({ root });
      expect(result.covered).toEqual([
        { id: 'TAVILY_API_KEY', envNames: ['TAVILY_API_KEY'] },
        { id: 'ZHIPU_API_KEY', envNames: ['ZHIPU_API_KEY', 'GLM_API_KEY', 'BIGMODEL_API_KEY'] },
      ]);
      expect(result.uncovered).toEqual([]);
      expect(result.excluded).toEqual([{ envName: 'ELANOUS_KEY_CACHE_DIR', reason: expect.any(String) }]);
      expect(result.unreadable).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('reports unregistered credentials and exits 1 when the resource map is readable', () => {
    const root = fixture('const key = process.env.TAVILY_API_KEY;');
    try {
      const { output, exits } = runCli(root);
      expect(JSON.parse(output[0]!)).toMatchObject({
        credentials: [{ id: 'TAVILY_API_KEY' }],
        covered: [],
        uncovered: [{ id: 'TAVILY_API_KEY' }],
        excluded: [],
        unreadable: [],
      });
      expect(exits).toEqual([1]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('does not report uncovered credentials when the resource map is missing or malformed', () => {
    const root = fixture('const key = process.env.TAVILY_API_KEY;');
    const missingResourceMapPath = join(root, 'catalog', 'missing-resources.yaml');
    const malformedResourceMapPath = join(root, 'catalog', 'malformed-resources.yaml');
    writeFileSync(malformedResourceMapPath, 'resources: [');
    try {
      for (const resourceMapPath of [missingResourceMapPath, malformedResourceMapPath]) {
        const result = checkResourceMap({ root, resourceMapPath });
        expect(result.uncovered).toEqual([]);
        expect(result.unreadable).toEqual([{ path: resourceMapPath, reason: expect.any(String) }]);
        expect(result.unreadable[0]!.reason).not.toBe('');
        expect(runCli(root, resourceMapPath).exits).toEqual([1]);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('uses the repository resource map by default without falsely reporting registered names', () => {
    const registeredNames = ['ELEVENLABS_API_KEY', 'FIRECRAWL_API_KEY', 'GITHUB_TOKEN', 'SUPADATA_API_KEY'];
    const result = checkResourceMap({});
    expect(result.unreadable).toEqual([]);
    const uncoveredNames = result.uncovered.flatMap(({ envNames }) => envNames);
    expect(uncoveredNames).not.toEqual(expect.arrayContaining(registeredNames));
    for (const registeredName of registeredNames) expect(uncoveredNames).not.toContain(registeredName);
  }, 60_000);

  test('no-argument repository CLI never reports a registered name as uncovered, and its exit code follows its own findings', () => {
    const registeredNames = ['ELEVENLABS_API_KEY', 'FIRECRAWL_API_KEY', 'GITHUB_TOKEN', 'SUPADATA_API_KEY'];
    const result = runEntrypoint(process.cwd());
    const output = JSON.parse(result.output);
    const uncoveredNames = (output.uncovered as Array<{ envNames: string[] }>).flatMap(({ envNames }) => envNames);
    expect(output.unreadable).toEqual([]);
    // ⛔⭐ 저장소의 «미등록 집합»을 — 전체든 «한 멤버든» — 고정하지 않는다.
    //    📏 이 시험은 2026-09 에 ***세 번*** 깨졌고 세 번 다 원인이 같다:
    //      ⑴ 집합 전체를 고정 → TYPESAFE_API_KEY 가 늘며 깨짐(09-21)
    //      ⑵ 그래서 한 멤버(TG_TOKEN)만 고정 → ***그 구멍을 닫자 깨짐***(09-23)
    //      ⑶ exitCode 를 1 로 고정 → uncovered 가 0이 되자 깨짐(09-23)
    //    🔑 셋 다 「자가 «저장소의 현재 내용»을 박은 것」이다. 구멍을 닫는 것이 «의도된 작업»인데
    //      그 작업이 자를 빨갛게 만들면, 자는 개선을 «벌»한다.
    //    ⇒ 남는 계약은 «성질» 둘이다: 등록된 이름을 고발하지 않는다 · 종료 코드가 자기 산출과 일치한다.
    for (const registeredName of registeredNames) expect(uncoveredNames).not.toContain(registeredName);
    const shouldFail = output.uncovered.length > 0 || output.unreadable.length > 0;
    expect(result.exitCode).toBe(shouldFail ? 1 : 0);
  }, 30_000);

  test('reports malformed default resource maps through the no-argument entrypoint without false uncovered findings', () => {
    const root = fixture('const key = process.env.TAVILY_API_KEY;', 'resources: [');
    const resourceMapPath = realpathSync(join(root, 'catalog', 'resources.yaml'));
    try {
      const result = runEntrypoint(root);
      const output = JSON.parse(result.output);
      expect(result.exitCode).toBe(1);
      expect(output.uncovered).toEqual([]);
      expect(output.unreadable).toEqual([{ path: resourceMapPath, reason: expect.any(String) }]);
      expect(output.unreadable[0].reason).not.toBe('');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('reports names absent from a readable map even when comments describe their use', () => {
    const root = fixture('const token = process.env.TG_TOKEN || process.env.UNKNOWN_API_KEY;', '# TG_TOKEN read only by scripts/dogfood.ts.\nresources: []\n');
    try {
      const result = checkResourceMap({ root });
      expect(result.uncovered).toEqual([{ id: 'TG_TOKEN', envNames: ['TG_TOKEN', 'UNKNOWN_API_KEY'] }]);
      expect(result.excluded).toEqual([]);
      expect(runCli(root).exits).toEqual([1]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('reports unregistered credentials in dogfood files', () => {
    const root = fixture('const token = process.env.TG_TOKEN;', 'resources: []\n', 'telegram-dogfood.ts');
    try {
      const result = checkResourceMap({ root });
      expect(result.credentials).toEqual([{ id: 'TG_TOKEN', envNames: ['TG_TOKEN'] }]);
      expect(result.uncovered).toEqual([{ id: 'TG_TOKEN', envNames: ['TG_TOKEN'] }]);
      expect(runCli(root).exits).toEqual([1]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('exits 0 when every credential is resource-map-covered', () => {
    const root = fixture('const key = process.env.TAVILY_API_KEY;', 'resources:\n  - env: [TAVILY_API_KEY]\n');
    try { expect(runCli(root).exits).toEqual([0]); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('runs the import.meta.main entrypoint with classified findings and failure status for uncovered credentials', () => {
    const root = fixture('const key = process.env.TAVILY_API_KEY;');
    try {
      const result = runEntrypoint(root);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.output)).toMatchObject({
        credentials: [{ id: 'TAVILY_API_KEY' }],
        covered: [],
        uncovered: [{ id: 'TAVILY_API_KEY' }],
        excluded: [],
        unreadable: [],
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('runs the import.meta.main entrypoint with success status when every credential is covered', () => {
    const root = fixture('const key = process.env.TAVILY_API_KEY;', 'resources:\n  - env: [TAVILY_API_KEY]\n');
    try {
      const result = runEntrypoint(root);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.output)).toMatchObject({ covered: [{ id: 'TAVILY_API_KEY' }], uncovered: [], unreadable: [] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('runs the import.meta.main entrypoint with success status when no credentials are measurable', () => {
    const root = fixture('export const value = 1;');
    try {
      const result = runEntrypoint(root);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.output)).toMatchObject({ credentials: [], covered: [], uncovered: [], excluded: [], unreadable: [] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('preserves direct, element, fallback, and unscannable process syntax classification', () => {
    const root = fixture(
      "const a = process.env.DIRECT_API_KEY; const b = process.env['SINGLE_TOKEN']; const c = process.env[\"DOUBLE_SECRET\"]; const d = Bun.env.BUN_API_KEY; const e = process.env.FIRST_API_KEY ?? process.env.SECOND_API_KEY; const dynamic = process.env[name];",
      'resources:\n  - env: [DIRECT_API_KEY, SINGLE_TOKEN, DOUBLE_SECRET, BUN_API_KEY, FIRST_API_KEY, SECOND_API_KEY]\n',
    );
    try {
      const result = checkResourceMap({ root });
      expect(result.covered.flatMap(({ envNames }) => envNames).sort()).toEqual(['BUN_API_KEY', 'DIRECT_API_KEY', 'DOUBLE_SECRET', 'FIRST_API_KEY', 'SECOND_API_KEY', 'SINGLE_TOKEN']);
      expect(result.credentials.flatMap(({ envNames }) => envNames)).toEqual(['BUN_API_KEY', 'DIRECT_API_KEY', 'DOUBLE_SECRET', 'FIRST_API_KEY', 'SECOND_API_KEY', 'SINGLE_TOKEN']);
      expect(result.credentials.flatMap(({ envNames }) => envNames)).not.toContain('name');
      expect(result.uncovered).toEqual([]);
      expect(result.excluded).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('classifies injected environment reads, non-environment objects, and unproven env accesses', () => {
    const root = fixture(
      "const moduleEnv = process.env; const moduleAlias = moduleEnv; function aws(env = process.env) { { const env = { UNIQUE_NON_ENV_SECRET: 'x' }; env.UNIQUE_NON_ENV_SECRET; } for (const env of [{}]) env.LOOP_NON_ENV_SECRET; return env.AWS_SECRET_ACCESS_KEY; } const grok = (env: Record<string, string | undefined> = process.env) => env['GROK_CODE_XAI_API_KEY']; const discord = (opts: { env?: Record<string, string | undefined> }) => { const env = opts.env ?? process.env; return [env.ELANOUS_DISCORD_BOT_TOKEN, env.ELANOUS_LLM_API_KEY, env.ELANOUS_TELEGRAM_BOT_TOKEN]; }; const fromClosure = () => moduleAlias.CLOSURE_API_KEY; let reassigned = process.env; reassigned = { UNIQUE_REASSIGNED_SECRET: 'x' }; reassigned.UNIQUE_REASSIGNED_SECRET; const settings = { UNIQUE_OBJECT_SECRET: 'not an environment read' }; const ignored = settings.UNIQUE_OBJECT_SECRET; function uncertain(config: Record<string, string>) { return config.CONFIG_API_KEY; } const loose = env.POSSIBLY_SECRET; const parenthesized = (process.env); parenthesized.PARENTHESIZED_API_KEY; const impossibleFallback = { IMPOSSIBLE_FALLBACK_SECRET: 'x' } ?? process.env; impossibleFallback.IMPOSSIBLE_FALLBACK_SECRET;",
      'resources:\n  - env: [AWS_SECRET_ACCESS_KEY, GROK_CODE_XAI_API_KEY, ELANOUS_DISCORD_BOT_TOKEN, ELANOUS_LLM_API_KEY, ELANOUS_TELEGRAM_BOT_TOKEN, CLOSURE_API_KEY, PARENTHESIZED_API_KEY]\n',
    );
    try {
      const result = checkResourceMap({ root });
      const injectedNames = ['AWS_SECRET_ACCESS_KEY', 'CLOSURE_API_KEY', 'ELANOUS_DISCORD_BOT_TOKEN', 'ELANOUS_LLM_API_KEY', 'ELANOUS_TELEGRAM_BOT_TOKEN', 'GROK_CODE_XAI_API_KEY', 'PARENTHESIZED_API_KEY'];
      expect(result.covered.flatMap(({ envNames }) => envNames).sort()).toEqual(injectedNames);
      expect(result.credentials.flatMap(({ envNames }) => envNames).sort()).toEqual(injectedNames);
      for (const ignoredName of ['IMPOSSIBLE_FALLBACK_SECRET', 'LOOP_NON_ENV_SECRET', 'UNIQUE_NON_ENV_SECRET', 'UNIQUE_OBJECT_SECRET']) expect(result.credentials.flatMap(({ envNames }) => envNames)).not.toContain(ignoredName);
      expect(result.unknown).toEqual(['CONFIG_API_KEY', 'LOOP_NON_ENV_SECRET', 'POSSIBLY_SECRET', 'UNIQUE_REASSIGNED_SECRET']);
      expect(result.uncovered).toEqual([]);
      expect(result.excluded).toEqual([]);
      const { output, exits } = runCli(root);
      expect(JSON.parse(output[0]!)).toMatchObject({ credentials: expect.any(Array), covered: expect.any(Array), uncovered: [], excluded: [], unreadable: [], unknown: ['CONFIG_API_KEY', 'LOOP_NON_ENV_SECRET', 'POSSIBLY_SECRET', 'UNIQUE_REASSIGNED_SECRET'] });
      expect(exits).toEqual([0]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('propagates nested source-directory traversal failures', () => {
    const root = fixture('const key = process.env.COVERED_API_KEY;', 'resources:\n  - env: [COVERED_API_KEY]\n');
    const blockedDirectory = join(root, 'src', 'blocked');
    mkdirSync(blockedDirectory);
    try {
      expect(() => checkResourceMap({
        root,
        listDirectory: (path) => {
          if (path === blockedDirectory) throw new Error('nested source directory unavailable');
          return readdirSync(path);
        },
      })).toThrow('nested source directory unavailable');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('exits 0 when no credentials are measurable', () => {
    const root = fixture('export const value = 1;');
    try { expect(runCli(root).exits).toEqual([0]); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('returns only credential-requiring catalog ids whose free_fallback is empty', () => {
    expect(credentialIdsWithEmptyFreeFallback([
      { id: 'apify', auth: 'api-key' },
      { id: 'elevenlabs', auth: 'api-key', free_fallback: '' },
      { id: 'github', auth: 'cli-login', free_fallback: '   ' },
      { id: 'tavily', auth: 'api-key', free_fallback: 'ddg + jina' },
      { id: 'elanous-hitl-secret', auth: 'none' },
      { id: 'elanous-control-token', auth: 'none', free_fallback: '' },
      { id: '  ', auth: 'api-key' },
      { auth: 'api-key' },
      { id: 'oauth-browser', auth: 'oauth-browser' },
    ])).toEqual(['apify', 'elevenlabs', 'github', 'oauth-browser']);
  });

  test('does not infer missing or invalid auth as credential-requiring', () => {
    expect(credentialIdsWithEmptyFreeFallback([
      { id: 'unknown' },
      { id: 'null-auth', auth: null },
      { id: 'invalid-auth', auth: 'bogus' },
      { id: 'numeric-auth', auth: 1 },
      { id: 'object-auth', auth: { kind: 'api-key' } },
      { id: 'none-auth', auth: 'none' },
      { id: 'api-key-empty', auth: 'api-key' },
    ])).toEqual(['api-key-empty']);
  });

  test('distinguishes schema-empty free_fallback from invalid non-string values', () => {
    const entries = [
      { id: 'absent', auth: 'api-key' },
      { id: 'null-fallback', auth: 'api-key', free_fallback: null },
      { id: 'empty-string', auth: 'api-key', free_fallback: '' },
      { id: 'whitespace', auth: 'cli-login', free_fallback: '   ' },
      { id: 'present-string', auth: 'api-key', free_fallback: 'ddg + jina' },
      { id: 'array-fallback', auth: 'api-key', free_fallback: ['ddg', 'jina'] },
      { id: 'object-fallback', auth: 'oauth-browser', free_fallback: { path: 'ddg' } },
      { id: 'empty-array', auth: 'api-key', free_fallback: [] },
      { id: 'numeric-fallback', auth: 'api-key', free_fallback: 1 },
    ];
    const snapshot = structuredClone(entries);
    expect(credentialIdsWithEmptyFreeFallback(entries)).toEqual(['absent', 'null-fallback', 'empty-string', 'whitespace']);
    expect(entries).toEqual(snapshot);
  });

  test('checkResourceMap wires catalog entries through credentialIdsWithEmptyFreeFallback', () => {
    const result = checkResourceMap({});
    const document = parseYaml(readFileSync(join(process.cwd(), 'catalog/resources.yaml'), 'utf8')) as { resources?: unknown };
    const entries = Array.isArray(document.resources) ? document.resources : [];
    expect(result.emptyFreeFallbackIds).toEqual(credentialIdsWithEmptyFreeFallback(entries));
    // ⛔⭐ «수»도 «어느 id 가 빈칸인가»도 박지 않는다 — 빈칸을 채우는 것이 «의도된 작업»이다.
    //    📏 이 줄은 2026-09-22 에 ***두 번*** 깨졌다:
    //      ⑴ reddit 의 RSS 폴백을 채우자 16→15 로 `toHaveLength(16)` 이 깨졌고,
    //      ⑵ 그것을 `toBeGreaterThan(0)` ⊕ `toContain('apify')` 로 바꿨는데
    //         빈칸을 «전부» 채우자(16→0) 그 둘이 «또» 깨졌다.
    //    🔑 두 번 다 원인이 같다 — ***카탈로그의 «내용»을 자가 박은 것***이다.
    //    ⇒ 배선은 바로 위 toEqual 이 이미 «성질»로 문다. 탐지기 자체는 픽스처로 누른다
    //      (위 'credentialIdsWithEmptyFreeFallback' 시험이 absent/null/empty/whitespace 넷을 문다).
    expect(Array.isArray(result.emptyFreeFallbackIds)).toBe(true);
    // ⛔ 같은 이유로 «수»를 박지 않는다 — covered 가 28→32 로 늘자 이 줄이 깨졌다(2026-09-23).
    //    성질로 문다: 세 갈래는 서로 겹치지 않고, covered 는 비어 있지 않다.
    expect(result.covered.length).toBeGreaterThan(0);
    const coveredSet = new Set(result.covered.map((c: { id?: string }) => c.id ?? String(c)));
    for (const u of result.uncovered) expect(coveredSet.has((u as { id?: string }).id ?? String(u))).toBe(false);
  }, 60_000);

  test('runResourceMapCheckCli JSON output includes emptyFreeFallbackIds', () => {
    const output: string[] = [];
    runResourceMapCheckCli({ write: (text) => output.push(text), setExitCode: () => {} });
    expect(JSON.parse(output[0]!)).toHaveProperty('emptyFreeFallbackIds');
  }, 60_000);
});
