// ⛔⭐ 4차 리뷰 ③ — 19개 변경 파일에 «시험이 0개»였다.
//   이 PR 이 고친 결함은 전부 ***fail-open*** 이었다(승인해 놓고 값을 안 읽는다 · 기대 실패를
//   못 재는데 통과한다 · 선언에 없는 노드를 ⚠️ 로 넘긴다). 그런 결함은 「초록」으로 안 보인다.
//   ⇒ 그래서 이 파일은 «빨간 길»을 같이 밟는다 — 종료 코드가 0 이 아닌 경우를 먼저 적는다.
import { afterAll, describe, expect, it } from 'bun:test';
import { assembleFilmLineState, loadHyperframesProjects } from './video-film-line.js';
import { parseArgv } from './lib/argv.js';
import { summarizeTiers } from '../src/video-pipeline/tier-summary.js';
import { CAPABILITIES, PROVIDERS } from '../src/video-pipeline/capabilities.js';
import { gateByHost, hostLabel, isDefinitelyDown, type HostState } from '../src/video-pipeline/host-gating.js';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const CLI = join(HERE, 'video-pipeline.ts');
const CHECK = join(HERE, 'check-graph-declaration.ts');
const DECL_REL = 'graphs/video/video-production-pipeline.declaration.yaml';
const FIXTURE_HOME = mkdtempSync(join(tmpdir(), 'vp-enabled-tools-'));
mkdirSync(join(FIXTURE_HOME, '.elanous'), { recursive: true });
mkdirSync(join(FIXTURE_HOME, '.claude', 'skills', 'hyperframes'), { recursive: true });
writeFileSync(join(FIXTURE_HOME, '.elanous', 'config.json'), JSON.stringify({
  mcp: { servers: [{ id: 'higgsfield-bridge', enabled: true }, { id: 'topview', enabled: true }] },
}));
const FIXTURE_ENV = { ...process.env, HOME: FIXTURE_HOME, ELANOUS_VIDEO_TOOLS: '', ELANOUS_VIDEO_SKIP_REMOTE_PROBE: '1' };
afterAll(() => rmSync(FIXTURE_HOME, { recursive: true, force: true }));

// 선언 하나만 갈아 끼운 «가짜 저장소»를 만든다. ⛔ 전부 mkdtemp 안이라 작업트리를 안 건드린다.
function declDir(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'vp-decl-'));
  mkdirSync(join(dir, 'graphs/video'), { recursive: true });
  writeFileSync(join(dir, DECL_REL), contents);
  return dir;
}

// ⛔ 14차 리뷰 — 「종료코드만 본다」로는 ***문면이 거짓말하는 것***을 못 잡는다.
//   `detect:false` 인데 「지금 기계에서 끝까지 돈다」고 단언한 것이 정확히 그 자리였다.
function out(script: string, args: string[], cwd = REPO): string {
  const r = spawnSync('bun', [script, ...args], { cwd, encoding: 'utf8', timeout: 90_000 });
  if (r.status === null) throw new Error(`죽었다(signal=${r.signal})`);
  return `${r.stdout}${r.stderr}`;
}

/**
 * ⛔⭐⭐ ***JSON 은 stdout «만» 읽는다.***
 *
 * 🩸 실측 2026-09-22: 위 `out()` 은 «일부러» `stdout + stderr` 를 합친다(사람 문면을 보려고).
 *   그런데 그것으로 `JSON.parse` 를 하면, ***stderr 에 한 줄이라도 섞이는 날 시험이 깨진다.***
 *   실제로 깨졌다 — 원격 `bash -lc` 가 그 기계의 프로파일 오류를 뱉었고 ssh 가 우리 stderr 로 날랐다.
 * 🔑 ***기계가 읽는 계약은 stdout 이다.*** 그 계약을 검사할 땐 stderr 를 «섞지 않는다» —
 *   섞으면 「계약이 깨졌다」와 「누가 stderr 에 뭘 썼다」를 구별할 수 없다.
 * ⊕ 그리고 이 함수는 ***stdout 이 오염되지 않았다는 것 자체를 검사***한다(파싱이 곧 그 검사다).
 */
function outJson(script: string, args: string[], cwd = REPO): string {
  const r = spawnSync('bun', [script, ...args], { cwd, encoding: 'utf8', timeout: 90_000 });
  if (r.status === null) throw new Error(`죽었다(signal=${r.signal})`);
  return r.stdout;
}

function configuredOut(args: string[]): string {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO, encoding: 'utf8', timeout: 90_000, env: FIXTURE_ENV,
  });
  if (r.status !== 0) throw new Error(`video-pipeline ${args.join(' ')}: exit=${r.status} ${r.stderr}`);
  return r.stdout;
}

/**
 * ⛔⭐ ***다른 운영체제인 척하고 돌린다.*** 실물 리눅스엔 `bun` 이 없어 CLI 를 못 돌린다.
 *   ⚠️ 이것은 «흉내»가 아니라 ***진짜 CLI***를 돌린다 — `process.platform` 만 바꿔 끼운다.
 */
function outAsPlatform(plat: string, args: string[]): string {
  const shim = join(tmpdir(), `as-${plat}-${Date.now()}.ts`);
  writeFileSync(shim,
    `Object.defineProperty(process,'platform',{value:'${plat}',configurable:true});\n`
    + `await import(${JSON.stringify(CLI)});\n`, 'utf8');
  try {
    const r = spawnSync('bun', [shim, ...args],
      { cwd: REPO, encoding: 'utf8', timeout: 90_000,
        env: { ...process.env, ELANOUS_VIDEO_SKIP_REMOTE_PROBE: '1' } });
    if (r.status === null) throw new Error(`죽었다(signal=${r.signal})`);
    return `${r.stdout}${r.stderr}`;
  } finally { rmSync(shim, { force: true }); }
}

function run(script: string, args: string[], cwd = REPO): number {
  const r = spawnSync('bun', [script, ...args], { cwd, encoding: 'utf8', timeout: 90_000 });
  // ⛔ 「죽었다」와 「거부했다」를 섞지 않는다 — 시그널로 죽으면 status 가 null 이다.
  if (r.status === null) throw new Error(`죽었다(signal=${r.signal}): ${script} ${args.join(' ')}`);
  return r.status;
}

describe('video-pipeline CLI — 인자 계약', () => {
  it('값을 준 플래그는 통과한다', () => {
    expect(run(CLI, ['plan', '--need=caption'])).toBe(0);
    expect(run(CLI, ['plan', '--need', 'image-gen'])).toBe(0);
    expect(run(CLI, ['probe'])).toBe(0);
  });

  it('값이 없는 플래그는 exit 2 다 — `--need=` 도 «값 누락»이다', () => {
    expect(run(CLI, ['plan', '--need'])).toBe(2);
    expect(run(CLI, ['plan', '--need='])).toBe(2);
    expect(run(CLI, ['plan', '--need', '='])).toBe(2);
  });

  it('서브커맨드가 안 받는 플래그는 exit 2 다', () => {
    expect(run(CLI, ['probe', '--out', '/tmp/x'])).toBe(2);
    expect(run(CLI, ['plan', '--init'])).toBe(2);
  });

  it('모르는 플래그는 exit 2 다', () => {
    expect(run(CLI, ['plan', '--nonexistent-flag', 'v'])).toBe(2);
  });

  // ⛔ 10차 리뷰 ① — bool 플래그는 중복 검사에서 «빠져» 있었다. 예외가 곧 다음 결함이다.
  it('bool 플래그도 중복·값 부여를 거부한다', () => {
    expect(run(CLI, ['probe', '--json', '--json'])).toBe(2);
    expect(run(CLI, ['plan', '--json=1'])).toBe(2);
    // ⛔ 11차 리뷰 ① — 「붙여 쓴 값」만 막고 「띄어 쓴 값」을 놓쳤다. 두 철자를 같이 누른다.
    expect(run(CLI, ['probe', '--json', '값'])).toBe(2);
    expect(run(CLI, ['probe', '--json'])).toBe(0);
  });

  it('남는 위치 인자를 조용히 흘리지 않는다', () => {
    expect(run(CLI, ['probe', '엉뚱한것'])).toBe(2);
    expect(run(CLI, ['plan', '--need', 'caption', '남는것'])).toBe(2);
  });

  // ⛔ 6차 리뷰 ② — 「한 번 맞았으니 나머지는 봐준다」가 조용한 구멍이었다.
  it('같은 플래그를 두 번 주고 뒤쪽에 값이 없으면 exit 2 다', () => {
    expect(run(CLI, ['plan', '--need=caption', '--need'])).toBe(2);
    expect(run(CLI, ['plan', '--need', 'caption', '--need='])).toBe(2);
  });

  // ⛔⭐ 8차 리뷰 ② — 위 시험은 «뒤쪽이 빈» 경우만 봤다. ***정상값 중복이 더 조용했다*** —
  //   `--need caption --need image-gen` 이 exit 0 이고 image-gen 이 «버려졌다». 굿하트다.
  it('같은 플래그를 두 번 주면 뒤쪽이 «정상값»이어도 exit 2 다', () => {
    expect(run(CLI, ['plan', '--need', 'caption', '--need', 'image-gen'])).toBe(2);
    expect(run(CLI, ['plan', '--need=caption', '--need=image-gen'])).toBe(2);
  });

  it('여러 값은 쉼표로 준다 — 그 길은 열려 있다', () => {
    expect(run(CLI, ['plan', '--need', 'caption,image-gen'])).toBe(0);
  });

  // ⛔ 9차 리뷰 ② — `--assume-missing` 이 «값 받는 목록»에서 빠져 중복이 통과했다.
  //   ⇒ 목록을 손으로 두면 또 빠진다. 이제 KNOWN_FLAGS 에서 파생하므로 새 플래그가 자동으로 걸린다.
  it('값 받는 플래그는 «전부» 중복을 거부한다', () => {
    for (const [f, v] of [['--assume-missing', 'ffmpeg'], ['--prefer', 'free'],
                          ['--surface', 'tui'], ['--from', 'ground']] as const) {
      expect(run(CLI, ['plan', f, v, f, v])).toBe(2);
    }
  });

  // ⛔ 21차 리뷰 — 오타면 «아무것도 안 빠지는데» 산출은 「가정했다」고 적는다.
  it('--assume-missing 의 오타는 exit 2 다', () => {
    expect(run(CLI, ['probe', '--assume-missing', 'no-such-impl'])).toBe(2);
    expect(run(CLI, ['probe', '--assume-missing', 'ffmpeg-encode'])).toBe(0);
  });

  it('레지스트리에 없는 provider 는 exit 2 다 — 조용히 무시하지 않는다', () => {
    expect(run(CLI, ['plan', '--provider-order', 'definitely-not-a-provider'])).toBe(2);
  });

  it('명시한 --config 경로가 없으면 exit 2 다 — 다른 설정으로 계획하지 않는다', () => {
    expect(run(CLI, ['probe', '--config', join(tmpdir(), 'no-such-video-tools.json')])).toBe(2);
  });
});

// ⛔ 8차 리뷰 ③ — 라이브러리 계약을 «함수 수준»에서 누른다. CLI 가 막아 준다고 함수가 옳은 건 아니다.
describe('loadConfig — 명시 경로는 «못 박은 한 칸»이다', () => {
  function loadExit(expr: string): number {
    const r = spawnSync('bun', ['-e', expr], { cwd: REPO, encoding: 'utf8', timeout: 90_000 });
    if (r.status === null) throw new Error(`죽었다(signal=${r.signal})`);
    return r.status;
  }
  const IMP = "import {loadConfig} from './src/video-pipeline/config.ts';";

  it('명시 경로가 없으면 error 칸을 낸다 — 다른 설정으로 «폴백하지 않는다»', () => {
    expect(loadExit(`${IMP} process.exit(loadConfig('${join(tmpdir(), 'no-such-vt.json')}').error ? 2 : 0)`)).toBe(2);
  });

  it('명시가 없으면 내장 레지스트리로 가되 error 는 없다', () => {
    expect(loadExit(`${IMP} process.exit(loadConfig().error ? 2 : 0)`)).toBe(0);
  });
});

