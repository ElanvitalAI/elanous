import { setDefaultTimeout, expect, test } from 'bun:test';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { handleRequest, tools } from '../../../plugins/job-coach/connectors/ncs/server.js';
import { courseLinks } from '../../../plugins/job-coach/graphs/course-links.js';
import { judgeGaps } from '../../../plugins/job-coach/graphs/gap-judge.js';
import { runGraph } from '../../graph-runner/runner.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const root = resolve(import.meta.dir, '../../../plugins/job-coach');
const manifest = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8'));
const codex = JSON.parse(readFileSync(join(root, '.codex-plugin/plugin.json'), 'utf8'));

test('portable and codex manifests register both modes and all eight skills', () => {
  expect([manifest.name, manifest.version]).toEqual([codex.name, codex.version]);
  expect(manifest.name).toBe('job-coach');
  const ext = manifest.extensions['ai.elanous'];
  const graphs = ['./graphs/report.yaml', './graphs/report-enterprise.yaml'];
  const skills = ['interview-to-profile', 'career-report', 'run-report', 'enterprise-needs',
    'enterprise-task-analysis', 'enterprise-ai-fit', 'enterprise-competency', 'enterprise-roadmap'];
  expect(ext.graphs).toEqual(graphs);
  expect(codex.extensions['ai.elanous'].graphs).toEqual(graphs);
  // Public capability form (`build-a-plugin.md`): shown to the user before install.
  expect(ext.capabilities).toEqual(['fs:workdir', 'net:apis.data.go.kr', 'proc:bun', 'proc:elanous', 'secret:ncs']);
  // `env` routes the stored key to the name the NCS server reads (`connectors/ncs/server.ts`).
  expect(ext.connectors).toEqual([{ id: 'ncs', fields: [{ name: 'serviceKey', secret: true, env: 'NCS_SERVICE_KEY' }] }]);
  expect(manifest.skills).toBe('./skills/');
  expect(codex.skills).toBe('./skills/');
  expect(manifest.contributes.skills.map((skill: { name: string }) => skill.name)).toEqual(skills);
  expect(codex.contributes.skills.map((skill: { name: string }) => skill.name)).toEqual(skills);
  for (const ref of [...graphs, manifest.skills, codex.skills, ...skills.map(name => `./skills/${name}/SKILL.md`)]) {
    expect(ref.startsWith('./')).toBe(true);
    expect(existsSync(resolve(root, ref))).toBe(true);
  }
  const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
  expect(mcp.mcpServers.ncs.args).toEqual(['${CODEX_PLUGIN_ROOT}/connectors/ncs/server.ts']);
  expect(existsSync(join(root, 'connectors/ncs/server.ts'))).toBe(true);
});