describe('drift — 선언 ↔ 뼈대', () => {
  it('저장소 현재 상태는 드리프트가 없다', () => {
    expect(run(CLI, ['drift'])).toBe(0);
  });

  // ⛔ 빨간 길 — 이 시험이 없으면 drift 가 «언제나 0» 이어도 아무도 모른다.
  //   ⭐ 개명은 «선언 전체»에 일관되게 한다 — 노드만 바꾸면 간선이 깨져 파서가 거부하고(exit 2)
  //      「뼈대와 갈렸다(1)」가 아니라 「못 쟀다(2)」를 재게 된다. 두 실패는 다른 값이다.
  it('뼈대 노드가 선언에서 사라지면 exit 1 이다(종전엔 ⚠️ 만 찍고 통과했다)', () => {
    const dir = declDir(readFileSync(join(REPO, DECL_REL), 'utf8').replace(/\bcompose\b/g, 'composeX'));
    expect(run(CLI, ['drift'], dir)).toBe(1);
  });

  it('노드의 입력이 갈리면 exit 1 이다', () => {
    const dir = declDir(readFileSync(join(REPO, DECL_REL), 'utf8')
      .replace('inputs: [timeline, asset_files]', 'inputs: [timeline]'));
    expect(run(CLI, ['drift'], dir)).toBe(1);
  });

  // ⛔⭐ 6차 리뷰 ③ — 종전의 drift 는 «정규식»으로 읽어서, 소비자(로더)가 «거부하는» 선언도
  //   「드리프트 없음」 exit 0 으로 통과시켰다. 자는 소비자가 읽는 방식으로 읽어야 한다.
  // ⛔ 13차 리뷰 ③ — 여기까지는 «뼈대 → 선언» 한 방향만 봤다. 집합 대조는 «양방향»이다.
  it('선언에만 있는 비종단 노드도 exit 1 이다', () => {
    const raw = readFileSync(join(REPO, DECL_REL), 'utf8');
    const doctored = raw.replace('  - node_id: compose',
      '  - { node_id: newnode, kind: agent, recipe: r, max_visits: 1,'
      + ' contract: { inputs: [x], tools: none, outputs: [y] } }\n  - node_id: compose');
    expect(doctored).not.toBe(raw);
    expect(run(CLI, ['drift'], declDir(doctored))).toBe(1);
  });

  it('로더가 거부하는 선언은 exit 2 다 — 「없다」가 아니라 「못 쟀다」', () => {
    const dir = declDir(readFileSync(join(REPO, DECL_REL), 'utf8').replace(/^entry_node:.*$/m, ''));
    expect(run(CLI, ['drift'], dir)).toBe(2);
  });

  it('선언을 못 읽으면 exit 2 다 — 「없다」를 「같다」로 읽지 않는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-nodecl-'));
    expect(run(CLI, ['drift'], dir)).toBe(2);
  });
});

describe('check-graph-declaration — 기대 실패 관문', () => {
  const OK = join(REPO, DECL_REL);
  const OVLDIR = join(REPO, 'graphs/video/overlays');
  const BROKEN = join(REPO, 'graphs/video/evas-shorts-pipeline.declaration.yaml');

  it('기대 실패를 이름으로 선언하면 전수가 통과한다', () => {
    expect(run(CHECK, [OK, BROKEN, '--expect-fail', 'evas-shorts-pipeline.declaration.yaml'])).toBe(0);
  });

  it('선언 없이 깨진 파일을 넣으면 exit 1 이다', () => {
    expect(run(CHECK, [OK, BROKEN])).toBe(1);
  });

  // ⛔ 4차 리뷰 ② — 이름이 «검사 대상에 없으면» 아무것도 못 재는데 exit 0 이었다.
  it('기대 실패로 이름 댄 파일이 대상에 없으면 exit 2 다', () => {
    expect(run(CHECK, [OK, '--expect-fail', 'not-in-the-list.yaml'])).toBe(2);
  });

  it('--expect-fail 에 값이 없으면 exit 2 다 — `=` 형태도 같다', () => {
    expect(run(CHECK, [OK, '--expect-fail'])).toBe(2);
    // ⛔ 5차 리뷰 ①: 4차가 세운 이 관문이 `=` 철자로는 «안 닿았다» — 같은 결함이 다른 철자로 살았다.
    expect(run(CHECK, [OK, '--expect-fail='])).toBe(2);
  });

  it('`--expect-fail=<값>` 도 이름으로 읽는다', () => {
    expect(run(CHECK, [OK, BROKEN, '--expect-fail=evas-shorts-pipeline.declaration.yaml'])).toBe(0);
  });

  // ⛔ 9차 리뷰 ③ — 이 스크립트엔 «플래그 계약이 아예 없었다». 옆 스크립트만 여덟 판 다듬었다.
  it('모르는 플래그·중복 플래그는 exit 2 다', () => {
    expect(run(CHECK, ['--bogus', OK])).toBe(2);
    expect(run(CHECK, ['--index', '--index', OK])).toBe(2);
    expect(run(CHECK, [OK, '--check-overlays', OVLDIR, '--check-overlays', OVLDIR])).toBe(2);
  });

  // ⛔ 10차 리뷰 ② — 9차에 «급히» 세운 계약이 `=` 철자를 또 놓쳤다. 이제 두 입구가 한 벌을 쓴다.
  it('`=` 철자도 값 누락을 잡는다', () => {
    expect(run(CHECK, [OK, '--check-overlays='])).toBe(2);
    expect(run(CHECK, [OK, '--expect-fail='])).toBe(2);
  });

  it('--expect-fail 을 두 번 주면 exit 2 다', () => {
    expect(run(CHECK, [OK, BROKEN,
      '--expect-fail=evas-shorts-pipeline.declaration.yaml', '--expect-fail'])).toBe(2);
  });

  it('기대 실패가 «통과»해도 exit 1 이다 — 선언이 낡았다는 뜻이다', () => {
    expect(run(CHECK, [OK, '--expect-fail', 'video-production-pipeline.declaration.yaml'])).toBe(1);
  });
});

describe('check-graph-declaration — 오버레이 인덱스', () => {
  const OK = join(REPO, DECL_REL);
  const OVL = join(REPO, 'graphs/video/overlays');

  // ⛔ 대상을 «넓혀야» 전 오버레이의 target 이 해결된다(render-patient 는 exec-standard 를 겨눈다).
  const ALL = [OK, join(REPO, 'graphs/video/exec-standard.yaml')];

  it('저장소 오버레이는 이름과 인덱스가 맞는다', () => {
    expect(run(CHECK, [...ALL, '--check-overlays', OVL])).toBe(0);
  });

  // ⛔ 좁힌 대상으로 돌리면 «대조 못 함»이 남는다 — 그것을 통과로 읽지 않는다.
  it('대상을 좁히면 target 미해결로 exit 1 이다', () => {
    expect(run(CHECK, [OK, '--check-overlays', OVL])).toBe(1);
  });

  // ⛔ 빨간 길 — README 가 이 위험을 «적어 두고» 재는 자는 없었다.
  it('인덱스가 다른 노드를 가리키면 exit 1 이다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-ovl-'));
    const raw = readFileSync(join(OVL, 'profile-gui-app.yaml'), 'utf8');
    const doctored = raw.replace('/nodes/7/maxVisits', '/nodes/6/maxVisits');
    expect(doctored).not.toBe(raw);
    writeFileSync(join(dir, 'profile-gui-app.yaml'), doctored);
    expect(run(CHECK, [OK, '--check-overlays', dir])).toBe(1);
  });

  it('노드 이름 주석이 없으면 exit 1 이다 — 「못 잰다」는 「통과」가 아니다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-ovl2-'));
    const raw = readFileSync(join(OVL, 'profile-credit-heavy.yaml'), 'utf8');
    const doctored = raw.replace(/(path: \/nodes\/4\/maxVisits)[ \t]*#.*/, '$1');
    expect(doctored).not.toBe(raw);
    writeFileSync(join(dir, 'profile-credit-heavy.yaml'), doctored);
    expect(run(CHECK, [OK, '--check-overlays', dir])).toBe(1);
  });

  // ⛔ 7차 리뷰 ② — target 오타는 「그 오버레이가 영영 안 얹힌다」는 뜻이다. 통과시키지 않는다.
  it('오버레이의 target 을 검사 대상에서 못 찾으면 exit 1 이다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-ovl-t-'));
    writeFileSync(join(dir, 'typo.yaml'),
      'overlay_id: t\ntarget: no-such-graph\nstage: runtime\napplies_when: x\n'
      + 'patch:\n  - op: replace\n    path: /nodes/3/maxVisits   # assets\n    value: 1\n');
    expect(run(CHECK, [OK, '--check-overlays', dir])).toBe(1);
  });

  // ⛔⭐ 13차 리뷰 ② GOODHART — 이 자가 «정규식»으로 읽어서 ***YAML 파서가 거부할 오버레이***를 통과시켰다.
  //   6차에 drift 에서 같은 것을 고쳤는데 «이 자»에는 안 옮겼다.
  it('YAML 이 깨진 오버레이는 exit 1 이다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-ovl-y-'));
    writeFileSync(join(dir, 'bad.yaml'),
      'target: video-production\npatch:\n  - path: /nodes/3/maxVisits # assets\n    value: [\n');
    expect(run(CHECK, [OK, '--check-overlays', dir])).toBe(1);
  });

  // ⛔ 14차 리뷰 ① — 원소를 안 봤다. 「걸린 것이 없다」와 「볼 것이 없다」는 다른 값이다.
  it('patch 원소가 맵이 아니거나 계약을 어기면 exit 1 이다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-ovl-p-'));
    writeFileSync(join(dir, 'a.yaml'),
      "overlay_id: bad\ntarget: video-production\napplies_when: selected('encode')\npatch: [123]\n");
    expect(run(CHECK, [OK, '--check-overlays', dir])).toBe(1);

    const dir2 = mkdtempSync(join(tmpdir(), 'vp-ovl-p2-'));
    writeFileSync(join(dir2, 'b.yaml'),
      "overlay_id: bad\ntarget: video-production\napplies_when: selected('encode')\n"
      + 'patch:\n  - op: replace\n    path: nodes.3.maxVisits\n    value: 1\n');
    expect(run(CHECK, [OK, '--check-overlays', dir2])).toBe(1);
  });

  // ⛔⭐ 15차 리뷰 ①② — 「내가 지은 검사」가 op 목록을 안 봤고 «인용된 path» 를 놓쳤다.
  //   ⇒ 이제 실제 소비자(`parseGraphOverlayYaml`)를 부른다. 그 파서가 지키는 것을 같이 누른다.
  it('지원하지 않는 op 은 exit 1 이다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-ovl-op-'));
    writeFileSync(join(dir, 'a.yaml'),
      readFileSync(join(OVL, 'profile-gui-app.yaml'), 'utf8').replace(/op: replace/g, 'op: bogus'));
    expect(run(CHECK, [...ALL, '--check-overlays', dir])).toBe(1);
  });

  it('인용된 path 도 인덱스를 «본다» — 범위 밖이면 exit 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-ovl-q-'));
    writeFileSync(join(dir, 'a.yaml'),
      readFileSync(join(OVL, 'profile-gui-app.yaml'), 'utf8')
        .replace('path: /nodes/7/maxVisits', 'path: "/nodes/999/maxVisits"'));
    expect(run(CHECK, [...ALL, '--check-overlays', dir])).toBe(1);
  });

  it('stage 가 없거나 틀리면 exit 1 이다 — 파서가 지키는 것을 같이 받는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-ovl-s-'));
    writeFileSync(join(dir, 'a.yaml'),
      readFileSync(join(OVL, 'profile-gui-app.yaml'), 'utf8').replace('stage: runtime', 'stage: nope'));
    expect(run(CHECK, [...ALL, '--check-overlays', dir])).toBe(1);
  });

  it('오버레이 계약(overlay_id·applies_when·patch)이 비면 exit 1 이다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-ovl-c-'));
    writeFileSync(join(dir, 'empty.yaml'), 'overlay_id: x\ntarget: video-production\nstage: runtime\npatch: []\n');
    expect(run(CHECK, [OK, '--check-overlays', dir])).toBe(1);
  });

  it('오버레이가 하나도 없는 디렉터리는 exit 2 다', () => {
    expect(run(CHECK, [OK, '--check-overlays', mkdtempSync(join(tmpdir(), 'vp-ovl3-'))])).toBe(2);
  });
});

// ⛔ 7차 리뷰(should-fix) — 수용 기준에 있는데 시험이 «안 눌렀다». 목적지를 임시 디렉터리로 주입해 누른다.
describe('link-repo-skills.sh — 스킬이 로더에 닿나', () => {
  const SH = join(HERE, 'link-repo-skills.sh');

  function sh(args: string[], dest: string): number {
    const r = spawnSync('bash', [SH, ...args], {
      cwd: REPO, encoding: 'utf8', timeout: 90_000,
      env: { ...process.env, ELANOUS_SKILLS_DIR: dest },
    });
    if (r.status === null) throw new Error(`죽었다(signal=${r.signal})`);
    return r.status;
  }

  it('빈 목적지는 «안 닿는다» — exit 1', () => {
    expect(sh(['--check'], mkdtempSync(join(tmpdir(), 'vp-sk-')))).toBe(1);
  });

  it('걸고 나면 닿는다 — exit 0', () => {
    const dest = mkdtempSync(join(tmpdir(), 'vp-sk2-'));
    expect(sh(['--all'], dest)).toBe(0);
    expect(sh(['--check'], dest)).toBe(0);
  });

  it('모르는 인자는 exit 2 다', () => {
    const dest = mkdtempSync(join(tmpdir(), 'vp-sk3-'));
    expect(sh(['--bogus'], dest)).toBe(2);
    expect(sh(['--check', 'a', 'b'], dest)).toBe(2);
  });

  // ⛔⭐ 21차 리뷰 — 기본이 «저장소의 모든 스킬»을 사람 홈에 링크했다. 그것은 운영 변경이다.
  //   🔑 ***넓은 운영 변경은 «명시»해야 일어난다.***
  it('인자 «없이는» 아무것도 안 잇는다 — exit 2', () => {
    expect(sh([], mkdtempSync(join(tmpdir(), 'vp-sk5-')))).toBe(2);
  });

  it('이름을 대면 그 하나만 잇는다', () => {
    const dest = mkdtempSync(join(tmpdir(), 'vp-sk6-'));
    expect(sh(['video-builder'], dest)).toBe(0);
    expect(existsSync(join(dest, 'video-builder'))).toBe(true);
    expect(existsSync(join(dest, 'grill-me'))).toBe(false);   // ⭐ 남의 것은 «안» 건드린다
  });

  it('--all 은 전부 잇는다 — 명시했을 때만', () => {
    const dest = mkdtempSync(join(tmpdir(), 'vp-sk7-'));
    expect(sh(['--all'], dest)).toBe(0);
    expect(existsSync(join(dest, 'grill-me'))).toBe(true);
  });

  it('없는 이름은 exit 2 다 — 「0건」을 「전부 통과」로 읽지 않는다', () => {
    expect(sh(['--check', 'no-such-skill'], mkdtempSync(join(tmpdir(), 'vp-sk8-')))).toBe(2);
  });

  // ⛔ 5차에 이 도구가 «자기 소스 안»에 재귀 링크를 쌌다. 그 자리를 시험으로 못 박는다.
  it('정본 «안»에 링크를 만들지 않는다', () => {
    const dest = mkdtempSync(join(tmpdir(), 'vp-sk4-'));
    expect(sh(['--all'], dest)).toBe(0);
    expect(existsSync(join(REPO, 'skills/video-builder/video-builder'))).toBe(false);
  });
});

// ⛔⭐ 9차 리뷰 ⑤ — ***파싱 성공은 계약 충족이 아니다.*** 유효한 JSON 인데 의미가 깨진 설정이
//   exit 0 으로 지나가면, 그 값은 계획에서 «아무 데도 안 걸려» 조용히 무시된다.
describe('설정 스키마 — 외부 입력은 enum 까지 누른다', () => {
  function cfgFile(json: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'vp-cfg-'));
    const f = join(dir, 'video-tools.json');
    writeFileSync(f, json);
    return f;
  }

  it('prefer 가 없는 계층이면 exit 2 다', () => {
    expect(run(CLI, ['config', '--config', cfgFile('{"prefer":"not-a-tier"}')])).toBe(2);
  });

  it('impl 의 tier·probe.kind 가 없는 값이면 exit 2 다', () => {
    expect(run(CLI, ['probe', '--config', cfgFile(
      '{"capabilities":{"x":{"what":"y","impls":[{"id":"i","tier":"nope","probe":{"kind":"bad","value":"v"}}]}}}',
    )])).toBe(2);
  });

  it('machines.have 가 배열이 아니면 exit 2 다', () => {
    expect(run(CLI, ['probe', '--config', cfgFile('{"machines":{"m":{"have":"ffmpeg"}}}')])).toBe(2);
  });

  // ⛔ 10차 리뷰 ④ — 배열도 `Object.entries` 가 «돌기» 때문에 빈 배열이 0회 돌고 통과했다.
  //   🔑 「반복된다」를 「맵이다」로 읽지 않는다.
  it('맵이어야 할 자리에 배열이 오면 exit 2 다', () => {
    for (const j of ['{"machines":[]}', '{"impls":[]}', '{"capabilities":[]}']) {
      expect(run(CLI, ['probe', '--config', cfgFile(j)])).toBe(2);
    }
  });

  it('have/missing 의 «원소»가 문자열이 아니면 exit 2 다', () => {
    expect(run(CLI, ['probe', '--config', cfgFile('{"machines":{"m":{"have":[1,2]}}}')])).toBe(2);
  });

  // ⛔ 11차 리뷰 ② — 10차엔 «최상위»만 봤다. `typeof [] === 'object'` 라 한 층 아래서 같은 구멍이 났다.
  it('중첩된 자리의 배열도 exit 2 다', () => {
    for (const j of ['{"machines":{"bad":[]}}', '{"capabilities":{"x":[]}}', '{"impls":{"bad":[]}}']) {
      expect(run(CLI, ['probe', '--config', cfgFile(j)])).toBe(2);
    }
  });

  // ⛔ 11차 리뷰 ③ — capability 꼴이 틀리면 그 구현이 «조용히 버려진다».
  it('impls.*.capability 가 문자열이 아니면 exit 2 다', () => {
    expect(run(CLI, ['probe', '--config', cfgFile(
      '{"impls":{"bad":{"capability":123,"tier":"free","probe":{"kind":"cmd","value":"x"}}}}',
    )])).toBe(2);
    expect(run(CLI, ['probe', '--config', cfgFile(
      '{"impls":{"ok":{"capability":"encode","tier":"free","probe":{"kind":"cmd","value":"x"}}}}',
    )])).toBe(0);
  });

  // ⛔ 빨간 길만 있으면 「전부 거부하는 자」와 구분이 안 된다 — 초록 길을 같이 둔다.
  it('올바른 설정은 통과한다', () => {
    expect(run(CLI, ['probe', '--config', cfgFile(
      '{"prefer":"free","machines":{"m":{"detect":false,"have":["ffmpeg-encode"]}}}',
    ), '--machine', 'm'])).toBe(0);
  });

  // ⛔ 13차 리뷰 ④ — `have: ["not-an-impl"]` 이 통과하면 그 기계는 «전부 없음»으로 계획된다.
  it('have/missing 이 «레지스트리에 없는» impl id 를 대면 exit 2 다', () => {
    expect(run(CLI, ['probe', '--config', cfgFile(
      '{"machines":{"m":{"detect":false,"have":["not-an-impl"]}}}'), '--machine', 'm'])).toBe(2);
    expect(run(CLI, ['probe', '--config', cfgFile(
      '{"machines":{"m":{"detect":false,"missing":["not-an-impl"]}}}'), '--machine', 'm'])).toBe(2);
  });

  // ⭐ 기준은 «설정 병합 후»의 레지스트리다 — 사용자가 추가한 impl 은 막지 않는다.
  // ⛔ 16차 리뷰(should-fix) — 같은 id 가 have 와 missing 에 둘 다면 결과가 «호출 순서»에 달린다.
  it('have 와 missing 에 같은 id 가 둘 다 있으면 exit 2 다', () => {
    expect(run(CLI, ['probe', '--config', cfgFile(
      '{"machines":{"m":{"detect":false,"have":["ffmpeg-encode"],"missing":["ffmpeg-encode"]}}}'),
      '--machine', 'm'])).toBe(2);
  });

  it('설정이 «추가한» impl id 는 통과한다', () => {
    expect(run(CLI, ['probe', '--config', cfgFile(
      '{"capabilities":{"z":{"what":"w","impls":[{"id":"my-tool","tier":"free",'
      + '"probe":{"kind":"cmd","value":"ls"}}]}},"machines":{"m":{"detect":false,"have":["my-tool"]}}}',
    ), '--machine', 'm'])).toBe(0);
  });

  // ⛔ 모르는 키는 «막지 않는다» — 설정이 자라야 한다(의도적 결정).
  it('모르는 키는 통과한다', () => {
    expect(run(CLI, ['probe', '--config', cfgFile('{"prefer":"free","futureKey":123}')])).toBe(0);
  });
});