test('graph CLI dry-run walks the declared success path without calling HTTP or commands', () => {
  const temp = mkdtempSync(join(tmpdir(), 'job-coach-dry-'));
  try {
    const graph = join(root, 'graphs/report.yaml');
    const cli = spawnSync(Bun.which('bun')!, [join(resolve(import.meta.dir, '../../..'), 'bin/elanous.mjs'), `--test=${temp}`, 'graph', 'run', graph, '--dry-run', '--json'], {
      cwd: temp, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', HOME: temp }, timeout: 30000,
    });
    expect(cli.status, cli.stderr).toBe(0);
    const state = JSON.parse(cli.stdout) as { status: string; path: string[]; executed: number };
    expect(state.status).toBe('done');
    expect(state.path).toEqual(['profile', 'ncs-match', 'research', 'gap', 'report', 'judge', 'done']);
    expect(state.executed).toBe(0);
    const yaml = parseYaml(readFileSync(graph, 'utf8'));
    expect(yaml.nodes.find((node: { node_id: string }) => node.node_id === 'judge').max_visits).toBe(2);
    expect(yaml.edges.find((edge: { from: string }) => edge.from === 'judge').map.retry).toBe('research');
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('NCS MCP lists three tools and maps each to a real operation with fake HTTP', async () => {
  const calls: URL[] = [];
  const fake = (async (url: string | URL | Request) => {
    const target = new URL(String(url));
    calls.push(target);
    return new Response(JSON.stringify({ response: { header: { resultCode: '00' }, body: { items: { item: [{ NCS_CL_CD: '01020304', COMPE_UNIT_NAME: '분석' }] } } } }), { status: 200 });
  }) as typeof fetch;
  const listing = await handleRequest({ id: 1, method: 'tools/list' });
  expect(listing.result).toEqual({ tools });
  for (const [name, args, operation] of [
    ['ncs_search_units', { keyword: '데이터 분석' }, 'NCS007'],
    ['ncs_unit', { code: '010203040001' }, 'NCS005'],
    ['ncs_classification', { level: 'detailed', code: '010203' }, 'NCS004'],
  ] as const) {
    const reply = await handleRequest({ id: 2, method: 'tools/call', params: { name, arguments: args } }, { key: 'fake', fetch: fake });
    expect(reply.result?.isError).toBeUndefined();
    expect(JSON.parse(reply.result!.content![0]!.text).body.items.item[0].COMPE_UNIT_NAME).toBe('분석');
    expect(calls.at(-1)!.pathname.endsWith(operation)).toBe(true);
  }
  expect(calls[0]!.searchParams.get('SWRD')).toBe('데이터 분석');
  expect(calls[1]!.searchParams.get('NCS_SUBD_CD')).toBe('04');
  expect(calls[1]!.searchParams.get('NCS_CL_CD')).toBe('01020304');
  expect(calls[1]!.searchParams.get('NCS_COMPE_UNIT_CD')).toBe('010203040001');
  expect(calls[2]!.searchParams.get('NCS_SCLAS_CD')).toBe('03');
});

test('installed MCP config starts from another cwd and answers tool calls', () => {
  const temp = mkdtempSync(join(tmpdir(), 'job-coach-mcp-'));
  try {
    const installed = join(temp, 'installed');
    const elsewhere = join(temp, 'elsewhere');
    cpSync(root, installed, { recursive: true });
    mkdirSync(elsewhere);
    const config = JSON.parse(readFileSync(join(installed, '.mcp.json'), 'utf8')) as { mcpServers: { ncs: { command: string; args: string[]; env: Record<string, string> } } };
    const spec = config.mcpServers.ncs;
    const args = spec.args.map(arg => arg.replaceAll('${CODEX_PLUGIN_ROOT}', installed));
    const input = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ncs_search_units', arguments: { keyword: '분석' } } },
    ].map(request => JSON.stringify(request)).join('\n') + '\n';
    const result = spawnSync(spec.command, args, { cwd: elsewhere, encoding: 'utf8', input, env: { ...process.env, NCS_SERVICE_KEY: '' } });
    expect(result.status).toBe(0);
    const replies = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    expect(replies[0].result.serverInfo.name).toBe('job-coach-ncs');
    expect(replies[1].result.tools.map((tool: { name: string }) => tool.name)).toEqual(['ncs_search_units', 'ncs_unit', 'ncs_classification']);
    expect(replies[2].result.isError).toBe(true);
    expect(replies[2].result.content[0].text).toContain('키 없음');
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('profile reads LF and CRLF interviews identically', () => {
  const temp = mkdtempSync(join(tmpdir(), 'job-coach-newlines-'));
  try {
    const source = readFileSync(join(root, 'examples/interview-sample.md'), 'utf8');
    const results = ['\n', '\r\n'].map((newline, index) => {
      const interview = join(temp, `interview-${index}.md`);
      writeFileSync(interview, source.replace(/\r?\n/g, newline));
      const context = join(temp, `run-${index}.json.contexts`, '1.json');
      mkdirSync(join(temp, `run-${index}.json.contexts`));
      writeFileSync(context, JSON.stringify({ input: { interview }, outputs: {} }));
      const result = spawnSync(Bun.which('bun')!, [join(root, 'graphs/run-step.ts'), 'profile'], {
        encoding: 'utf8', env: { ...process.env, ELANOUS_GRAPH_CONTEXT: context },
      });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    });
    expect(results[1]).toEqual(results[0]);
    expect(results[1]).toEqual({ jobs: ['데이터 분석'], skills: ['스프레드시트', '데이터 시각화'], experienceCount: 2 });
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('gap calls the judge once and downgrades quotes absent from the original interview', async () => {
  const units = [
    { code: '01', name: '데이터 분석', definition: '분석', level: '4', elements: [{ name: '자료 정리', criteria: '자료를 표로 정리한다' }] },
    { code: '02', name: '시각화', definition: '차트', level: '3', elements: [{ name: '차트 제작', criteria: '차트를 만든다' }] },
    { code: '03', name: '모델링', definition: '모델', level: '5', elements: [] },
  ];
  const interview = '가상 자료를 표로 정리했다. 차트를 일부 만들었다.';
  let calls = 0;
  const gaps = await judgeGaps(units, interview, async prompt => {
    calls++;
    expect(prompt).toContain('자료를 표로 정리한다');
    expect(prompt).toContain('"level":"4"');
    return JSON.stringify({ gaps: [
      { code: '01', status: '보유', quote: '가상 자료를 표로 정리했다.' },
      { code: '02', status: '부분', quote: '차트를 일부 만들었다.' },
      { code: '03', status: '보유', quote: '인터뷰에 없는 문장이다.' },
    ] });
  });
  expect(calls).toBe(1);
  expect(gaps).toEqual([
    { code: '01', name: '데이터 분석', status: '보유', quote: '가상 자료를 표로 정리했다.' },
    { code: '02', name: '시각화', status: '부분', quote: '차트를 일부 만들었다.' },
    { code: '03', name: '모델링', status: '갭', quote: '' },
  ]);
  expect((await judgeGaps(units, interview, async () => 'not json')).every(gap => gap.status === '갭')).toBe(true);
});

test('research leads require a publisher-declared course relevant to an NCS unit', async () => {
  const hits = { output: ['- [자료](https://example.org/document)', '- [무관한 강좌](https://example.org/unrelated)', '- [관련 강좌](https://example.org/course)'].join('\n') };
  const pages: Record<string, string> = {
    '/document': '<html><p>데이터 시각화 설명 문서</p></html>',
    '/unrelated': '<script type="application/ld+json">{"@type":"Course","name":"요리 강좌","description":"조리 실습"}</script>',
    '/course': '<script type="application/ld+json">{"@type":"Course","name":"데이터 시각화 실습","description":"데이터 시각화 역량을 익히는 강좌"}</script>',
  };
  const fake = (async (url: string | URL | Request) => new Response(pages[new URL(String(url)).pathname], { headers: { 'content-type': 'text/html' } })) as typeof fetch;
  expect(await courseLinks(hits, [{ code: '01020304', name: '데이터 시각화' }], fake)).toEqual([{
    title: '데이터 시각화 실습', url: 'https://example.org/course', matchedUnit: '01020304 데이터 시각화',
    evidence: '발행 페이지 Course 메타데이터의 이름·설명에서 NCS 능력단위 「데이터 시각화」 확인',
  }]);
  expect(await courseLinks({ results: [{ title: '가짜', url: 'https://example.org/course' }] }, [{ code: '01020304', name: '데이터 시각화' }], fake)).toEqual([]);
});

async function installedReport(retry: boolean, unrelated = false) {
  const temp = mkdtempSync(join(tmpdir(), 'job-coach-installed-'));
  try {
    const installed = join(temp, 'installed');
    const elsewhere = join(temp, 'elsewhere');
    const bin = join(temp, 'bin');
    cpSync(root, installed, { recursive: true });
    mkdirSync(elsewhere);
    mkdirSync(bin);
    const preload = join(temp, 'fake-fetch.ts');
    writeFileSync(preload, `globalThis.fetch = (async (url) => {
  const target = new URL(String(url));
  if (target.hostname === 'example.org' && target.pathname === '/course') return new Response('<script type="application/ld+json">{"@type":"Course","name":"데이터 시각화 실습","description":"데이터 시각화 능력단위 강좌"}</script>', {headers:{'content-type':'text/html'}});
  if (target.pathname.endsWith('/NCS005') && (target.searchParams.get('NCS_COMPE_UNIT_CD') !== '010203040001' || target.searchParams.get('NCS_CL_CD') !== '01020304')) return new Response('wrong competency unit code', {status:422});
  if (!target.pathname.endsWith('/NCS005') && !target.pathname.endsWith('/NCS007')) return new Response('unexpected NCS operation', {status:404});
  const item = target.pathname.endsWith('/NCS005') ? {COMPE_UNIT_LVL:'4',COMPE_UNIT_ELEM:[{COMPE_UNIT_ELEM_NAME:'자료 정리',PERF_CRIT:'설문 자료를 표로 정리한다.'}]} : {NCS_CL_CD:'01020304',NCS_COMPE_UNIT_CD:'010203040001',COMPE_UNIT_NAME:'데이터 시각화'};
  return new Response(JSON.stringify({response:{header:{resultCode:'00'},body:{items:{item:[item]}}}}));
}) as typeof fetch;\n`);
    const bun = join(bin, 'bun');
    writeFileSync(bun, `#!/bin/sh\nexec '${Bun.which('bun')}' --preload '${preload}' "$@"\n`);
    chmodSync(bun, 0o755);
    const researchCalls = join(temp, 'research-calls');
    const gapCalls = join(temp, 'gap-calls');
    const cli = join(bin, 'elanous');
    // An installed plugin runs outside any git tree, where the real CLI refuses `--test` (no isolation root).
    writeFileSync(cli, `#!/bin/sh\ncase " $* " in *' --test '*) echo '[--test] 격리 루트를 정할 수 없습니다' >&2; exit 1;; esac\nif [ "$1" = 'ask' ]; then\n  echo called >> '${gapCalls}'\n  printf '%s\\n' '{"reply":"{\\"gaps\\":[{\\"code\\":\\"010203040001\\",\\"status\\":\\"보유\\",\\"quote\\":\\"가상 동아리 설문 결과를 표로 정리했다.\\"}]}"}'\n  exit 0\nfi\n[ "$1" = 'research' ] && [ "$3" = '--json' ] || exit 17\necho called >> '${researchCalls}'\n${retry ? `[ "$(wc -l < '${researchCalls}')" -eq 1 ] && { printf '%s\\n' '{"output":"no results"}'; exit 0; }` : ''}\nprintf '%s\\n' '${unrelated ? '{"output":"- [자료](https://example.org/document)"}' : '{"output":"- [공개 강좌](https://example.org/course)"}'}'\n`);
    chmodSync(cli, 0o755);
    const commands: string[] = [];
    const state = await runGraph(join(installed, 'graphs/report.yaml'), {
      input: { interview: join(installed, 'examples/interview-sample.md') },
      deps: { root: join(temp, 'state'), runBash: async (body, opts) => {
        commands.push(body);
        const result = spawnSync('/bin/bash', ['-c', body], { cwd: elsewhere, encoding: 'utf8', env: { ...opts.env, PATH: `${bin}:${process.env.PATH}`, NODE_ENV: 'test', NCS_SERVICE_KEY: 'fake' } });
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? 1 };
      } },
    });
    expect(state.status).toBe('done');
    expect(state.path).toEqual(retry || unrelated
      ? ['profile', 'ncs-match', 'research', 'gap', 'report', 'judge', 'research', 'gap', 'report', 'judge', 'done']
      : ['profile', 'ncs-match', 'research', 'gap', 'report', 'judge', 'done']);
    const recipes = parseYaml(readFileSync(join(installed, 'graphs/recipes.yaml'), 'utf8')) as Record<string, { command: string }>;
    expect(commands).toEqual(state.path.filter(node => recipes[node]).map(node => recipes[node]!.command));
    expect(readFileSync(researchCalls, 'utf8').trim().split('\n')).toHaveLength(retry || unrelated ? 2 : 1);
    expect(readFileSync(gapCalls, 'utf8').trim().split('\n')).toHaveLength(1);
    const report = readFileSync(join(state.statePath.slice(0, -5), 'report.md'), 'utf8');
    for (const section of ['직무', 'NCS 능력단위 매칭', '역량 갭', '추천 코스', '출처']) expect(report).toContain(`## ${section}`);
    if (unrelated) {
      expect(report).toContain('확인된 관련 교육 과정 없음 (추천 미확인)');
      expect(report).not.toContain('https://example.org/document');
    } else {
      expect(report).toContain('https://example.org/course');
      expect(report).toContain('발행 페이지 Course 메타데이터의 이름·설명에서 NCS 능력단위');
    }
    expect(report).toContain('010203040001 데이터 시각화: 보유 — 인터뷰 인용: “가상 동아리 설문 결과를 표로 정리했다.”');
    expect(report).toContain('수준 4 · 자료 정리: 설문 자료를 표로 정리한다.');
    expect(readFileSync(state.statePath, 'utf8')).toContain('가상 동아리 설문 결과를 표로 정리했다.');
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

test('installed graph executes actual recipes and research from a different cwd', async () => {
  await installedReport(false);
});

test('installed graph retries empty external research once', async () => {
  await installedReport(true);
});

test('installed graph does not recommend a document and records unverified courses', async () => {
  await installedReport(false, true);
});

test.skipIf(!Bun.which('codex'))('isolated Codex marketplace installation exposes job-coach skills', () => {
  const temp = mkdtempSync(join(tmpdir(), 'job-coach-codex-'));
  try {
    const home = join(temp, 'codex');
    mkdirSync(home);
    const env = { ...process.env, CODEX_HOME: home };
    const cli = (args: string[]) => spawnSync('codex', args, { cwd: temp, env, encoding: 'utf8', timeout: 30000 });
    const market = cli(['plugin', 'marketplace', 'add', root, '--json']);
    expect(market.status).toBe(0);
    expect(JSON.parse(market.stdout).marketplaceName).toBe('job-coach-local');
    const installed = cli(['plugin', 'add', 'job-coach@job-coach-local', '--json']);
    expect(installed.status).toBe(0);
    expect(JSON.parse(installed.stdout).name).toBe('job-coach');
    const prompt = cli(['debug', 'prompt-input', 'job-coach:']);
    expect(prompt.status).toBe(0);
    expect(prompt.stdout).toContain('job-coach:run-report');
    expect(prompt.stdout).toContain('job-coach:career-report');
    expect(prompt.stdout).toContain('job-coach:interview-to-profile');
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('missing NCS key returns an explicit error without attempting HTTP', async () => {
  const reply = await handleRequest({ id: 1, method: 'tools/call', params: { name: 'ncs_search_units', arguments: { keyword: '분석' } } }, { key: '', fetch: (async () => { throw new Error('network called'); }) as unknown as typeof fetch });
  expect(reply.result?.isError).toBe(true);
  expect(reply.result!.content![0]!.text).toContain('키 없음');
});