// ⛔⭐ 14차 리뷰 ② — ***실측과 가정을 갈라 적는다.*** `detect:false` 는 「재지 않았다」는 뜻이고,
//   그 아래의 「구멍 없음」은 사실이 아니라 «프로파일의 주장»이다.
describe('plan — 가정을 사실로 단언하지 않는다', () => {
  function cfg(json: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'vp-assume-'));
    const f = join(dir, 'video-tools.json');
    writeFileSync(f, json);
    return f;
  }
  const ASSUME = '{"machines":{"m":{"detect":false,"have":["ffmpeg-encode"]}}}';

  // ⛔ 15차 리뷰 ③ — 가정 표기를 «한 갈래»에만 붙였더니 미확인 갈래로 새면 사라졌다.
  it('«호스트 미확인» 갈래에서도 가정 표기가 살아 있다', () => {
    const c = cfg('{"impls":{"assumed-mcp":{"capability":"encode","tier":"free",'
      + '"probe":{"kind":"mcp","value":"x"}}},"machines":{"m":{"detect":false,"have":["assumed-mcp"]}}}');
    for (const extra of [[], ['--surface', 'tui']]) {
      const t = out(CLI, ['plan', '--from', 'render', '--to', 'render', '--machine', 'm', '--config', c, ...extra]);
      expect(t).toContain('호스트 미확인');
      expect(t).toContain('가정');
    }
  });

  // ⛔⭐ 17차 리뷰 ② — 사람 글에만 붙이고 ***JSON 엔 안 붙였다***. 기계가 더 위험한 쪽이다.
  //   🔑 ***출처는 렌더가 아니라 «값»이다.***
  // ⛔⭐ 18차 리뷰 ① — 「가정」을 ***세 번*** 따로 붙였고 세 번째도 샜다(probe compact).
  //   🔑 갈래마다 붙이는 한 반드시 «다음 갈래»가 남는다 ⇒ 한 함수로 만들고, ***전 조합***을 누른다.
  it('probe 도 «모든» 서피스에서 가정을 말한다', () => {
    const c = cfg(ASSUME);
    for (const extra of [[], ['--surface', 'tui'], ['--surface', 'telegram']]) {
      expect(out(CLI, ['probe', '--machine', 'm', '--config', c, ...extra])).toContain('가정');
    }
    // ⛔ 빨간 길의 반대쪽 — 재서 얻었으면 그 줄이 «없어야» 한다
    expect(out(CLI, ['probe'])).not.toContain('가정');
  });

  // 🪞 그 수리가 «다른 계약»을 깰 뻔했다 — JSON 앞에 한 줄이 붙어 jq 가 죽었다.
  it('JSON 은 그 줄을 «앞에» 찍지 않는다 — stdout 이 JSON 이어야 한다', () => {
    const c = cfg(ASSUME);
    for (const args of [['probe', '--json', '--machine', 'm', '--config', c],
                        ['plan', '--json', '--from', 'deliver', '--to', 'deliver', '--machine', 'm', '--config', c]]) {
      expect(() => JSON.parse(outJson(CLI, args))).not.toThrow();
    }
  });

  it('원격 도구를 못 물어본 plan --json 도 stdout 에 JSON 만 낸다', () => {
    const r = spawnSync('bun', [CLI, 'plan', '--from', 'ground', '--to', 'deliver', '--json'], {
      cwd: REPO, encoding: 'utf8', timeout: 90_000,
      env: { ...process.env, ELANOUS_VIDEO_SKIP_REMOTE_PROBE: '1' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trimStart().startsWith('{')).toBe(true);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });

  it('JSON 계약이 «출처»를 싣는다 — probe·plan 둘 다', () => {
    const c = cfg(ASSUME);
    for (const args of [['probe', '--json', '--machine', 'm', '--config', c],
                        ['plan', '--json', '--from', 'deliver', '--to', 'deliver', '--machine', 'm', '--config', c]]) {
      const j = JSON.parse(outJson(CLI, args)) as { source: { detected: boolean; overrides: string[] } };
      expect(j.source.detected).toBe(false);
      expect(j.source.overrides).toContain('machines.m.have');
    }
  });

  // ⛔⭐ 19차 리뷰 — 「재지 않았다」의 갈래가 ***둘 이상***이었다. `--assume-missing` 은
  //   결과를 «반사실적으로» 바꾸는데 `detected: true` 로 나갔다 — ***거짓 실측 주장***이다.
  it('--assume-missing 도 «재기를 대신한 것»으로 적힌다', () => {
    const c = cfg('{"impls":{"forced":{"capability":"encode","tier":"free",'
      + '"probe":{"kind":"cmd","value":"ls"}}}}');
    const j = JSON.parse(outJson(CLI, ['probe', '--json', '--config', c, '--assume-missing', 'forced'])) as
      { source: { detected: boolean; overrides: string[] } };
    expect(j.source.detected).toBe(false);
    expect(j.source.overrides).toContain('--assume-missing=forced');
  });

  // ⛔ `missing` 만 쓴 프로파일에 `.have` 라 적히던 것 — 출처는 «적용된 것»을 가리켜야 한다
  it('출처는 «실제로 적용된» 덮개를 가리킨다', () => {
    const j = JSON.parse(outJson(CLI, ['probe', '--json', '--machine', 'm', '--config',
      cfg('{"machines":{"m":{"detect":false,"missing":["ffmpeg-encode"]}}}')])) as
      { source: { overrides: string[] } };
    expect(j.source.overrides).toEqual(['machines.m.missing']);
  });

  it('재서 얻었으면 detected 가 true 다 — 빨간 길의 반대쪽', () => {
    const j = JSON.parse(outJson(CLI, ['probe', '--json'])) as { source: { detected: boolean; overrides: string[] } };
    expect(j.source.detected).toBe(true);
    expect(j.source.overrides).toEqual([]);
  });

  it('detect:false 면 «가정»이라고 말한다 — 두 서피스 모두', () => {
    for (const extra of [[], ['--surface', 'tui']]) {
      const t = out(CLI, ['plan', '--from', 'deliver', '--to', 'deliver',
        '--machine', 'm', '--config', cfg(ASSUME), ...extra]);
      expect(t).toContain('구멍 없음');
      expect(t).toContain('가정');                       // ⭐ 이 낱말이 사라지면 그것이 결함이다
      expect(t).not.toContain('지금 기계에서 «끝까지» 돈다');
    }
  });

  it('프로파일 없이는 «가정» 표기가 붙지 않는다 — 빨간 길의 반대쪽', () => {
    expect(out(CLI, ['plan', '--from', 'deliver', '--to', 'deliver'])).not.toContain('프로파일');
  });
});

// ⛔⭐ 14차 리뷰 ③ — `impls.<id>` 는 «기존 impl 을 덮는» patch 다. 어디에도 안 붙으면 조용히 버려진다.
describe('설정의 impl 이 «어디에 붙나»', () => {
  function cfgFile2(json: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'vp-impl-'));
    const f = join(dir, 'video-tools.json');
    writeFileSync(f, json);
    return f;
  }

  it('기존 id 도 아니고 capability 도 없으면 exit 2 다', () => {
    expect(run(CLI, ['config', '--config', cfgFile2(
      '{"impls":{"typo":{"tier":"free","probe":{"kind":"cmd","value":"x"}}}}')])).toBe(2);
  });

  it('없는 능력에 붙이려 하면 exit 2 다', () => {
    expect(run(CLI, ['config', '--config', cfgFile2(
      '{"impls":{"newone":{"capability":"nope","tier":"free","probe":{"kind":"cmd","value":"x"}}}}')])).toBe(2);
  });

  it('새 impl 이 tier·probe 없이 붙으려 하면 exit 2 다', () => {
    expect(run(CLI, ['config', '--config', cfgFile2(
      '{"impls":{"newone":{"capability":"encode"}}}')])).toBe(2);
  });

  // ⛔ 초록 길 둘 — 「전부 거부하는 자」와 구분한다.
  it('능력을 제대로 댄 새 impl 과 기존 impl 덮기는 통과한다', () => {
    expect(run(CLI, ['config', '--config', cfgFile2(
      '{"impls":{"newone":{"capability":"encode","tier":"free","probe":{"kind":"cmd","value":"x"}}}}')])).toBe(0);
    expect(run(CLI, ['config', '--config', cfgFile2(
      '{"impls":{"ffmpeg-encode":{"note":"덮기"}}}')])).toBe(0);
  });
});

// ⛔⭐ 15차 리뷰 ④ — ***관문은 자기가 쓰는 것만 막아야 한다.***
//   설정을 «모든 서브커맨드보다 먼저» 실어서, 환경의 깨진 설정 하나가 설정을 쓰지도 않는
//   `drift`·`spine` 까지 막았다. ⇒ 관문 자신이 고장의 원인이 됐다.
describe('설정 실패는 «그 설정을 쓰는» 명령만 막는다', () => {
  function brokenEnv(): Record<string, string> {
    const dir = mkdtempSync(join(tmpdir(), 'vp-env-'));
    const f = join(dir, 'video-tools.json');
    writeFileSync(f, '{');
    return { ...process.env as Record<string, string>, ELANOUS_VIDEO_TOOLS: f };
  }
  function runEnv(args: string[]): number {
    const r = spawnSync('bun', [CLI, ...args], { cwd: REPO, encoding: 'utf8', timeout: 90_000, env: brokenEnv() });
    if (r.status === null) throw new Error(`죽었다(signal=${r.signal})`);
    return r.status;
  }

  it('설정을 안 쓰는 명령은 «넘어간다»', () => {
    expect(runEnv(['drift'])).toBe(0);
    expect(runEnv(['spine'])).toBe(0);
  });

  // ⛔⭐ 16차 리뷰 ① — 15차는 «적재 실패»만 미루고 ***「의미 검증」은 그대로 뒀다***. 반쪽 수리였다.
  //   🔑 고칠 때는 「같은 이유로 도는 것」을 «전수»로 찾는다.
  it('«의미상» 깨진 설정도 안 쓰는 명령은 못 막는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-env2-'));
    const f = join(dir, 'video-tools.json');
    writeFileSync(f, '{"machines":{"m":{"detect":false,"have":["not-an-impl"]}}}');
    const env = { ...process.env as Record<string, string>, ELANOUS_VIDEO_TOOLS: f };
    for (const [c, want] of [['drift', 0], ['spine', 0], ['probe', 2], ['config', 2]] as const) {
      const r = spawnSync('bun', [CLI, c], { cwd: REPO, encoding: 'utf8', timeout: 90_000, env });
      expect(r.status).toBe(want);
    }
  });

  it('설정을 쓰는 명령은 exit 2 다', () => {
    for (const c of ['probe', 'plan', 'config']) expect(runEnv([c])).toBe(2);
  });
});

// ⛔⭐ 15차 리뷰 ⑥ — ***아는 이름을 «아무 값»으로 받는 것은 모르는 이름을 받는 것보다 나쁘다.***
//   모르는 이름은 버려지지만, 아는 이름은 «틀린 값으로 쓰인다»(`hasFreeQuota: "yes"` 는 늘 참).
describe('아는 필드의 타입 계약', () => {
  function cfgFile3(json: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'vp-ft-'));
    const f = join(dir, 'video-tools.json');
    writeFileSync(f, json);
    return f;
  }

  it('hasFreeQuota 는 불리언이다', () => {
    expect(run(CLI, ['config', '--config', cfgFile3('{"impls":{"ffmpeg-encode":{"hasFreeQuota":"yes"}}}')])).toBe(2);
    expect(run(CLI, ['config', '--config', cfgFile3('{"impls":{"ffmpeg-encode":{"hasFreeQuota":true}}}')])).toBe(0);
  });

  it('provider·quotaProbe·unitCost·note 는 문자열이다', () => {
    for (const k of ['provider', 'quotaProbe', 'unitCost', 'note']) {
      expect(run(CLI, ['config', '--config', cfgFile3(`{"impls":{"ffmpeg-encode":{"${k}":123}}}`)])).toBe(2);
    }
    expect(run(CLI, ['config', '--config', cfgFile3('{"impls":{"ffmpeg-encode":{"note":"덮기"}}}')])).toBe(0);
  });
});

// ⛔⭐⭐ 「이 시험들이 작업트리에 쓰나」는 리뷰에서 ***여섯 판 연속*** 나왔다(문맥이 잘려 못 본다).
//   ⇒ 사람이 「확인했다」고 답하는 대신 ***시험이 스스로 답하게 한다.***
//   🔑 반복되는 물음은 「다시 설명할 것」이 아니라 ***「기계가 답할 자리를 만들 것」***이다.
describe('이 시험들은 작업트리를 «안» 건드린다', () => {
  // ⛔⭐ 22차 리뷰(should-fix) — `git status --porcelain` 은 ***이미 수정된 tracked 파일의
  //   «내용이 더 바뀌어도» 같은 문자열***을 낸다. ⇒ 「상태」가 아니라 «내용»을 잰다.
  function treeFingerprint(): string {
    const st = spawnSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8', timeout: 30_000 });
    const diff = spawnSync('git', ['diff', '--stat'], { cwd: REPO, encoding: 'utf8', timeout: 30_000 });
    return `${st.stdout ?? ''}\u0000${diff.stdout ?? ''}`;
  }
  const gitStatus = treeFingerprint;

  it('CLI 를 여러 번 돌려도 작업트리 «내용»이 그대로다', () => {
    const before = treeFingerprint();
    // 설정을 쓰는 것 · 안 쓰는 것 · 실패하는 것을 섞어 돌린다
    run(CLI, ['probe']);
    run(CLI, ['drift']);
    run(CLI, ['spine']);
    run(CLI, ['plan', '--need', 'caption']);
    run(CLI, ['plan', '--need']);                       // exit 2 경로
    run(CHECK, [join(REPO, DECL_REL)]);
    expect(treeFingerprint()).toBe(before);
  });

  it('설정 픽스처는 «임시 디렉터리»에만 쓴다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-proof-'));
    const f = join(dir, 'video-tools.json');
    writeFileSync(f, '{"prefer":"free"}');
    // ⭐ 저장소 «밖»임을 값으로 확인한다 — 「그럴 것이다」가 아니라 「그렇다」로
    expect(f.startsWith(REPO)).toBe(false);
    expect(run(CLI, ['probe', '--config', f])).toBe(0);
    expect(gitStatus()).not.toContain('video-tools.json');
  });
});

// ⛔⭐⭐ `ssh` probe — ***종전 probe 셋은 전부 «이 기계»를 전제했다.***
//   🔑 AX 현장의 실제 모습은 「이 노트북엔 없고 사무실 맥스튜디오엔 있다」이고,
//      그것을 「없다」로 접으면 ***무료로 할 수 있는 일을 유료로 보낸다.***
//   ⛔ 그래서 결과가 «셋»이다 — true · false · ***null(못 쟀다)***.
describe('ssh probe — 「없다」와 「못 쟀다」를 가른다', () => {
  function probeExit(value: string): string {
    const r = spawnSync('bun', ['-e', `
      const { execFileSync } = await import('node:child_process');
      const v = ${JSON.stringify(value)};
      const i = v.indexOf(':'); const h = v.slice(0, i), p = v.slice(i + 1);
      try { execFileSync('ssh', ['-o','BatchMode=yes','-o','ConnectTimeout=5', h, 'test -x ' + p],
            { stdio: 'ignore', timeout: 20000 }); console.log('true'); }
      catch (e) { console.log((e).status === 1 ? 'false' : 'null'); }
    `], { cwd: REPO, encoding: 'utf8', timeout: 60_000 });
    return (r.stdout ?? '').trim();
  }

  // ⛔ 붙을 수 «없는» 호스트는 언제나 재현된다 — 이 줄은 네트워크에 안 기댄다.
  it('못 붙는 호스트는 «못 쟀다»(null)다 — false 가 아니다', () => {
    expect(probeExit('nosuchhost-zzz-does-not-exist:/bin/ls')).toBe('null');
  });

  // ⛔ 꼴이 틀린 값도 «못 쟀다»다 — 「없다」로 접으면 설정 오타가 「도구 없음」이 된다.
  it('호스트:경로 꼴이 아니면 «못 쟀다»다', () => {
    const r = spawnSync('bun', ['-e', `
      const v = 'no-colon-here';
      console.log(v.indexOf(':') <= 0 ? 'null' : 'parsed');
    `], { cwd: REPO, encoding: 'utf8', timeout: 30_000 });
    expect((r.stdout ?? '').trim()).toBe('null');
  });

  it('레지스트리가 ssh 갈래를 «가진다» — free 이미지 생성이 그 위에 선다', async () => {
    const { CAPABILITIES } = await import('../src/video-pipeline/capabilities.js');
    const gen = CAPABILITIES.find((c) => c.id === 'image-gen');
    const free = gen?.impls.filter((i) => i.tier === 'free') ?? [];
    expect(free.length).toBeGreaterThan(0);          // ⭐ 종전엔 0이었다(전부 metered)
    expect(free.some((i) => i.probe.kind === 'ssh')).toBe(true);
  });
});

// ⛔⭐ 원격 생성의 «세 갈래» — ok · error · ***unmeasurable***.
//   🔑 「호스트가 꺼져 있다」를 「못 만든다」로 접으면 ***무료 경로가 통째로 사라진다.***
describe('원격 무료 생성 — 실패를 «셋»으로 가른다', () => {
  it('ssh 가 PATH 에 없으면 «못 물어봤다»다 — 실행 실패를 원격 실패로 부르지 않는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-no-ssh-'));
    const bunPath = process.execPath;
    const r = spawnSync(bunPath, ['-e', `
      import { sshRun } from ${JSON.stringify(join(REPO, 'src/video-pipeline/recipes/remote.ts'))};
      console.log(JSON.stringify(sshRun('nosuchhost-zzz-does-not-exist', 'echo hi', 30000)));
    `], { cwd: REPO, encoding: 'utf8', timeout: 30_000, env: { ...process.env, PATH: dir } });
    try {
      expect(r.status).toBe(0);
      const result = JSON.parse(r.stdout) as { kind: string; why: string };
      expect(result.kind).toBe('unmeasurable');
      expect(result.why).toContain('못 붙었다');
      expect(result.why).toContain('ssh 를 실행할 수 없다');
      expect(result.why).toMatch(/ENOENT|Executable not found/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('scp 가 PATH 에 없으면 «못 물어봤다»다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-no-scp-'));
    const r = spawnSync(process.execPath, ['-e', `
      import { scpFrom } from ${JSON.stringify(join(REPO, 'src/video-pipeline/recipes/remote.ts'))};
      console.log(JSON.stringify(scpFrom('nosuchhost-zzz-does-not-exist', '/file', ${JSON.stringify(join(dir, 'file'))})));
    `], { cwd: REPO, encoding: 'utf8', timeout: 30_000, env: { ...process.env, PATH: dir } });
    try {
      expect(r.status).toBe(0);
      const result = JSON.parse(r.stdout) as { kind: string; why: string };
      expect(result.kind).toBe('unmeasurable');
      expect(result.why).toContain('못 붙었다');
      expect(result.why).toContain('scp 를 실행할 수 없다');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('scp 가 실행된 뒤 0 아닌 종료 코드는 여전히 error 다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-scp-exit-'));
    const scp = join(dir, 'scp');
    writeFileSync(scp, '#!/bin/sh\necho transfer-failed >&2\nexit 7\n');
    chmodSync(scp, 0o755);
    const r = spawnSync(process.execPath, ['-e', `
      import { scpFrom } from ${JSON.stringify(join(REPO, 'src/video-pipeline/recipes/remote.ts'))};
      console.log(JSON.stringify(scpFrom('localhost', '/file', ${JSON.stringify(join(dir, 'file'))})));
    `], { cwd: REPO, encoding: 'utf8', timeout: 30_000, env: { ...process.env, PATH: dir } });
    try {
      expect(r.status).toBe(0);
      const result = JSON.parse(r.stdout) as { kind: string; why: string };
      expect(result.kind).toBe('error');
      expect(result.why).toContain('transfer-failed');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('붙은 뒤 원격 명령의 0 아닌 종료 코드는 여전히 error 다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-ssh-exit-'));
    const ssh = join(dir, 'ssh');
    writeFileSync(ssh, '#!/bin/sh\necho remote-command-failed >&2\nexit 7\n');
    chmodSync(ssh, 0o755);
    const r = spawnSync(process.execPath, ['-e', `
      import { sshRun } from ${JSON.stringify(join(REPO, 'src/video-pipeline/recipes/remote.ts'))};
      console.log(JSON.stringify(sshRun('localhost', 'exit 7', 30000)));
    `], { cwd: REPO, encoding: 'utf8', timeout: 30_000, env: { ...process.env, PATH: dir } });
    try {
      expect(r.status).toBe(0);
      const result = JSON.parse(r.stdout) as { kind: string; why: string };
      expect(result.kind).toBe('error');
      expect(result.why).toContain('remote-command-failed');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('못 붙는 호스트는 «못 물어봤다»다 — 실패가 아니다', async () => {
    const { sshRun } = await import('../src/video-pipeline/recipes/remote.js');
    const r = sshRun('nosuchhost-zzz-does-not-exist', 'echo hi', 30_000);
    expect(r.kind).toBe('unmeasurable');
    expect(r.why ?? '').toContain('못 붙었다');
  });

  // ⛔ 종합 러너의 종료코드도 «넷»으로 갈린다 — 그것이 이 축의 계약이다.
  it('종합 러너: 준비 실패는 3 · 못 물어봤다는 2', () => {
    const CLI2 = join(HERE, 'video-full-line.ts');
    const run2 = (a: string[]): number => {
      const r = spawnSync('bun', [CLI2, ...a], { cwd: REPO, encoding: 'utf8', timeout: 180_000 });
      if (r.status === null) throw new Error(`죽었다(signal=${r.signal})`);
      return r.status;
    };
    expect(run2([])).toBe(3);                                   // 장면 파일 없음
    expect(run2(['--scene-file', '/nope.json'])).toBe(3);
    expect(run2(['--bogus', 'x'])).toBe(3);
    expect(run2(['--scene-file', join(REPO, 'graphs/video/scenes/elanvital-ad.json'),
                 '--host', 'nosuchhost-zzz-does-not-exist'])).toBe(2);
  });

  it('ssh 가 PATH 에 없는 종합 러너도 못 물어봤다로 종료 코드 2 를 낸다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-full-no-ssh-'));
    try {
      const r = spawnSync(process.execPath, [join(HERE, 'video-full-line.ts'),
        '--scene-file', join(REPO, 'graphs/video/scenes/elanvital-ad.json'),
        '--host', 'nosuchhost-zzz-does-not-exist'], {
        cwd: REPO, encoding: 'utf8', timeout: 90_000, env: { ...process.env, PATH: dir },
      });
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(2);
      expect(`${r.stdout}${r.stderr}`).toContain('못 붙었다');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('장면 파일이 계약을 지킨다 — 장면 둘 이상 ⊕ 각 장면에 프롬프트와 자막', () => {
    const s = JSON.parse(readFileSync(join(REPO, 'graphs/video/scenes/elanvital-ad.json'), 'utf8')) as
      { scenes: { prompt: string; caption: string }[]; voiceInstruct: string };
    expect(s.scenes.length).toBeGreaterThanOrEqual(2);
    for (const sc of s.scenes) {
      expect(sc.prompt.length).toBeGreaterThan(20);
      expect(sc.caption.length).toBeGreaterThan(0);
    }
    // ⛔ VoiceDesign 은 instruct 가 «필수»다 — 없으면 모델이 거부한다(실측 2026-09-22).
    expect(s.voiceInstruct.length).toBeGreaterThan(20);
  });
});

describe('🖥️ 플랫폼 — ⛔ 「깔면 된다」와 「이 기계에선 «영영» 안 된다」를 섞지 않는다', () => {
  // 🩸 계기: 🅢 님이 «출시 블로커»를 실측해 보고했다 —
  //   *"리눅스·WSL 에 PTY 가 통째로 없고 doctor 가 ***한 마디도 안 한다***"*.
  //   📏 그 말을 내 축에 대고 재 보니 이 레지스트리에 ***플랫폼 칸이 «0개»***였다.

  it('리눅스에서 macOS 전용 구현을 «이름으로» 말한다 — probe', () => {
    const o = outAsPlatform('linux', ['probe']);
    expect(o).toContain('darwin 전용');
    expect(o).toContain('sips');
    // ⛔ 「깔면 되나」를 못 묻게 하면 안 된다 — 그 문장이 있어야 한다.
    expect(o).toContain('깔아서 될 일이 «아니다»');
  });

  it('plan 도 같은 말을 한다 — ⛔ 한 서피스에만 있으면 «반드시» 샌다', () => {
    const o = outAsPlatform('linux', ['plan', '--from', 'ground', '--to', 'deliver']);
    expect(o).toContain('darwin 전용');
  });

  it('⛔ JSON 서피스에도 있다 — 기계가 읽는 계약에서 사라지면 안 된다', () => {
    const j = JSON.parse(outAsPlatform('linux', ['probe', '--json']).trim()) as
      { platform: string; wrongPlatform: { id: string; need: string }[] };
    expect(j.platform).toBe('linux');
    expect(j.wrongPlatform.length).toBeGreaterThan(0);
    expect(j.wrongPlatform.some((w) => w.id === 'sips' && w.need === 'darwin')).toBe(true);
  });

  it('✅ macOS 에서는 «아무 말도 안 한다» — 자가 아무 데서나 짖으면 안 된다', () => {
    const o = outAsPlatform('darwin', ['probe']);
    expect(o).not.toContain('darwin 전용');
  });
});

// ⛔⭐ 2026-09-22 — 「칸 이름 ≠ 계산」 회귀.
//   종전 사람 화면은 `every(tier==='free')` 를 재고 라벨은 「무료만으로 채워지는 능력」이라 적었다.
//   읽는 사람은 그것을 `some`(무료로 «될 수 있다»)으로 읽는다 — 실측 차이가 ***3 대 16*** 이었고,
//   정작 결정을 가르는 「과금이 강제되는 능력」은 ***한 줄도 안 찍혔다.***
//   🔑 옛 코드가 삼킨 칸은 ***무료와 유료를 «둘 다» 가진 능력***이다 — 그 칸을 먼저 못 박는다.
describe('summarizeTiers — 무료 도달 가능성', () => {
  const R = (cap: string, ...tiers: ('free' | 'owned' | 'metered')[]) =>
    ({ cap, found: tiers.map((tier) => ({ tier })) });

  it('⛔ 무료 ⊕ 유료를 «둘 다» 가진 능력 — 도달 가능이지 「무료뿐」이 아니다', () => {
    const s = summarizeTiers([R('mix', 'free', 'metered')]);
    expect(s.freeReachable).toEqual(['mix']);   // 무료로 갈 수 «있다»
    expect(s.freeOnly).toEqual([]);             // 그러나 무료 «뿐»은 아니다
    expect(s.paidOnly).toEqual([]);             // 과금이 «강제»되지도 않는다
  });

  it('💳 무료가 하나도 없으면 과금이 강제된다 — 이 수가 「크레딧 0」을 가른다', () => {
    const s = summarizeTiers([R('avatar', 'metered'), R('app', 'owned')]);
    expect(s.paidOnly).toEqual(['avatar', 'app']);
    expect(s.freeReachable).toEqual([]);
  });

  it('구현이 «없는» 능력은 셋 어디에도 안 들어가고 dead 로만 센다', () => {
    const s = summarizeTiers([R('gone')]);
    expect(s.dead).toEqual(['gone']);
    expect([...s.freeReachable, ...s.freeOnly, ...s.paidOnly]).toEqual([]);
  });

  it('freeOnly 는 언제나 freeReachable 의 부분집합이다', () => {
    const s = summarizeTiers([R('a', 'free'), R('b', 'free', 'owned'), R('c', 'owned')]);
    expect(s.freeOnly.every((c) => s.freeReachable.includes(c))).toBe(true);
    expect(s.freeReachable).toEqual(['a', 'b']);
    expect(s.freeOnly).toEqual(['a']);
    expect(s.paidOnly).toEqual(['c']);
  });
});

// ⛔⭐ 2026-09-22 — 「처방이 자리만 대고 값을 안 댄다」 회귀.
//   종전 구멍 처방은 *"도구를 설치하거나 · …"* 로 끝났다. ***어느 도구인지 말하지 않았다*** —
//   그런데 그 순간 도구는 선언 목록을 «이미 쥐고 있었다». 사람이 그것을 다시 찾아야 했다.
//   🔑 그리고 여기서 갈리는 축이 하나 더 있다: ***「무료가 선언돼 있나」***.
//      선언돼 있으면 «깔면 크레딧 0» 이 되고, 전부 유료면 깔아도 과금이 남는다 — 접으면 안 된다.
describe('plan 구멍 처방 — 자리가 아니라 값을 댄다', () => {
  const MISSING = ['plan', '--need', 'audio-mix', '--from', 'audio', '--to', 'audio', '--assume-missing', 'ffmpeg-audio,sox'];

  // ⚠️ 이름이 산출 «어딘가»에 있는 것으로는 못 잰다 — 옛 코드도 다른 절(「같은 능력의 다른 구현」)에서
  //   같은 이름을 찍었다. 실제로 이 시험의 첫 판이 «옛 코드에서도 통과»했다(t=0 에 이미 참).
  //   ⇒ 「구멍 처방 줄 «안»에 있나」로 묻는다.
  it('⛔ 구멍 처방 «줄 안»에 선언된 구현 이름이 있다', () => {
    const line = out(CLI, MISSING).split('\n').find((l) => l.includes('↳ 선언된 구현') && l.includes('ffmpeg-audio'));
    expect(line).toBeDefined();
    expect(line!).toContain('ffmpeg-audio');
    expect(line!).toContain('sox');
  });

  it('💡 무료가 «선언»돼 있으면 「깔면 크레딧 0」이라고 말한다', () => {
    const o = out(CLI, MISSING);
    expect(o).toContain('크레딧 0 이 된다');
  });

  it('⛔ JSON 서피스에도 있다 — gaps 계약은 그대로 두고 옆 칸으로 더한다', () => {
    const j = JSON.parse(outJson(CLI, [...MISSING, '--json'])) as {
      gaps: string[];
      gapDetail: { gap: string; cap: string; declared: { id: string; tier: string }[]; freeDeclared: boolean }[];
    };
    expect(j.gaps).toEqual(['audio/audio-mix']);
    const detail = j.gapDetail.find((d) => d.gap === 'audio/audio-mix');
    expect(detail).toBeDefined();
    expect(detail!.cap).toBe('audio-mix');
    expect(detail!.freeDeclared).toBe(true);
    expect(detail!.declared.map((d) => d.id).sort()).toEqual(['ffmpeg-audio', 'sox']);
    expect(j.gapDetail.map((d) => d.gap)).toEqual(j.gaps);
  });
});

// ⛔⭐ 2026-09-22 — `drive` 축이 «자기 자신과» 어긋나 있었다.
//   ⓐ `bridge-blender` 만 `drive` 가 비어 있었다(AE·Premiere 는 `app-attached`).
//      빈 칸은 headless 로 읽히므로 ***무인 런이 「앱 없이 부를 수 있다」고 믿는다*** — fail-open.
//      실측: 고치기 «전» handDriven 이 `[]` 였고, 고친 뒤 blender 가 들어왔다.
//   ⓑ 「호스트 미확인」 경고가 `probe.kind==='mcp'` 로 붙어 ***호스트가 «없는» 11개에도*** 붙었다.
//      호스트 축을 갖는 것은 `drive === 'app-attached'` 뿐이다.
describe('drive 축 — 앱이 떠 있어야 하는 것을 «빠짐없이» 센다', () => {
  const FORCE_BLENDER = ['plan', '--need', 'app-control',
    '--assume-missing', 'bridge-ae,bridge-premiere,affinity', '--json'];

  it('⛔ bridge-blender 를 고르면 «앱 필요»로 센다 — higgsfield-bridge 설정 필요', () => {
    const j = JSON.parse(configuredOut(FORCE_BLENDER)) as {
      stack: { picks: { cap: string; impl: string | null }[] }[];
      handDriven: { impl: string; drive: string }[];
    };
    const picked = j.stack.flatMap((o) => o.picks).filter((p) => p.cap === 'app-control').map((p) => p.impl);
    expect(picked).toContain('bridge-blender');          // 전제: 이 표본이 정말 blender 를 골랐다
    expect(j.handDriven.map((h) => h.impl)).toContain('bridge-blender');
    expect(j.handDriven.find((h) => h.impl === 'bridge-blender')?.drive).toBe('app-attached');
  });

  it('⚠️ 호스트 축이 «없는» 클라우드 MCP 에는 「앱」을 말하지 않는다 — higgsfield-bridge·topview 설정 필요', () => {
    const o = configuredOut(['probe']);
    const topview = o.split('\n').find((l) => l.includes('topview-canvas'));
    const bridge = o.split('\n').find((l) => l.includes('🔵owned') && l.includes('bridge-blender'));
    expect(topview).toBeDefined();
    expect(bridge).toBeDefined();
    expect(topview!).toContain('호스트 축 없음');
    expect(topview!).not.toContain('앱');      // ⛔ 붙을 앱이 «없는» 것에 앱을 말하지 않는다
    expect(bridge!).toContain('앱');            // ⭐ 붙을 앱이 «있는» 것에는 말한다
  });

  it('⛔ 「확인」이라 말하지 않는다 — MCP 서버 설정 필요', () => {
    const o = configuredOut(['probe']);
    expect(o).not.toContain('서버만 확인');
    expect(o).toContain('설정만 확인');
  });
});

// ⛔⭐ 2026-09-22 — 「앱이 지금 붙었나」를 도구가 «스스로» 묻는다(`--verify-hosts`).
//   🩸 종전엔 산출이 13곳에서 *"get_host_status 로 물어라"* 라고 사람에게 시켰다.
//   ⚠️ 망을 타는 갈래는 여기서 «안» 잰다(흔들린다) — 손으로 여섯 갈래를 전부 눌렀고 PR 본문에 적었다.
//      여기서는 ***망 없이 참이어야 하는 불변식***만 못 박는다.
describe('--verify-hosts — 호스트 축의 계약', () => {
  it('⛔ 플래그가 «받아들여진다» — 등록표가 «둘»이라 한쪽만 고치면 조용히 거부된다', () => {
    const o = out(CLI, ['probe', '--verify-hosts', '--json']);
    expect(o).not.toContain("모르는 플래그 '--verify-hosts'");
  });

  it('⛔ 두 서피스가 «같은 모집단»을 본다 — MCP 서버 설정 필요', () => {
    const j = JSON.parse(configuredOut(['probe', '--json'])) as {
      capabilities: { found: { id: string; drive?: string }[]; hosts: { impl: string; state: string }[] }[];
    };
    const appAttached = new Set(j.capabilities.flatMap((c) => c.found)
      .filter((i) => i.drive === 'app-attached').map((i) => i.id));
    const inHosts = new Set(j.capabilities.flatMap((c) => c.hosts).map((h) => h.impl));
    expect([...inHosts].sort()).toEqual([...appAttached].sort());
    expect(appAttached.size).toBeGreaterThan(0);        // 전제: 표본이 비어 있지 않다
  });

  it('⛔ 안 물었으면 「안 붙었다」가 아니라 «not-asked» 다 — MCP 서버 설정 필요', () => {
    const j = JSON.parse(configuredOut(['probe', '--json'])) as {
      capabilities: { hosts: { impl: string; state: string }[] }[];
    };
    const states = new Set(j.capabilities.flatMap((c) => c.hosts).map((h) => h.state));
    expect([...states]).toEqual(['not-asked']);
    expect(configuredOut(['probe'])).toContain('--verify-hosts 로 물어본다');
  });
});

// ⛔⭐ 2026-09-22 — provider 축이 «경계 계산»에서 조용히 새던 자리.
//   🩸 실물: bridge-ae·bridge-premiere·bridge-blender 는 tier='owned'(앱을 이미 샀다)인데
//      ***브리지 자체가 bridge.higgsfield.ai 의 OAuth 를 탄다***(설정에 oauthIssuer 가 있다).
//      그런데 provider 가 «비어» 있어서 ***higgsfield 계정이 필요하다는 사실이 통째로 안 보였다.***
//   🔑 「앱을 샀다」가 「계정이 필요 없다」를 뜻하지 않는다 — tier 와 needsAccount 는 다른 축이다.
describe('provider 축 — 경계가 읽는 needsAccount', () => {
  it('⛔ 구현이 쓰는 provider 는 «전부» 선언돼 있다 — 없으면 「계정 불필요」로 샌다', () => {
    const used = new Set(CAPABILITIES.flatMap((c) => c.impls).map((i) => i.provider).filter(Boolean));
    const declared = new Set(PROVIDERS.map((p) => p.id));
    expect(used.size).toBeGreaterThan(0);                       // 전제: 표본이 비어 있지 않다
    expect([...used].filter((p) => !declared.has(p!))).toEqual([]);
  });

  it('⛔ 앱을 «샀다»(owned)가 「계정이 필요 없다」를 뜻하지 않는다 — bridge 가 그 반례다', () => {
    const bridges = CAPABILITIES.flatMap((c) => c.impls).filter((i) => i.id.startsWith('bridge-'));
    expect(bridges.length).toBeGreaterThan(0);
    for (const b of bridges) {
      expect(b.tier).toBe('owned');                             // 앱은 샀다
      const p = PROVIDERS.find((x) => x.id === b.provider);
      expect(p, `${b.id} 에 provider 가 없다`).toBeDefined();
      expect(p!.needsAccount).toBe(true);                       // 그런데 계정은 «필요하다»
    }
  });

  it('⛔ higgsfield 와 higgsfield-bridge 는 «다른» provider 다 — 한 이름이 두 축이었다', () => {
    const cloud = PROVIDERS.find((p) => p.id === 'higgsfield');
    const bridge = PROVIDERS.find((p) => p.id === 'higgsfield-bridge');
    expect(cloud).toBeDefined();
    expect(bridge).toBeDefined();
    expect(cloud!.auth).not.toBe(bridge!.auth);                 // 자격 경로가 갈린다
  });

  it('로컬 런타임은 계정이 «없다» — 자격 색인에 원리상 안 들어온다', () => {
    for (const id of ['local-mlx', 'local-ggml']) {
      expect(PROVIDERS.find((p) => p.id === id)?.needsAccount).toBe(false);
    }
  });
});

// ⛔⭐ 2026-09-22 — ***「돈이 든다」와 「계정이 필요하다」는 «다른 축»이다.***
//   🩸 실물: `--need app-control` 이 bridge-ae 를 골라 놓고 «💰 과금 구현 0개 — 돈이 안 든다»
//      라고만 말했다. 맞는 말인데, 그 브리지는 higgsfield OAuth 를 탄다(#19815).
//      ⇒ 읽는 사람은 「돈이 안 든다」에서 ***「그냥 쓰면 된다」***를 읽고 로그인에서 막힌다.
//   🔑 이 조합(metered 는 비었는데 계정은 필요하다)이 «접으면 사라지는» 바로 그 칸이다.
describe('plan 계정 축 — 돈 축과 «접지 않는다»', () => {
  it('⛔ 돈이 «0» 이면서 계정이 «필요한» 스택 — higgsfield-bridge 설정 필요', () => {
    const j = JSON.parse(configuredOut(['plan', '--need', 'app-control', '--json'])) as {
      metered: string[]; accountsNeeded: { provider: string; auth: string | null }[];
    };
    expect(j.metered).toEqual([]);                                  // 돈은 «안» 든다
    expect(j.accountsNeeded.map((a) => a.provider)).toContain('higgsfield-bridge');
    expect(j.accountsNeeded.find((a) => a.provider === 'higgsfield-bridge')?.auth).toBe('oauth');
  });

  it('사람 화면도 같은 말을 한다 — higgsfield-bridge 설정 필요', () => {
    const o = configuredOut(['plan', '--need', 'app-control']);
    expect(o).toContain('계정이 필요한 구현');
    expect(o).toContain('higgsfield-bridge');
    expect(o).toContain('앱을 샀어도 계정 없이는 못 몬다');
  });

  it('✅ 무료 경로는 «로그인 없이» 돈다고 말한다 — 빈 값을 침묵으로 두지 않는다', () => {
    const o = out(CLI, ['plan', '--from', 'ground', '--to', 'deliver']);
    expect(o).toContain('계정이 필요한 구현 «0개»');
  });

  it('⛔ 낡은 처방이 남아 있지 않다 — higgsfield-bridge 설정 필요', () => {
    const o = configuredOut(['plan', '--need', 'app-control', '--from', 'compose', '--to', 'overlay']);
    expect(o).not.toContain('get_host_status 로 물어라');
    expect(o).toContain('--verify-hosts');
  });
});

// ⛔⭐⭐ 2026-09-22 — ***긍정과 부정이 «같은 무게가 아니다».***
//   골 ASK-installed-and-usable-right-now-are-different-values 가 못 박았다:
//   > ***reachable 의 긍정은 언제나 «프로토콜 왕복»이다. 관측은 «부정에만» 싸게 쓴다.***
//   🩸 #19814 에서 내가 벤더 보고를 「✅앱 붙어 있다 (실측)」 으로 «승격»시켰다.
//      그 골은 이미 착지해 있었고 «내가 안 읽었다».
//   ⚠️ 실제 배제는 망을 탄다 — 손으로 눌렀다(hostKey='3d_bs' 는 실물 응답이 진짜 false 다).
//      여기서는 ***교리 자체***를 망 없이 못 박는다.
describe('호스트 문 — 한 방향으로만 연다', () => {
  const ALL: HostState[] = ['not-asked', 'no-host-key', 'unmeasured', 'no-field', 'connected', 'disconnected'];

  it('⛔ «disconnected» 하나만 배제 근거다 — 나머지 다섯은 아니다', () => {
    expect(ALL.filter(isDefinitelyDown)).toEqual(['disconnected']);
  });

  it('⛔ 「못 쟀다」를 「없다」로 접지 않는다 — 접으면 서버가 느린 날 전 스택이 사라진다', () => {
    const rows = ALL.map((s) => ({ s }));
    const { kept, dropped } = gateByHost(rows, (r) => r.s);
    expect(dropped.map((r) => r.s)).toEqual(['disconnected']);
    expect(kept.map((r) => r.s)).toContain('unmeasured');
    expect(kept.map((r) => r.s)).toContain('not-asked');
    expect(kept.map((r) => r.s)).toContain('no-field');
  });

  it('⛔ 뺀 것을 «돌려준다» — 조용히 빼면 「원래 없었다」와 구별이 안 된다', () => {
    const { dropped } = gateByHost([{ s: 'disconnected' as HostState }], (r) => r.s);
    expect(dropped).toHaveLength(1);
  });

  // ⚠️ 이 칸의 첫 판은 `probe`(플래그 없이) 산출을 봤는데 ***그 문자열은 애초에 안 나온다*** —
  //   `t=0` 에 이미 참이었다(옛 라벨을 되돌려도 0 fail 이었다). 라벨을 순수 함수로 빼서 «직접» 문다.
  it('⛔ 긍정을 «왕복»으로 승격하지 않는다 — connected 라벨이 그것을 말한다', () => {
    const l = hostLabel('connected');
    expect(l).toContain('왕복');
    expect(l).toContain('답했다');
    expect(l).not.toContain('실측');          // 🩸 #19814 의 문면이 정확히 이것이었다
  });

  it('부정은 그대로 쓴다 — 싸게 믿어도 되는 방향이다', () => {
    expect(hostLabel('disconnected')).toContain('안 붙었다');
  });

  it('⛔ 「못 쟀다」가 «셋»이고 문면이 서로 다르다 — 고칠 자리가 전부 다르기 때문이다', () => {
    const three = (['no-host-key', 'unmeasured', 'no-field'] as HostState[]).map((s) => hostLabel(s, 'blr'));
    expect(three.every((l) => l.includes('못 쟀다'))).toBe(true);
    expect(new Set(three).size).toBe(3);      // ⛔ 한 칸으로 접히지 않았다
  });
});

// ⛔⭐⭐⭐ 2026-09-23 — RFC §6 ① : ***기본 템플릿을 목적에 맞게 «변형»한다.***
//   🩸 실측: 엔진(`graph-overlay-yaml.ts`)은 «이미» 영상 선언에 오버레이를 얹을 수 있었는데
//      ⑴ 그것을 «부르는 자리»가 제품에 없었고
//      ⑵ 오버레이 조건이 함수 꼴(`selected('app-control')`)이라 판정이 전부 `unparseable` 이었다.
//      ⇒ ***얹힌 오버레이가 «0장»이었고 그것이 조용했다.***
//   🔑 조건은 «비교 하나»이고 사실은 «도구»가 값으로 낸다(`overlayState`).
describe('오버레이 — 목적이 기본 템플릿을 변형한다', () => {
  it('임시 HOME 의 활성 MCP 설정으로 실제 plan --need app-control --overlay --json 이 profile-gui-app 을 고른다', () => {
    const env = FIXTURE_ENV;
    const probe = spawnSync(process.execPath, [CLI, 'probe'], {
      cwd: REPO, encoding: 'utf8', timeout: 90_000, env,
    });
    expect(probe.status, probe.stderr).toBe(0);
    const topview = probe.stdout.split('\n').find((line) => line.includes('topview-canvas'));
    const bridge = probe.stdout.split('\n').find((line) => line.includes('bridge-blender'));
    expect(topview).toContain('호스트 축 없음');
    expect(topview).not.toContain('앱');
    expect(bridge).toContain('앱');
    expect(probe.stdout).toContain('설정만 확인');
    const probeJson = spawnSync(process.execPath, [CLI, 'probe', '--json'], {
      cwd: REPO, encoding: 'utf8', timeout: 90_000, env,
    });
    expect(probeJson.status, probeJson.stderr).toBe(0);
    const probeData = JSON.parse(probeJson.stdout) as {
      capabilities: { found: { id: string; drive: string }[];
        hosts: { impl: string; state: string }[] }[];
    };
    const attached = new Set(probeData.capabilities.flatMap((c) => c.found)
      .filter((i) => i.drive === 'app-attached').map((i) => i.id));
    const hosts = new Set(probeData.capabilities.flatMap((c) => c.hosts).map((h) => h.impl));
    expect(attached.size).toBeGreaterThan(0);
    expect(hosts).toEqual(attached);
    expect(new Set(probeData.capabilities.flatMap((c) => c.hosts).map((h) => h.state)))
      .toEqual(new Set(['not-asked']));
    const r = spawnSync(process.execPath, [CLI, 'plan', '--need', 'app-control', '--overlay', '--json'], {
      cwd: REPO, encoding: 'utf8', timeout: 90_000, env,
    });
    expect(r.status, r.stderr).toBe(0);
    const plan = JSON.parse(r.stdout) as {
      stack: { picks: { cap: string; impl: string | null }[] }[];
      overlay: { state: Record<string, number>; selections: { overlayId: string; verdict: string }[];
        patches: { overlayId: string; node: string; before: number; after: number }[]; error: string | null } | null;
    };
    expect(plan.stack.flatMap((n) => n.picks).filter((p) => p.cap === 'app-control')
      .map((p) => p.impl)).toContain(process.platform === 'darwin' ? 'bridge-ae' : 'bridge-blender');
    expect(plan.overlay?.error).toBeNull();
    expect(plan.overlay?.state.selected_app_control).toBeGreaterThan(0);
    expect(plan.overlay?.selections.find((s) => s.overlayId === 'profile-gui-app')?.verdict).toBe('applies');
    const patches = plan.overlay?.patches.filter((p) => p.overlayId === 'profile-gui-app') ?? [];
    expect(patches.map((p) => p.node).sort()).toEqual(['compose', 'render']);
    for (const patch of patches) expect(patch.after).toBeGreaterThan(patch.before);

    const shim = join(FIXTURE_HOME, 'darwin.ts');
    writeFileSync(shim, `Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });\n`
      + `await import(${JSON.stringify(CLI)});\n`);
    const mac = spawnSync(process.execPath, [shim, 'plan', '--need', 'app-control', '--overlay', '--json'], {
      cwd: REPO, encoding: 'utf8', timeout: 90_000, env,
    });
    expect(mac.status, mac.stderr).toBe(0);
    const macPlan = JSON.parse(mac.stdout) as typeof plan;
    expect(macPlan.stack.flatMap((n) => n.picks).filter((p) => p.cap === 'app-control')
      .map((p) => p.impl)).toContain('bridge-ae');
    expect(macPlan.overlay?.selections.find((s) => s.overlayId === 'profile-gui-app')?.verdict).toBe('applies');
    const macProbe = spawnSync(process.execPath, [shim, 'probe'], {
      cwd: REPO, encoding: 'utf8', timeout: 90_000, env,
    });
    expect(macProbe.status, macProbe.stderr).toBe(0);
    expect(macProbe.stdout).toContain('topview-canvas');
    expect(macProbe.stdout).toContain('bridge-ae');
  });

  const j = (args: string[]) => JSON.parse(outJson(CLI, args)) as {
    overlay: null | {
      state: Record<string, number>;
      selections: { overlayId: string; verdict: string; detail?: string }[];
      patches: { overlayId: string; node: string; before: number; after: number }[];
      error: string | null;
    };
  };

  it('⛔ 기본은 «안 얹는다» — 계획의 뜻이 조용히 바뀌면 안 된다', () => {
    expect(j(['plan', '--need', 'app-control', '--json']).overlay).toBeNull();
    expect(out(CLI, ['plan', '--need', 'app-control'])).not.toContain('🪄');
  });

  it('⭐ app-control 을 고른 계획엔 profile-gui-app 이 «얹힌다» — MCP 설정 필요', () => {
    const o = JSON.parse(configuredOut(['plan', '--need', 'app-control', '--overlay', '--json'])).overlay as
      ReturnType<typeof j>['overlay'];
    expect(o?.error).toBeNull();
    expect(o).not.toBeNull();
    if (!o) return;
    expect(o.state.selected_app_control).toBeGreaterThan(0);        // 전제: 표본이 정말 골랐다
    expect(o.selections.find((s) => s.overlayId === 'profile-gui-app')?.verdict).toBe('applies');
    const nodes = o.patches.filter((p) => p.overlayId === 'profile-gui-app').map((p) => p.node).sort();
    expect(nodes).toEqual(['compose', 'render']);
    for (const p of o.patches) expect(p.after).toBeGreaterThan(p.before);
  });

  it('⛔ 무료 경로엔 «안» 얹힌다 — 조건이 거짓이면 그대로다', () => {
    const o = j(['plan', '--from', 'ground', '--to', 'deliver', '--overlay', '--json']).overlay!;
    expect(o.state.selected_app_control).toBe(0);
    expect(o.patches).toEqual([]);
    expect(o.selections.find((s) => s.overlayId === 'profile-gui-app')?.verdict).toBe('does-not-apply');
  });

  it('⭐ 과금 스택엔 «다른» 오버레이가 얹힌다 — MCP 설정 필요', () => {
    const o = JSON.parse(configuredOut(['plan', '--need', 'avatar-video', '--overlay', '--json'])).overlay as
      NonNullable<ReturnType<typeof j>['overlay']>;
    expect(o.state.selected_metered_count).toBeGreaterThan(0);
    expect(o.selections.find((s) => s.overlayId === 'profile-credit-heavy')?.verdict).toBe('applies');
    expect(o.selections.find((s) => s.overlayId === 'profile-gui-app')?.verdict).toBe('does-not-apply');
  });

  it('⛔ 「조건이 거짓」과 「그 키를 못 쟀다」를 «접지 않는다»', () => {
    const o = j(['plan', '--need', 'app-control', '--overlay', '--json']).overlay!;
    // found_footage 는 plan 이 «못 재는» 사실이다 — 0 으로 채우지 않고 키를 비운다
    expect(o.state.found_footage).toBeUndefined();
    expect(o.selections.find((s) => s.overlayId === 'profile-found-footage')?.verdict).toBe('key-absent');
    expect(out(CLI, ['plan', '--need', 'app-control', '--overlay'])).toContain('계측 결손');
  });

  it('⛔ 남의 그래프를 겨냥한 오버레이는 «안» 얹힌다 — target-mismatch', () => {
    const o = j(['plan', '--need', 'app-control', '--overlay', '--json']).overlay!;
    expect(o.selections.find((s) => s.overlayId === 'render-patient')?.verdict).toBe('target-mismatch');
  });
});

// ⛔⭐ 2026-09-23 — ***「CLI 가 PATH 에 있나」와 「이 기계가 쓸 수 있나」는 다른 값이다.***
//   🩸 계기: 대표 께서 주신 X 링크 둘을 읽다가 실측했다 — `hyperframes` 를 `cmd()` 로 재고 있었는데
//      PATH 에 «없어서» probe 산출에서 통째로 사라졌다. 그래서 `plan` 이 무료 경로에서
//      ***레지스트리 자신이 "제한적 — 복잡한 타이포는 못 한다" 고 적은*** ffmpeg-motion 을 골랐다.
//   ⛔ 그런데 ***같은 칸의 note 가 이미 "미설치면 npx 로 돈다" 고 적고 있었다*** —
//      선언과 탐침이 서로 다른 말을 했고, 산출은 탐침 편을 들었다.
describe('skill 탐침 — 선언의 note 와 탐침이 같은 말을 한다', () => {
  it('⭐ 스킬로 닿는 구현이 probe 에 «보인다» — hyperframes 스킬 설정 필요', () => {
    const j = JSON.parse(configuredOut(['probe', '--json'])) as {
      capabilities: { cap: string; found: { id: string; tier: string }[] }[];
    };
    const mg = j.capabilities.find((c) => c.cap === 'motion-graphics');
    expect(mg, 'motion-graphics 능력이 레지스트리에 없다').toBeDefined();
    expect(mg!.found.map((i) => i.id)).toContain('hyperframes');
  });

  it('⭐ 무료 선호면 «그것»을 고른다 — hyperframes 스킬 설정 필요', () => {
    const j = JSON.parse(configuredOut(['plan', '--need', 'motion-graphics', '--prefer', 'free', '--json'])) as {
      stack: { picks: { cap: string; impl: string | null }[] }[];
    };
    const picked = j.stack.flatMap((o) => o.picks).filter((p) => p.cap === 'motion-graphics').map((p) => p.impl);
    expect(picked.length).toBeGreaterThan(0);          // 전제: 표본이 비어 있지 않다
    expect(picked).toContain('hyperframes');
    expect(picked).not.toContain('ffmpeg-motion');
  });

  it('⛔ 「스킬이 있다」를 「지금 렌더된다」로 말하지 않는다 — hyperframes 스킬 설정 필요', () => {
    const o = configuredOut(['probe']);
    expect(o).toContain('hyperframes');
    // 선언의 note 가 «렌더 확정은 아직»을 말한다 — 산출이 과하게 약속하지 않는지
    expect(o).not.toContain('hyperframes 로 렌더된다');
  });
});

// ⛔⭐⭐ 2026-09-23 — ***「선언에 이름이 있다」와 「그 이름이 «묶여» 있다」는 다른 값이다.***
//   🩸 내가 RFC 에 *"레시피 77개 중 코드에 닿는 것이 사실상 0"* 이라 썼고 ***두 번 틀렸다***:
//     ⑴ kebab(`place-clips`)으로 grep 했는데 코드는 camelCase(`placeClips`)를 쓴다 → 실제는 «14»
//     ⑵ *"부를 자리가 없다"* 도 거짓 — `video-free-line.ts:35` 가 RECIPES[name] 으로 이미 디스패치한다
//   🔑 진짜 구멍은 ***「돌려 보기 «전»에 아무도 안 세는 것」*** 이었다.
describe('recipes — 선언 이름이 구현에 «닿나»', () => {
  const j = () => JSON.parse(outJson(CLI, ['recipes', '--json'])) as {
    boundTotal: number;
    templates: { file: string; graphId: string; parsed: boolean; total: number; terminal: number; bound: string[]; unbound: string[] }[];
  };

  it('⭐ 무료 한 줄(video-production)은 «완결»이다 — 안 묶인 레시피 0', () => {
    const t = j().templates.find((x) => x.graphId === 'video-production');
    expect(t, 'video-production 선언을 못 찾았다').toBeDefined();
    expect(t!.parsed).toBe(true);
    expect(t!.bound.length).toBeGreaterThan(0);      // 전제: 표본이 비어 있지 않다
    expect(t!.unbound).toEqual([]);
  });

  it('⛔ 「못 읽은 선언」을 «깨끗하다»로 말하지 않는다 — 0은 「잰 0」이 아니다', () => {
    const bad = j().templates.filter((x) => !x.parsed);
    expect(bad.length).toBeGreaterThan(0);           // 전제: 이 저장소에 그런 파일이 있다
    for (const b of bad) expect(b.unbound).toEqual([]);   // 수치는 0이지만
    // ⚠️ 이 칸의 첫 판은 «설명 줄»을 물었다 — 마크를 ✅ 로 되돌려도 그 줄은 안 바뀌어서 «t=0 에 이미 참»이었다.
    //   ⇒ 그 파일의 «판정 마크»를 «직접» 문다.
    const lines = out(CLI, ['recipes']).split('\n');
    for (const b of bad) {
      const row = lines.find((l) => l.includes(b.file));
      expect(row, `${b.file} 줄이 산출에 없다`).toBeDefined();
      expect(row!.trimStart().startsWith('🔲'), `${b.file} 가 «깨끗하다»로 찍혔다: ${row}`).toBe(true);
      expect(row!.trimStart().startsWith('✅')).toBe(false);
    }
  });

  it('⛔ 종단 레시피를 «일하는 레시피»와 섞지 않는다 — 접으면 구멍 수가 부푼다', () => {
    for (const t of j().templates) {
      expect(t.bound.every((r) => !r.startsWith('terminal-'))).toBe(true);
      expect(t.unbound.every((r) => !r.startsWith('terminal-'))).toBe(true);
      expect(t.terminal + t.bound.length + t.unbound.length).toBe(t.total);
    }
  });

  it('⭐ --strict 가 «세 결과»를 낸다 — 판정을 읽지 않으면 래칫은 장식이다', () => {
    // 🩸 첫 판은 종료 코드를 «배선하지 않아» 셋 다 rc=0 이었다.
    expect(run(CLI, ['recipes', '--strict', 'video-production'])).toBe(0);        // 완결
    // ⛔ «구멍 난 템플릿» 예는 «그때 구멍인 것»이어야 한다 — film·character 는 2026-09-23 에 완결돼 1→0 이 됐다.
    //   영상 템플릿은 넷 다 완결 ⇒ 구멍 예는 하니스 템플릿(exec-standard)으로 옮겼다.
    expect(run(CLI, ['recipes', '--strict', 'film-production-standard'])).toBe(0); // 완결(2026-09-23)
    expect(run(CLI, ['recipes', '--strict', 'character-video-standard'])).toBe(0); // 완결(2026-09-23)
    expect(run(CLI, ['recipes', '--strict', 'exec-standard'])).toBe(1);            // 구멍
    expect(run(CLI, ['recipes', '--strict', 'no-such-graph'])).toBe(2);            // 못 찾음
  });

  it('⛔ strict 없이는 «막지 않는다» — 안 쓰는 것을 미리 막으면 관문이 고장의 원인이다', () => {
    expect(run(CLI, ['recipes'])).toBe(0);
  });
});

describe('video-film-line — --hf-projects', () => {
  const FILM = join(HERE, 'video-film-line.ts');
  const KNOWN = {
    '--plan': 'value', '--sources': 'value', '--native': 'value', '--track': 'value', '--bpm': 'value',
    '--fps': 'value', '--logo-dir': 'value', '--out': 'value', '--target-lufs': 'value',
    '--hf-projects': 'value', '--json': 'bool',
  } as const;

  function fixture(body: string | null): { dir: string; plan: string; sources: string; hf: string; project: string } {
    const dir = mkdtempSync(join(tmpdir(), 'hf-projects-'));
    const plan = join(dir, 'plan.json');
    const sources = join(dir, 'sources.json');
    const project = join(dir, 'proj-a');
    mkdirSync(project, { recursive: true });
    writeFileSync(plan, '[]');
    writeFileSync(sources, '{}');
    const hf = join(dir, 'hf.json');
    if (body !== null) writeFileSync(hf, body);
    return { dir, plan, sources, hf, project };
  }

  it('임시 디렉토리 표를 절대경로 hyperframes_projects 로 싣는다 — 호출자는 assembleFilmLineState', () => {
    const fx = fixture(null);
    writeFileSync(fx.hf, JSON.stringify({ a: fx.project }));
    const P = parseArgv(['--plan', fx.plan, '--sources', fx.sources, '--hf-projects', fx.hf], { known: KNOWN, label: 'video-film-line' });
    const assembled = assembleFilmLineState(P);
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    const projects = assembled.state.hyperframes_projects as Record<string, string>;
    expect(projects.a).toBe(fx.project);
    expect(projects.a.startsWith('/')).toBe(true);
    rmSync(fx.dir, { recursive: true, force: true });
  });

  it('--native 와 함께 줘도 hyperframes_projects 만 더하고 native_sources 키 모양은 그대로다', () => {
    const fx = fixture(null);
    const native = join(fx.dir, 'native.json');
    writeFileSync(native, JSON.stringify({ a: { '9x16': join(fx.dir, 'given.mp4') } }));
    writeFileSync(fx.hf, JSON.stringify({ a: 'proj-a' }));
    const P = parseArgv(
      ['--plan', fx.plan, '--sources', fx.sources, '--native', native, '--hf-projects', fx.hf, '--bpm', '128'],
      { known: KNOWN, label: 'video-film-line' },
    );
    const assembled = assembleFilmLineState(P);
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    expect(assembled.state.bpm).toBe(128);
    expect((assembled.state.native_sources as { a: { '9x16': string } }).a['9x16']).toBe(join(fx.dir, 'given.mp4'));
    expect((assembled.state.hyperframes_projects as Record<string, string>).a).toBe(fx.project);
    expect('hyperframes_run' in assembled.state).toBe(false);
    rmSync(fx.dir, { recursive: true, force: true });
  });

  it('없는 파일은 종료코드 3 과 이유를 낸다', () => {
    const fx = fixture(null);
    const missing = join(fx.dir, 'no-such.json');
    const loaded = loadHyperframesProjects(missing);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.reason).toContain(missing);
    const r = spawnSync('bun', [FILM, '--plan', fx.plan, '--sources', fx.sources, '--hf-projects', missing], { cwd: REPO, encoding: 'utf8', timeout: 90_000 });
    expect(r.status).toBe(3);
    expect(`${r.stdout}${r.stderr}`).toContain(loaded.reason);
    rmSync(fx.dir, { recursive: true, force: true });
  });

  it('JSON 이 아니면 종료코드 3 과 이유를 내고 조용히 넘기지 않는다', () => {
    const fx = fixture('not-json');
    const loaded = loadHyperframesProjects(fx.hf);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.reason).toContain('JSON 이 아니다');
    const r = spawnSync('bun', [FILM, '--plan', fx.plan, '--sources', fx.sources, '--hf-projects', fx.hf], { cwd: REPO, encoding: 'utf8', timeout: 90_000 });
    expect(r.status).toBe(3);
    expect(`${r.stdout}${r.stderr}`).toContain('JSON 이 아니다');
    rmSync(fx.dir, { recursive: true, force: true });
  });
});
