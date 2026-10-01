#!/usr/bin/env bun
// ── 영상 파이프라인 빌더 — 실측 probe ⊕ 스택 해석 ─────────────────────────
//
// ⛔ 이 도구는 «자연어를 안 읽는다». 조립은 /video-builder 스킬 안에서 «에이전트»가 한다.
//    여기는 그 조립이 기대는 ***결정적인 두 값***만 낸다:
//      probe  이 기계에 «실제로» 무엇이 있나            ⛔ 「있다고 치고」 금지
//      plan   고른 능력 → 구체 스택 ⊕ 구멍 ⊕ 강등 ⊕ 과금
//
// 사용:
//   bun scripts/video-pipeline.ts probe [--json]
//   bun scripts/video-pipeline.ts plan --need <cap,...> [--from N] [--to N]
//                                      [--prefer free|owned] [--assume-missing id,...] [--json]
//   bun scripts/video-pipeline.ts spine          뼈대와 «레고 돌기»(inputs) 표

import { existsSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CAPABILITIES, PROVIDERS, UNSET_MEDIA_HOST, type Impl, type Tier } from '../src/video-pipeline/capabilities.js';
import { summarizeTiers } from '../src/video-pipeline/tier-summary.js';
import { gateByHost, hostLabel, type HostState } from '../src/video-pipeline/host-gating.js';
import { parseGraphOverlayYaml, selectOverlays, applyGraphOverlays } from '../src/self-implement/graph-overlay-yaml.js';
import { overlayState, type PickedForOverlay } from '../src/video-pipeline/overlay-state.js';
import { pathProbe } from '../src/video-pipeline/probe-path.js';
import { parseGraphTemplateYaml } from '../src/self-implement/graph-yaml.js';
import { ALL_RECIPES, exitCodeOf, findTemplate, formatStep, loadWalker, walkLine, type GraphSpecLike } from '../src/video-pipeline/walk-line.js';
import { parseArgv, type FlagKind } from './lib/argv.js';
import { SPINE, segmentOf } from '../src/video-pipeline/spine.js';
import {
  loadConfig, effectiveCapabilitiesWithShadowed, findConfigPath, STARTER_CONFIG,
  type MachineProfile,
} from '../src/video-pipeline/config.js';
import { writeStdoutJson } from '../src/cli/stdout-json.js';

const argv = process.argv.slice(2);
const sub = argv[0] ?? '';

// ⛔⭐⭐ 10차 리뷰 — 인자 계약을 «한 벌»로 옮겼다(`scripts/lib/argv.ts`).
//   📏 계기: 같은 결함이 여덟 판에 걸쳐 «여섯 철자»로 살아남았다(그 목록은 그 파일 머리말).
//      매번 «그 자리»를 고쳤기 때문에 매번 다른 자리가 남았다 — `--json --json` 이 마지막이었다.
//   🔑 옆 스크립트(check-graph-declaration.ts)도 «같은» 계약을 쓴다. 한쪽만 고치는 일이 끝난다.
const KNOWN: Record<string, FlagKind> = {
  '--json': 'bool', '--init': 'bool', '--force': 'bool', '--verify-hosts': 'bool', '--overlay': 'bool', '--strict': 'value',
  '--need': 'value', '--from': 'value', '--to': 'value', '--prefer': 'value',
  '--assume-missing': 'value', '--machine': 'value', '--config': 'value',
  '--out': 'value', '--surface': 'value', '--provider-order': 'value',
  // ⭐ RFC §4 — 「슬래시 다음 한 마디」가 대는 «사실». ⛔ 도구가 «재는» 키는 이것으로 못 덮는다.
  '--told': 'value',
  // 🚶 walk — 어느 선언이든 «한 문»으로 걷는다(라인 스크립트 셋이 각자 걷던 것을 합친다).
  '--graph': 'value', '--state': 'value',
};
// ⛔ 서브커맨드와 «무관한» 플래그도 거부한다 — probe --out 이 exit 0 이었다.
const FLAGS_BY_SUB: Record<string, readonly string[]> = {
  probe: ['--json', '--config', '--machine', '--surface', '--assume-missing', '--verify-hosts'],
  plan: ['--json', '--config', '--machine', '--surface', '--assume-missing',
         '--need', '--from', '--to', '--prefer', '--provider-order', '--verify-hosts', '--overlay', '--told'],
  recipes: ['--json', '--strict'],
  walk: ['--graph', '--state', '--told', '--out', '--json'],
  spine: [],
  drift: [],
  config: ['--config', '--init', '--out', '--force'],
};
const PARSED = parseArgv(argv.slice(1), {
  known: KNOWN, allowed: FLAGS_BY_SUB[sub], label: sub || undefined,
});
if (PARSED.errors.length > 0) {
  for (const e of PARSED.errors) console.error(`⛔ ${e}`);
  process.exit(2);
}
const flag = (n: string): boolean => PARSED.flags.has(n);
const opt = (n: string, d = ''): string => PARSED.values[n] ?? d;
const list = (n: string): string[] => opt(n).split(',').map((s) => s.trim()).filter(Boolean);

// ── 설정 적재 — ⛔ 「어디서 왔나」를 항상 들고 다닌다 ──
// ⛔ 사람이 «명시한» --config 가 없으면 폴백하지 않는다 — 다른 설정으로 계획을 세우면
//   그 계획은 「그 설정의 계획」이 아니다. 조용한 대체는 가장 비싼 거짓말이다.
const CONFIG_FLAG = opt('config');
// ⛔ 명시한 경로는 «못 박은 한 칸»이다 — 그 칸이 비면 어느 서브커맨드든 실패다(사람이 대 놓고 틀렸다).
if (CONFIG_FLAG && !existsSync(CONFIG_FLAG)) {
  console.error(`⛔ --config '${CONFIG_FLAG}' 가 없다. 폴백하지 않는다.`);
  process.exit(2);
}
// ⛔⭐⭐ 15차 리뷰 ④ — 설정을 «모든 서브커맨드보다 먼저» 실었다.
//   ⇒ 환경의 깨진 `$ELANOUS_VIDEO_TOOLS` 하나가 ***설정을 쓰지도 않는 `drift`·`spine` 까지 막았다***.
//   🔑 ***관문은 자기가 쓰는 것만 막아야 한다.*** 안 쓰는 것을 막으면 그 관문이 «고장의 원인»이 된다.
//   ⇒ 설정을 «소비하는» 서브커맨드에서만 실패시킨다(읽기는 그대로 — 산출에 출처를 적어야 하므로).
const CONFIG_CONSUMERS = new Set(['probe', 'plan', 'config']);
const LOADED = loadConfig(CONFIG_FLAG || undefined);
if ((LOADED.error !== undefined || LOADED.source.startsWith('⛔')) && !CONFIG_CONSUMERS.has(sub)) {
  // ⛔ 삼키지 않는다 — «쓰지 않으므로 넘어간다»고 말하고 넘어간다.
  console.error(`⚠️ 설정을 못 읽었지만 '${sub}' 는 설정을 쓰지 않는다 — 넘어간다`);
  console.error(`   ${LOADED.source}`);
}
if ((LOADED.error !== undefined || LOADED.source.startsWith('⛔')) && CONFIG_CONSUMERS.has(sub)) {
  console.error(LOADED.source);
  console.error('   ⇒ 잘못된 설정으로 계획을 세우면 그 계획은 거짓이다. 고치고 다시 쳐라.');
  process.exit(2);
}
const CFG = LOADED.config;
const EFF = effectiveCapabilitiesWithShadowed(CFG);
const CAPS = EFF.capabilities;
// ⛔ 설정 병합 결과로 «다시» 만든다 — 내장 전용 CAP_BY_ID 를 쓰면 설정 추가분을 못 본다.
//   (리뷰 must-fix ⑥: 내장 Map 은 그래서 «여기서» 안 쓰인다 — 배선 대신 제거했다)
const CAP_BY_ID = new Map(CAPS.map((c) => [c.id, c]));

// ⭐⭐ 퍼스트 서피스는 TUI 와 텔레그램이다 — 넓은 표는 거기서 «깨진다».
//   📏 실측: 텔레그램은 4096자 상한 · 스트리밍 3800에서 자름 · MarkdownV2 실패 시 plain 폴백.
//   ⇒ compact 는 괘선을 안 쓰고, 능력을 «중복 제거»하고, 줄을 40자 아래로 유지한다.
type Surface = 'cli' | 'tui' | 'telegram';
const SURFACES: readonly Surface[] = ['cli', 'tui', 'telegram'];
const SURFACE = ((): Surface => {
  const v = opt('surface', 'cli');
  // ⛔ 오타를 «조용히» cli 로 떨어뜨리지 않는다 — 텔레그램을 치려다 넓은 표를 받게 된다.
  if (!SURFACES.includes(v as Surface)) {
    console.error(`⛔ --surface '${v}' 는 없는 값이다. 가능: ${SURFACES.join(' · ')}`);
    process.exit(2);
  }
  return v as Surface;
})();
// ⛔ 4차 리뷰(should-fix) — `--json --surface tui` 가 «문서화된 --json 을 무시하고» 압축 텍스트를 냈다.
//   `--json` 은 «기계 계약»이고 `--surface` 는 «사람 글의 렌더 방식»이다. 겹치면 계약이 이긴다.
const COMPACT = SURFACE !== 'cli' && !argv.includes('--json');

const MISSING_FLAG = list('assume-missing');
const MISSING = new Set(MISSING_FLAG);

// ── 기계 프로파일 — 고객 기계를 «기술»한다 ──
const MACHINE_NAME = opt('machine');
// ⛔⭐ 13차 리뷰 ④ — `have: ["not-an-impl"]` 이 통과했다. 그러면 그 기계는 «전부 없음»으로 계획되고,
//   사람은 「설정을 줬는데 왜 다 없지」를 도구가 아니라 자기 머리로 풀어야 한다.
//   ⭐ 기준은 «내장»이 아니라 ***설정 병합 후의 유효 레지스트리***다 — 사용자가 추가한 impl 은 막지 않는다.
// ⛔⭐⭐ 16차 리뷰 ① — 15차에 «설정 적재 실패»만 미루고 ***「의미 검증」은 그대로 두었다***.
//   ⇒ `drift` 가 여전히 «의미상 깨진» 설정에 걸려 exit 2 였다. 반쪽 수리였다.
//   🔑 ***고칠 때는 「같은 이유로 도는 것」을 «전수»로 찾는다*** — 하나만 옮기면 나머지가 남는다.
if (CONFIG_CONSUMERS.has(sub)) {
  // ⛔⭐ 14차 리뷰 ③ — `impls.<id>` 는 «기존 impl 을 덮는» patch 다. 그 id 가 없고 `capability` 도 없으면
  //   `effectiveCapabilities` 가 «조용히 버린다» — 설정을 썼는데 아무 일도 안 일어나는 그 침묵이다.
  {
    const builtinIds = new Set(CAPABILITIES.flatMap((c) => c.impls.map((i) => i.id)));
    const capIds = new Set([...CAPABILITIES.map((c) => c.id), ...Object.keys(CFG.capabilities ?? {})]);
    const orphan: string[] = [];
    for (const [id, patch] of Object.entries(CFG.impls ?? {})) {
      const cap = patch.capability;
      if (cap === undefined) {
        if (!builtinIds.has(id)) orphan.push(`impls.${id} — 기존 impl 도 아니고 capability 도 없다`);
        continue;
      }
      if (!capIds.has(cap)) orphan.push(`impls.${id}.capability='${cap}' — 그런 능력이 없다`);
      // ⛔ 새 impl 을 «붙이는» 것이면 완전해야 한다 — 기댈 내장값이 없다.
      for (const k of ['tier', 'probe'] as const) {
        if (!builtinIds.has(id) && patch[k] === undefined) orphan.push(`impls.${id}.${k} 가 없다(새 impl 이다)`);
      }
    }
    if (orphan.length > 0) {
      console.error(`⛔ 설정의 impl 이 «어디에도 안 붙는다»: ${orphan.join(' · ')}`);
      console.error('   ⇒ 그대로 두면 조용히 버려진다. 기존 id 를 쓰거나 capability 를 대라.');
      process.exit(2);
    }
  }

  const validIds = new Set(CAPS.flatMap((c) => c.impls.map((i) => i.id)));
  // ⛔ 21차 리뷰 — `--assume-missing` 의 오타가 exit 0 으로 «무시»되고, 출처엔 「가정했다」고 적혔다.
  //   ⇒ 사람은 「없다고 쳤다」고 믿는데 도구는 «아무것도 안 뺐다». 가장 조용한 불일치다.
  const badMissing = MISSING_FLAG.filter((id) => !validIds.has(id));
  if (badMissing.length > 0) {
    console.error(`⛔ --assume-missing 에 «레지스트리에 없는» impl id: ${badMissing.join(', ')}`);
    console.error('   ⇒ 오타면 아무것도 안 빠지는데 산출은 「가정했다」고 적는다.');
    process.exit(2);
  }
  const bad: string[] = [];
  for (const [name, m] of Object.entries(CFG.machines ?? {})) {
    for (const k of ['have', 'missing'] as const) {
      for (const id of m[k] ?? []) if (!validIds.has(id)) bad.push(`machines.${name}.${k}: '${id}'`);
    }
  }
  // ⛔ 16차 리뷰(should-fix) — 같은 id 가 have 와 missing 에 «둘 다» 있으면 결과가
  //   «호출 순서·구현 세부»에 달린다. 그런 설정은 고객 기계를 «기술»한 것이 아니다.
  for (const [name, m] of Object.entries(CFG.machines ?? {})) {
    const both = (m.have ?? []).filter((id) => (m.missing ?? []).includes(id));
    if (both.length > 0) bad.push(`machines.${name}: have 와 missing 에 둘 다 — ${both.join(', ')}`);
  }
  if (bad.length > 0) {
    console.error(`⛔ 설정의 기계 프로파일이 «말이 안 된다»: ${bad.join(' · ')}`);
    console.error(`   ⇒ 그대로 두면 그 기계는 «전부 없음»으로 계획된다. 오타이거나 구현을 같이 선언해야 한다.`);
    console.error(`   가능: ${[...validIds].sort().join(' ')}`);
    process.exit(2);
  }
}
const MACHINE: MachineProfile | undefined = MACHINE_NAME ? CFG.machines?.[MACHINE_NAME] : undefined;
if (MACHINE_NAME && !MACHINE) {
  console.error(`⛔ 기계 프로파일 '${MACHINE_NAME}' 이 설정에 없다 — 설정: ${LOADED.source}`);
  console.error(`   있는 것: ${Object.keys(CFG.machines ?? {}).join(', ') || '(없음)'}`);
  process.exit(2);
}
// ⛔ `detect:false` = 「이 기계에서 «재지 않는다»」. 그 아래의 모든 판정은 «가정»이다.
// ⛔ 「재지 않았다」는 «모든» 판정 문면에 붙어야 한다 — 한 갈래만 붙이면 다른 갈래로 샌다(15차 ③).

/**
 * ⛔⭐ 「이 산출이 «어디서» 왔나」 — 사람 글과 JSON 이 «같은 값»을 갖게 하는 한 칸.
 *   `detected` 가 false 면 그 아래 모든 found/pick 은 ***재서 얻은 것이 아니라 «선언»***이다.
 */
const PROVENANCE = ((): {
  config: string; machine: string | null; detected: boolean; overrides: readonly string[];
} => {
  // ⛔⭐⭐ 19차 리뷰 — 「재지 않았다」의 갈래가 ***둘 이상***이었다:
  //   ⑴ machines.<m>.detect:false  ⇒ have/missing «목록»을 믿는다
  //   ⑵ --assume-missing <ids>     ⇒ 재는 것과 «무관하게» 없다고 친다
  //   🩸 ⑵ 는 결과를 «반사실적으로» 바꾸는데 `detected: true` 로 나갔다. ***거짓 실측 주장***이다.
  //   ⊕ `assumedFrom` 이 언제나 `.have` 였다 — `missing` 만 쓴 프로파일에도 그렇게 적혔다.
  //   🔑 ⇒ 칸을 «하나의 문자열»로 두지 않는다. ***적용된 것을 «전부» 나열한다.***
  const overrides: string[] = [];
  if (MACHINE && MACHINE.detect === false) {
    if (MACHINE.have?.length) overrides.push(`machines.${MACHINE_NAME}.have`);
    if (MACHINE.missing?.length) overrides.push(`machines.${MACHINE_NAME}.missing`);
    if (overrides.length === 0) overrides.push(`machines.${MACHINE_NAME}.detect=false`);
  } else if (MACHINE?.missing?.length) {
    overrides.push(`machines.${MACHINE_NAME}.missing`);
  }
  if (MISSING_FLAG.length > 0) overrides.push(`--assume-missing=${MISSING_FLAG.join(',')}`);
  return {
    config: LOADED.source,
    machine: MACHINE_NAME || null,
    /** ⛔ false = 「이 산출의 일부는 «재서 얻은 것이 아니다»」. 이 칸을 안 보면 가정을 사실로 읽는다. */
    detected: overrides.length === 0,
    /** ⛔ 무엇이 «재기»를 대신했나 — 비어 있지 않으면 위 detected 는 false 다. */
    overrides,
  };
})();
const ASSUMED_ANY = !PROVENANCE.detected;
// ⛔ 「재지 않았다」는 «모든» 판정 문면에 붙어야 한다 — 한 갈래만 붙이면 다른 갈래로 샌다.
const ASSUME_SUFFIX = ASSUMED_ANY ? ` · ⚠️ 가정(${PROVENANCE.overrides.join(' · ')})` : '';

/**
 * ⛔⭐⭐ 18차 리뷰 ① — 「가정」 표기를 ***세 번*** 따로 붙였고 ***세 번째도 새어 나갔다***
 *   (14차 plan CLI · 15차 plan 미확인 갈래 · 18차 ***probe compact***).
 *   🔑 ***갈래마다 붙이는 한 반드시 «다음 갈래»가 남는다.*** 그래서 한 함수로 만든다.
 *   ⇒ 산출을 내는 «모든» 함수가 이것을 «맨 앞»에서 부른다. 서피스도 명령도 안 가린다.
 */
function printProvenance(): void {
  if (!ASSUMED_ANY) return;
  // ⛔⭐ JSON 은 이것을 «값»으로 싣는다(`source`). 여기서 또 찍으면 ***stdout 이 JSON 이 아니게 된다***
  //   — 파이프가 깨진다. 🪞 방금 그 사고를 냈다: `probe --json` 앞에 한 줄이 붙어 jq 가 죽었다.
  if (flag('json')) return;
  const src = PROVENANCE.overrides.join(' · ');
  console.log(COMPACT
    ? `⚠️ 일부는 «가정»이다 — ${src}`
    : `\n⚠️ 이 산출의 일부는 «재서 얻은 것이 아니다» — 대신한 것: ${src}`);
}
const HAVE = new Set(MACHINE?.have ?? []);
for (const m of MACHINE?.missing ?? []) MISSING.add(m);

// ⭐ MCP 서버는 «설정에 있고 enabled 인가»로 잰다.
// ⛔⭐ 이 probe 는 ***낙관적***이다 — 「서버가 설정됐나」까지만 답한다.
//   📏 실측 2026-09-22: higgsfield-bridge 는 붙었는데(170도구) Blender 호스트는 `not connected` 였다
//      (플러그인 ai.higgsfield.cep 가 ***Adobe 전용*** CEP 규격이라 Blender 를 안 덮는다).
//   ⇒ 「호스트가 실제로 붙었나」는 «다른 축»이고, 이 도구는 그걸 대신하지 않는다:
//        elanous --config-dir ~/.elanous mcp diagnose <id>       서버가 사나
//        (bridge) get_host_status                            ***어느 앱이 붙었나***
//   ⛔ 그래서 app-control 계열은 계획을 세우기 «전에» 호스트 상태를 따로 물어야 한다.
/**
 * ⛔⭐⭐ ***「앱이 지금 붙었나」를 «도구가» 묻는다*** — 2026-09-22.
 *
 * 🩸 종전: 산출이 13곳에서 *"get_host_status 로 물어라"* 라고 ***사람에게 시켰다.***
 *   그런데 그 물음은 도구가 할 수 있다 — `elanous mcp call <서버>.get_host_status` 가
 *   `{"structured":{"aeft":true,"ppro":true,"blr":true,"3d_bs":false}}` 를 돌려준다(실측).
 *   🔑 ***「처방을 사람에게 시키는 것」과 「도구가 스스로 답하는 것」은 다른 값이다.***
 *
 * ⛔ 기본은 «안 묻는다» — 망을 타고 수 초가 든다. `--verify-hosts` 로만 켠다.
 * ⛔ 실패는 ***「없다」가 아니라 「못 쟀다」***다 — `null` 을 돌려주고 호출부가 그렇게 «말한다».
 * ⛔ 전역 `elanous` 는 pilot(운영) 링크다 — ***이 트리의 진입점***으로 부른다.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_STATUS_TOOL = 'get_host_status';
const HOST_CACHE = new Map<string, Record<string, boolean> | null>();
function hostStatus(server: string): Record<string, boolean> | null {
  if (HOST_CACHE.has(server)) return HOST_CACHE.get(server)!;
  let out: Record<string, boolean> | null = null;
  try {
    const raw = execFileSync('bun', [join(HERE, '..', 'bin', 'elanous.mjs'), 'mcp', 'call',
      `${server}.${HOST_STATUS_TOOL}`], { encoding: 'utf8', timeout: 45_000 });
    const parsed = JSON.parse(raw) as { structured?: Record<string, unknown> };
    if (parsed.structured && typeof parsed.structured === 'object') {
      out = Object.fromEntries(Object.entries(parsed.structured)
        .filter(([, v]) => typeof v === 'boolean')) as Record<string, boolean>;
      if (Object.keys(out).length === 0) out = null;   // ⛔ 빈 답은 «못 쟀다»로
    }
  } catch { out = null; }
  HOST_CACHE.set(server, out);
  return out;
}

let MCP_IDS: Set<string> | null = null;
function mcpServerEnabled(id: string): boolean {
  if (!MCP_IDS) {
    MCP_IDS = new Set();
    try {
      const raw = readFileSync(join(homedir(), '.elanous', 'config.json'), 'utf8');
      for (const srv of (JSON.parse(raw)?.mcp?.servers ?? [])) {
        if (srv?.id && srv.enabled !== false) MCP_IDS.add(String(srv.id));
      }
    } catch { /* 설정 없으면 «없다»로 — ⛔ 「있다고 치지」 않는다 */ }
  }
  return MCP_IDS.has(id);
}

/** ⛔ 실제로 «잰다». ⊕ 기계 프로파일이 detect=false 면 «목록»을 믿는다(고객 기계 가정). */
/**
 * ⛔⭐ ssh 갈래의 결과는 «셋»이다 — true · false · ***null(못 쟀다)***.
 *   호스트가 꺼져 있거나 네트워크가 끊긴 것은 ***「그 도구가 없다」가 아니다.***
 *   🔑 그 둘을 접으면 ***무료로 할 수 있는 일을 「없다」고 판정해 유료로 보낸다.***
 */
/**
 * ⛔⭐ 원격 프로브의 «꼴이 둘»이다 — 섞으면 조용히 거짓 음성이 난다.
 *   ⓐ `host:/abs/path` · `host:~/path` (슬래시 «있음») ⇒ `test -x` (그 파일이 거기 있나)
 *   ⓑ `host:name`                     (슬래시 «없음») ⇒ `command -v` (PATH 어딘가에 있나)
 *
 * 🩸 ⓑ 가 필요한 이유 = brew 가 붙이는 자리가 «기계마다 다르다»
 *   (/opt/homebrew/bin vs /usr/local/bin). 절대 경로를 박으면 한쪽에서 «항상» 「없다」가 된다.
 *
 * ⛔⭐⭐ ***로그인 셸로 물어야 한다***(`bash -lc`) — 대표 정정 2026-09-22.
 *   비-로그인 ssh 는 ~/.zprofile·brew shellenv 를 «안 읽어서» PATH 가 좁고,
 *   그래서 ***설치되어 있는 python 3.11 을 「없다」고 답했다***. 그 오판이 이 함수의 계기다.
 *
 * ⛔⭐ 인용이 «두 겹»이다 — ssh 는 argv 를 공백으로 «이어 붙여» 원격 셸에 넘긴다.
 *   ⇒ `['bash','-lc',cmd]` 로 넘기면 원격이 `bash -lc test -x /p` 로 읽어 **cmd 가 쪼개진다**.
 *   ⇒ 한 덩어리로 «우리가» 인용해서 넘긴다.
 * ⛔ 그리고 `'~/x'` 는 ***틸데가 확장되지 않는다*** — 인용 전에 $HOME 으로 바꾼다.
 */
const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/**
 * ⛔⭐⭐ ***원격 probe 는 「한 번만」 묻는다*** — 2026-09-22 실측으로 붙인 칸.
 *
 * 🩸 계기: `elanous self gate --pr 19644` 가 ***시험 11개를 「시간 초과」***로 냈다.
 *   재보니 `scripts/video-pipeline.test.ts` 가 73초였고, 원인은 «시험»이 아니라 ***내 코드***였다:
 * ```
 *   plan 한 번 = 5,090ms   (ssh probe 7개 «순차» + curl 1개)
 *   그리고 그 시험은 CLI 를 88번 부른다
 * ```
 *   🔑 ***시험의 시간 초과는 「시험이 느리다」가 아니라 「사용자가 매번 내는 값」이다.***
 *     사람이 `plan` 을 칠 때마다 ***5초를 기다린다.*** 시험이 그것을 대신 비명 질러 준 것이다.
 *
 * ⛔ 캐시는 «호스트 단위»다 — 같은 호스트에 일곱 번 붙을 이유가 없다.
 *   ⚠️ 다만 ***「못 쟀다」(null)는 캐시하지 않는다*** — 일시적일 수 있고,
 *     굳히면 한 번 흔들린 네트워크가 런 전체를 결정한다(`reframe.ts` 와 같은 규율).
 */
const SSH_HOST_CACHE = new Map<string, boolean>();

/**
 * ⛔⭐⭐ ***한 호스트에 «한 번만» 붙는다*** — 대상이 일곱이어도 ssh 는 «하나»다.
 *
 * 🩸 실측 2026-09-22: 호스트 캐시만으로는 «안 붙는 경우»만 빨라졌다.
 *   ***붙는 경우엔 여전히 ssh 7번 × 약 700ms = 5초***였다.
 *   🔑 ***「같은 답을 두 번 안 묻는다」와 「한 번에 다 묻는다」는 다른 최적화다.*** 둘 다 필요했다.
 *
 * ⇒ 그 호스트의 «모든» 대상을 한 줄로 만들어 한 번에 묻고, 결과를 «id별로» 받는다.
 * ⛔ 개별 답이 셋이다: `1`(있다) · `0`(없다) · 줄이 «아예 없다»(못 쟀다 — 붙지도 못했다).
 */
const SSH_BATCH: Map<string, Map<string, boolean>> = new Map();

function sshBatchFor(host: string): Map<string, boolean> | null {
  if (host === UNSET_MEDIA_HOST) return null;    // ⛔ media 호스트가 설정에 없다 — ssh 를 «안» 한다
  const cached = SSH_BATCH.get(host);
  if (cached) return cached;
  if (SSH_HOST_CACHE.get(host) === false) return null;
  // 이 호스트를 겨누는 대상을 «전부» 모은다.
  const targets: { id: string; raw: string }[] = [];
  for (const c of CAPS) {
    for (const i of c.impls) {
      if (i.probe.kind !== 'ssh') continue;
      const k = i.probe.value.indexOf(':');
      if (k <= 0 || i.probe.value.slice(0, k) !== host) continue;
      targets.push({ id: i.id, raw: i.probe.value.slice(k + 1) });
    }
  }
  if (targets.length === 0) return null;
  const line = targets.map(({ id, raw }) => {
    const inner = !raw.includes('/')
      ? `command -v ${sq(raw)} >/dev/null`
      : raw.startsWith('~/') ? `test -x "$HOME"/${sq(raw.slice(2))}` : `test -x ${sq(raw)}`;
    // ⛔ id 를 «그대로» 찍는다 — 순서에 기대면 하나가 빠질 때 «전부» 밀린다.
    return `if ${inner}; then echo ${sq(`${id}=1`)}; else echo ${sq(`${id}=0`)}; fi`;
  }).join('; ');
  try {
    // ⛔⭐ 원격의 stderr 를 «흘리지 않는다» — `bash -lc` 는 그 기계의 프로파일 오류를 뱉는다
    //   (실측: node-b 의 `~/.profile` 이 없는 경로를 참조해 매번 한 줄을 낸다).
    //   🩸 그것이 우리 stderr 로 새어 ***시험의 JSON 파싱을 깨뜨렸다.***
    //     ⇒ 남의 기계 사정이 «우리 산출»을 더럽히면 안 된다.
    const out = execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host,
      `bash -lc ${sq(line)}`],
      { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = new Map<string, boolean>();
    for (const l of out.split('\n')) {
      const eq = l.lastIndexOf('=');
      if (eq > 0) m.set(l.slice(0, eq).trim(), l.slice(eq + 1).trim() === '1');
    }
    SSH_HOST_CACHE.set(host, true);
    SSH_BATCH.set(host, m);
    return m;
  } catch {
    // ⛔ 못 붙었다 — 「없다」가 «아니라» 「못 쟀다」다. 그 호스트는 다시 안 묻는다.
    SSH_HOST_CACHE.set(host, false);
    return null;
  }
}

/** ⛔ 원격을 아예 «안 묻는» 길 — 시험·오프라인용. 그때는 「없다」가 아니라 «못 쟀다»로 답한다. */
const SKIP_REMOTE = process.env.ELANOUS_VIDEO_SKIP_REMOTE_PROBE === '1';

const sshProbe = (value: string): boolean | null => {
  const i = value.indexOf(':');
  if (i <= 0) return null;                       // 꼴이 틀리면 «못 쟀다»
  const host = value.slice(0, i), raw = value.slice(i + 1);
  if (host === UNSET_MEDIA_HOST) return null;    // ⛔ 설정에 없는 호스트는 «못 쟀다»
  if (raw.length === 0) return null;             // `host:` 만 오면 «잴 것이 없다»
  // ⛔ 인용이 틸데를 죽인다 — 그래서 `~/` 만 «인용 밖»에 두고 나머지를 인용한다.
  // ⛔ 호스트가 «안 붙는다»고 이미 알면 다시 묻지 않는다 — 7번 × 8초는 사용자가 낼 값이 아니다.
  if (SSH_HOST_CACHE.get(host) === false) return null;   // ⛔ 「없다」가 아니라 «못 쟀다»
  const inner = !raw.includes('/')
    ? `command -v ${sq(raw)} >/dev/null`          // ⓑ PATH 어딘가
    : raw.startsWith('~/')
      ? `test -x "$HOME"/${sq(raw.slice(2))}`     // ⓐ-홈
      : `test -x ${sq(raw)}`;                     // ⓐ-절대
  try {
    // ⛔ BatchMode — 비밀번호를 물으면 «매달린다». 물으면 그것도 「못 쟀다」다.
    execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host,
      `bash -lc ${sq(inner)}`], { stdio: 'ignore', timeout: 20_000 });
    SSH_HOST_CACHE.set(host, true);
    return true;
  } catch (e) {
    // ⛔ 여기서 「false」로 접지 않는다 — 붙었는데 파일이 없는 것(1)과 못 붙은 것(255)은 다르다.
    const code = (e as { status?: number }).status;
    if (code === 1) { SSH_HOST_CACHE.set(host, true); return false; }  // 붙었고 그것이 «없다»
    // ⛔ 못 붙었다 = 「못 쟀다」. ⊕ 그 호스트는 «다시 안 묻는다»(같은 답에 8초를 또 쓰지 않는다).
    SSH_HOST_CACHE.set(host, false);
    return null;
  }
};

/**
 * 🌐 ***「깔려 있나」가 아니라 「지금 붙을 수 있나」***를 잰다 — 2026-09-22 신설.
 *
 * 🩸 계기: Affinity 를 `path`(앱 번들이 있나)로만 재고 ***「몰 수 없다」고 단정***했다.
 *   실제 표면은 ***앱이 품은 MCP 서버***(localhost:6767·SSE)였고, 그것은 파일 경로로는 «원리상» 안 보인다.
 *   ⇒ 🔑 ***probe 의 «종류»가 곧 「내가 무엇을 묻고 있나」다.*** 틀린 종류로 재면 답이 늘 같은 방향으로 틀린다.
 *
 * ⛔ 세 값을 가른다:
 *   true   2xx·3xx 로 답했다
 *   false  ***연결이 거부됐다*** — 그 자리에 아무도 안 듣는다(앱이 꺼졌다)
 *   null   ***못 쟀다*** — 시간 초과·해석 불가 등. 「없다」와 «다른 값»이다.
 */
/**
 * curl 한 번. ⛔ 「상태 코드를 «얻었나»」만 답한다 — 못 얻으면 null(다음 수단으로 간다).
 * ⚠️ 405/501 은 ***「서버는 있는데 HEAD 를 거부한다」***다 — 「없다」가 아니므로 null 로 돌려보낸다.
 */
function tryCurl(args: readonly string[]): boolean | null {
  const read = (e: unknown): number => {
    const err = e as { stdout?: Buffer | string };
    const raw = typeof err.stdout === 'string' ? err.stdout : (err.stdout?.toString('utf8') ?? '');
    return Number(raw.trim());
  };
  let code: number;
  try {
    code = Number(execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', ...args],
      { encoding: 'utf8', timeout: 10_000 }).trim());
  } catch (e) { code = read(e); }
  if (!Number.isFinite(code) || code === 0) return null;
  if (code === 405 || code === 501) return null;   // ⛔ HEAD 거부 — 판정하지 «않는다»
  return code >= 200 && code < 400;
}

const httpProbe = (url: string): boolean | null => {
  // ⛔⭐⭐ ***curl 의 «종료 코드»로 가르면 SSE 를 「죽었다」로 읽는다.***
  //
  // 🩸 실측 2026-09-22 — 살아 있는 Affinity MCP 에 대고:
  // ```
  //   curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://localhost:6767/sse
  //   stdout='200'   exit=28(timeout)
  // ```
  //   ⇒ ***SSE 는 스트림을 «안 닫는 것이 정상»***이라 늘 타임아웃으로 끝난다.
  //   ⛔ 1판은 exit 만 보고 「못 쟀다」로 답했다 — ***살아 있는 서버를 못 찾는 자였다.***
  //
  // 🩸 그리고 나는 이 사실을 ***내 손으로 이미 찍어 놓고 못 읽었다***:
  //   `curl … || echo "(못 붙음)"` 이 **`200` 과 `(못 붙음)` 을 «둘 다»** 찍었는데
  //   나는 200 만 읽고 넘어갔다. ⛔ ***`||` 가 돌았다는 것은 앞이 «실패했다»는 뜻이다.***
  //
  // ⇒ 🔑 ***상태 코드를 얻었으면 그것이 답이다.*** 종료 코드는 「상태 코드를 «못 얻었을 때»」만 본다.
  const read = (e: unknown): { code: number; status: number | undefined } => {
    const err = e as { stdout?: Buffer | string; status?: number };
    const raw = typeof err.stdout === 'string' ? err.stdout : (err.stdout?.toString('utf8') ?? '');
    return { code: Number(raw.trim()), status: err.status };
  };
  try {
    // ⛔⭐⭐ ***이 줄이 `plan` 5초의 «대부분»이었다*** — 2026-09-22 실측.
    //   SSE 는 스트림을 «안 닫는 것이 정상»이라 curl 이 ***붙든 안 붙든 max-time 을 다 쓴다.***
    //   🩸 나는 이것을 `reframe.ts` 에서 «이미» 고쳐 놓고 ***여기서는 안 고쳤다.***
    //     ⇒ 🔑 같은 결함을 두 자리에 심으면, 한 자리를 고쳐도 «나머지가 값을 결정한다».
    //   ⚠️ 그리고 내 1차 가설은 «ssh 7번»이었다 — 재보니 ssh 는 349ms 였다.
    //     ***짐작으로 고쳤으면 엉뚱한 곳을 최적화하고 5초는 그대로였다.***
    //   ✅ 상태 줄은 «즉시» 온다 — 2초면 넉넉하다(스트림을 읽을 «이유가 없다»).
    // ⛔⭐ ***HEAD 로 먼저 묻는다*** — 📏 실측 2026-09-22: `-I` 는 **15ms**, GET 은 **2,026ms**.
    //   SSE 의 GET 은 스트림을 «안 닫아» 언제나 max-time 을 다 쓴다. HEAD 는 헤더만 받고 끝난다.
    //   ⚠️ 다만 ***HEAD 를 거부하는 서버가 있다*** — 그때는 GET 으로 내려간다(정확이 속도보다 먼저다).
    const head = tryCurl(['-I', '--max-time', '3', url]);
    if (head !== null) return head;
    const out = execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}',
      '--max-time', '2', url], { encoding: 'utf8', timeout: 8_000 });
    const code = Number(out.trim());
    if (!Number.isFinite(code) || code === 0) return null;
    return code >= 200 && code < 400;
  } catch (e) {
    // ⛔ 실패했어도 «상태 코드를 얻었으면» 그 서버는 «있다».
    const { code, status } = read(e);
    if (Number.isFinite(code) && code > 0) return code >= 200 && code < 400;
    if (status === 7) return false;                 // 붙을 곳이 «없다»(아무도 안 듣는다)
    return null;                                    // ⛔ 그 밖은 「못 쟀다」 — false 로 접지 않는다
  }
};

/** ⛔ 「못 쟀다」를 «모아 둔다» — 산출이 그것을 말해야 한다(조용히 빠뜨리지 않는다). */
const UNPROBED: { id: string; why: string }[] = [];

/**
 * ⛔⭐⭐ 「이 운영체제엔 «원리상» 없다」 — 2026-09-22 신설.
 *   🔑 ***이것은 「못 쟀다」가 «아니다».*** 확실히 없고, ***왜 없는지도 안다.***
 *     ⇒ 「깔면 된다」와 「이 기계에선 «영영» 안 된다」를 ***섞지 않는다.***
 *   🩸 계기: 🅢 님 보고 — *"리눅스·WSL 에 PTY 가 없고 doctor 가 한 마디도 안 한다"*.
 *     같은 병이 여기 있었다: 리눅스에서 `sips` 가 없으면 그냥 「없다」였다.
 *
 *   ⛔🔁 **2026-09-22 정정 — 계기로 인용한 그 문장을 🅢 가 «철회»했다**(채널 #16815 · 세 번째 정정).
 *     깨끗한 리그에서 재니 리눅스 설치본의 PTY 는 ***돈다***(`SPAWN=ok`). 종전 관측이 무엇이었는지는
 *     본인도 «모른다»고 적었다 — 재현이 안 된다.
 *   ⭐ ***그래도 이 칸은 살아 있다.*** 이 칸의 근거는 그 보고가 «아니라»
 *     ***이 저장소에서 직접 잰 것***이다 — `sips` 는 darwin 전용이고, 리눅스인 척 눌러 봤을 때
 *     「깔면 된다」와 「영영 안 된다」가 같은 얼굴로 나왔다(§ 아래 실물 1회 기록).
 *   🔑 ⇒ **남의 보고는 «형태»만 빌리고, 「이 축에 그 병이 있나」는 내가 다시 잰다.**
 *     그렇게 했기 때문에 그쪽 전제가 뒤집혀도 이 칸이 안 무너진다.
 */
const WRONG_PLATFORM: { id: string; need: string }[] = [];
// ⛔⭐ 「있는데 «못 쓴다»」는 「없다」와 «다른 값»이다 — 처방이 다르다(깔아라 ↔ chmod +x 해라).
//   🩸 2026-09-22 · 🅢 가 node-pty 축에서 먼저 찾은 형태를 이 축에 눌러 보고 같은 구멍을 확인했다.
const UNUSABLE: { id: string; why: string }[] = [];

/**
 * ⛔ 「못 물어본 것」을 «반드시» 말한다 — 안 말하면 「없다」와 «같은 얼굴»이 된다.
 *   🔑 이 파이프라인의 종단이 넷인 이유와 같은 규율이다.
 */
function sayUnprobed(): void {
  for (const u of UNPROBED) console.log(`  ⚠️ ${u.id.padEnd(16)} «못 쟀다» — ${u.why}`);
  // ⛔ 「못 쟀다」·「플랫폼이 아니다」와 «또 다른 줄»이다 — 이것만 사람이 1분에 고칠 수 있다.
  for (const u of UNUSABLE) console.log(`  🔧 ${u.id.padEnd(16)} «있는데 못 쓴다» — ${u.why}`);
  // ⛔ 「못 쟀다」와 «다른 줄»로 낸다 — 둘을 한 줄에 섞으면 「깔면 되나」를 못 묻는다.
  if (WRONG_PLATFORM.length > 0) {
    const by = new Map<string, string[]>();
    for (const w of WRONG_PLATFORM) by.set(w.need, [...(by.get(w.need) ?? []), w.id]);
    for (const [need, ids] of by) {
      console.log(`  🖥️ ${[...new Set(ids)].join(' · ')} — «${need} 전용»이다`
        + ` (이 기계는 ${process.platform}) ⇒ 깔아서 될 일이 «아니다»`);
    }
  }
}

function available(impl: Impl): boolean {
  if (MISSING.has(impl.id)) return false;
  // ⛔ 플랫폼이 «안 맞으면» 재 볼 것도 없다 — 그리고 그 사실을 «이름으로» 남긴다.
  //   ⚠️ 가정 프로파일(detect:false)에서는 이 축을 «안 본다» — 그 프로파일은 «다른 기계»를 말한다.
  if (impl.platform !== undefined && (!MACHINE || MACHINE.detect !== false)
      && impl.platform !== process.platform) {
    WRONG_PLATFORM.push({ id: impl.id, need: impl.platform });
    return false;
  }
  if (MACHINE && MACHINE.detect === false) return HAVE.has(impl.id);
  if (impl.probe.kind === 'mcp') return mcpServerEnabled(impl.probe.value);
  // ⭐ 스킬은 «디렉토리가 있나»로 잰다 — elanous 의 스킬 색인과 같은 뿌리(`~/.claude/skills`).
  //   ⛔ 「있다」가 「지금 렌더된다」는 아니다. 그 사실은 선언의 note 가 갖는다.
  if (impl.probe.kind === 'skill') return existsSync(join(homedir(), '.claude', 'skills', impl.probe.value));
  if (impl.probe.kind === 'path') {
    const r = pathProbe(impl.probe.value);
    // ⛔ 「없다」로 «접지 않는다» — 있는데 실행 권한이 없는 것은 다른 사실이고 처방도 다르다.
    if (r === 'not-executable') {
      UNUSABLE.push({ id: impl.id, why: `${impl.probe.value} 가 «있는데» 실행 권한이 없다 ⇒ chmod +x 로 산다` });
    }
    return r === 'ok';
  }
  // ⛔ 원격을 건너뛸 때도 ***「없다」로 접지 않는다*** — 「안 물어봤다」로 «남긴다».
  if (SKIP_REMOTE && (impl.probe.kind === 'ssh' || impl.probe.kind === 'http')) {
    UNPROBED.push({ id: impl.id, why: 'ELANOUS_VIDEO_SKIP_REMOTE_PROBE=1 — 원격을 «안 물어봤다»' });
    return false;
  }
  if (impl.probe.kind === 'http') {
    const r = httpProbe(impl.probe.value);
    if (r === null) {
      UNPROBED.push({ id: impl.id, why: `${impl.probe.value} 를 «못 물어봤다» — 응답도 거부도 아니었다` });
      return false;
    }
    return r;
  }
  if (impl.probe.kind === 'ssh') {
    // ⛔⭐ 한 호스트에 «한 번만» 붙는다 — 배치가 답을 갖고 있으면 그것을 쓴다.
    const host = impl.probe.value.slice(0, Math.max(0, impl.probe.value.indexOf(':')));
    const batch = host.length > 0 ? sshBatchFor(host) : null;
    const r = batch !== null ? (batch.get(impl.id) ?? null) : sshProbe(impl.probe.value);
    if (r === null) {
      UNPROBED.push({ id: impl.id, why: host === UNSET_MEDIA_HOST
        ? 'ssh 로 못 물어봤다 — media 호스트가 설정에 없다(~/.elanous/ssh-hosts.json 에 `roles: ["media"]` 또는 ELANOUS_MEDIA_HOST)'
        : `ssh 로 못 물어봤다 — ${host} 가 꺼졌거나 못 붙는다` });
      return false;                               // ⛔ 고르지는 않되, «왜»를 남긴다
    }
    return r;
  }
  try { execFileSync('which', [impl.probe.value], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

const TIER_MARK: Record<Tier, string> = { free: '🟢free', owned: '🔵owned', metered: '🟠metered' };

// ⛔ `writeStdoutJson` 을 «기다려야» 하므로 async 다 — 그것이 이 함수가 async 인 «유일한» 이유다.
//   ⚠️ 호출부도 `await` 해야 한다. 안 하면 ***프로세스가 먼저 끝나 그 바이트가 사라진다***
//     (바로 그 결함을 막으려고 바꾼 것인데, 호출부를 빠뜨리면 같은 결함이 남는다).
/**
 * ⛔ 호스트 축이 «있는» 구현의 한 줄. `--verify-hosts` 가 없으면 종전처럼 «모른다»고만 말한다.
 *   ⛔ 물어서 답을 못 얻으면 ***「안 붙었다」가 아니라 「못 쟀다」***로 말한다.
 *   ⛔ 선언에 `hostKey` 가 없으면 물을 «주소»가 없는 것이다 — 그것도 그대로 말한다.
 */
/**
 * ⛔⭐ ***판정은 «한 벌»이다*** — 사람 화면과 JSON 이 이 함수만 쓴다.
 *   (#19808 에서 같은 병을 고쳤다: 술어를 두 벌 쓰면 라벨과 계산이 갈라진다.)
 *   🔑 결과가 «셋»이 아니라 «여섯»인 이유: ***「못 쟀다」를 한 칸으로 접으면 처방이 안 나온다.***
 *      선언에 주소가 없다(`no-host-key`) · 물었는데 답이 없다(`unmeasured`) ·
 *      답은 왔는데 그 칸이 없다(`no-field`) — 셋은 고치는 자리가 «전부 다르다».
 */
function hostState(i: Impl): HostState {
  if (!flag('verify-hosts')) return 'not-asked';
  if (!i.hostKey) return 'no-host-key';
  const st = hostStatus(i.probe.value);
  if (st === null) return 'unmeasured';
  if (!(i.hostKey in st)) return 'no-field';
  return st[i.hostKey] ? 'connected' : 'disconnected';
}

function hostVerdict(i: Impl): string {
  const st = hostState(i);
  const mark = st === 'connected' ? '🟡' : (st === 'disconnected' ? '⛔' : '⚠️');
  return `  ${mark}${hostLabel(st, i.hostKey)}`;
}


/**
 * ⛔⭐⭐ ***「선언에 이름이 있다」와 「그 이름이 «묶여» 있다」는 다른 값이다.***
 *
 * 🩸 2026-09-23 실측 — 나는 RFC 에 *"레시피 77개 중 코드에 닿는 것이 사실상 0"* 이라 썼다. ***두 번 틀렸다.***
 *   ⑴ kebab 이름(`place-clips`)으로 `src/` 를 grep 했는데 ***코드는 camelCase(`placeClips`)를 쓴다.***
 *      → 실제로 닿는 것은 «0이 아니라 14» 였다.
 *   ⑵ *"그 이름을 부를 자리가 없다"* 도 거짓 — `scripts/video-free-line.ts:35` 가
 *      `RECIPES[node.recipe]` 로 «이미» 디스패치한다. 못 찾으면 조용히 넘기지도 않는다(`unmeasurable`).
 *
 * 🔑 ⇒ 진짜 구멍은 「부르는 자리」가 아니라 ***「돌려 보기 «전»에 아무도 안 세는 것」***이다.
 *   런타임은 정직하지만 «그 템플릿을 돌려야만» 안다. 이 명령이 그것을 정적으로 답한다.
 *
 * ⛔ 기본은 «막지 않는다»(exit 0) — 안 묶인 자리가 남아 있고(수는 이 명령이 «그때» 센다), 막으면 관문이 고장의 원인이 된다.
 *   `--strict <graph_id>` 로 ***묶임이 완결된 템플릿만*** 래칫을 건다(되돌아가면 빨강).
 */
async function recipes(): Promise<number> {
  const BOUND: Readonly<Record<string, unknown>> = ALL_RECIPES;
  const dir = join(HERE, '..', 'graphs', 'video');
  type Row = { file: string; graphId: string; parsed: boolean; total: number; terminal: number; bound: string[]; unbound: string[] };
  const rows: Row[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.yaml')).sort()) {
    const raw = readFileSync(join(dir, f), 'utf8');
    const parsed = parseGraphTemplateYaml(raw, f);
    const recs = [...new Set([...raw.matchAll(/recipe:\s*([\w-]+)/g)].map((m) => m[1]!))];
    // ⛔ 종단 노드는 「일을 하는 레시피」가 아니다 — 갈라 센다. 접으면 구멍 수가 부풀어 자가 못 쓰게 된다.
    const terminal = recs.filter((r) => r.startsWith('terminal-'));
    const live = recs.filter((r) => !r.startsWith('terminal-'));
    // ⛔ 「파싱 못 했다」를 «깨끗하다»로 말하지 않는다 — 안 묶인 것이 0이어도 그것은 「잰 0」이 아니다.
    rows.push({ file: f, graphId: parsed.template?.graphId ?? '', parsed: parsed.template !== undefined,
      total: recs.length, terminal: terminal.length,
      bound: live.filter((r) => r in BOUND), unbound: live.filter((r) => !(r in BOUND)) });
  }
  const strict = opt('strict') || undefined;
  if (flag('json')) {
    await writeStdoutJson(JSON.stringify({ source: PROVENANCE, boundTotal: Object.keys(BOUND).length,
      templates: rows, strict: strict ?? null }, null, 2) + '\n');
    return strictVerdict(rows, strict);
  }
  console.log('🧬 레시피 «묶임» — 선언의 이름이 실행 가능한 구현에 닿나\n');
  console.log(`   런타임에 묶인 레시피 ${Object.keys(BOUND).length}개 (UPSTREAM ⊕ FREE_LINE ⊕ VLOG ⊕ FILM ⊕ CHARACTER)\n`);
  for (const r of rows) {
    // ⛔ 셋으로 가른다 — 「묶임 완결」 · 「구멍 있음」 · ***「못 쟀다」***. 셋째를 첫째로 접으면 거짓이 된다.
    const mark = !r.parsed ? '🔲' : (r.unbound.length === 0 ? '✅' : '⛔');
    const label = r.parsed ? r.graphId : `${r.file} «파싱 실패»`;
    console.log(`${mark} ${label.padEnd(26)} 레시피 ${String(r.total).padStart(2)} (종단 ${r.terminal}) · 묶임 ${String(r.bound.length).padStart(2)} · 안 묶임 ${r.unbound.length}`);
    if (!r.parsed) console.log('     🔲 로더가 못 읽는다 — 「안 묶인 게 0」이 아니라 「못 쟀다」다');
    else if (r.unbound.length > 0) console.log(`     ⛔ ${r.unbound.join(' · ')}`);
  }
  const holes = rows.reduce((a, r) => a + r.unbound.length, 0);
  const unread = rows.filter((r) => !r.parsed).length;
  const uniq = new Set(rows.flatMap((r) => r.unbound)).size;
  console.log(`\n📊 템플릿 ${rows.length}(못 읽음 ${unread}) · 안 묶인 자리 ${holes}개 · 고유 이름 ${uniq}개`);
  console.log('   ⇒ 안 묶인 이름을 가진 노드는 실행 시 «unmeasurable» 로 답한다 — 조용히 통과하지 «않는다».');
  if (!strict) console.log('   ⛔ 이 명령은 «막지 않는다». 완결된 템플릿에 래칫을 걸려면 --strict <graph_id>.');
  return strictVerdict(rows, strict);
}

/** ⛔ 래칫 — 「지금보다 나빠지면」 빨강이다. 「지금과 다르면」이 아니다(그건 개선도 막는다). */
function strictVerdict(rows: { graphId: string; parsed: boolean; unbound: string[] }[], strict: string | undefined): number {
  if (!strict) return 0;
  const row = rows.find((r) => r.graphId === strict);
  if (!row) { console.error(`⛔ --strict 가 가리킨 그래프가 «없다»: ${strict}`); return 2; }
  if (!row.parsed) { console.error(`⛔ --strict ${strict} — 그 선언을 «못 읽었다». 0은 「잰 0」이 아니다`); return 2; }
  if (row.unbound.length === 0) { console.log(`✅ --strict ${strict} — 안 묶인 레시피 0개`); return 0; }
  console.error(`⛔ --strict ${strict} — 안 묶인 레시피 ${row.unbound.length}개: ${row.unbound.join(', ')}`);
  return 1;
}

/**
 * ⛔⭐ ***여유 메모리*** — 총량이 아니다. 인계(§4-1 ⓐ)가 못 박았다:
 *   *"시스템에서도 쓰고 다른 프로그램도 열려 있으니 48기가를 다 쓸 순 없다. 표는 «여유 메모리» 기준이다."*
 * ⛔ 못 재면 `null` — 0 이 아니다. 「못 쟀다」를 「없다」로 접으면 전부 «안 된다»로 찍힌다.
 */
const REMOTE_RAM = new Map<string, number | null>();
/**
 * ⛔⭐⭐ ***어느 기계의 여유 메모리인가*** — 2026-09-23.
 * 🩸 초판은 «이 노트북»의 여유(70GB)를 ssh 구현(`node-b` 에서 도는 것)과 견줬다. ***틀린 기계다.***
 *   node-b 은 여유 435GB 다 — 여기서 「안 된다」가 나오면 그것은 «거짓»이다.
 * ⇒ 구현의 `probe.kind` 가 `ssh` 면 ***그 호스트에게 묻는다***. 호스트당 한 번만.
 */
function freeRamGbOf(impl: Impl): number | null {
  if (impl.probe.kind !== 'ssh') return freeRamGb();
  const host = impl.probe.value.slice(0, Math.max(0, impl.probe.value.indexOf(':')));
  if (host.length === 0) return null;
  if (REMOTE_RAM.has(host)) return REMOTE_RAM.get(host)!;
  let v: number | null = null;
  try {
    const out = execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, 'vm_stat'],
      { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] });
    v = parseVmStat(out);
  } catch { v = null; }   // ⛔ 「못 쟀다」 — 0 이 아니다
  REMOTE_RAM.set(host, v);
  return v;
}

function parseVmStat(out: string): number | null {
  const page = Number(out.match(/page size of (\d+)/)?.[1] ?? 0);
  const pick = (label: string): number => Number(out.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] ?? 0);
  const free = pick('Pages free') + pick('Pages inactive');
  if (!page || !free) return null;
  return Math.round((free * page) / 1073741824);
}

function freeRamGb(): number | null {
  try {
    const out = execFileSync('vm_stat', [], { encoding: 'utf8', timeout: 8000 });
    return parseVmStat(out);
  } catch { return null; }
}

async function probe() {
  printProvenance();
  const rows = CAPS.map((c) => {
    const found = c.impls.filter(available);
    return { cap: c.id, what: c.what, found, all: c.impls.length };
  });
  if (flag('json')) {
    // ⛔⭐⭐ 17차 리뷰 ② — 사람 글에는 「⚠️ 프로파일 가정」을 붙였는데 ***JSON 엔 안 붙였다***.
    //   ⇒ 기계가 읽는 계약에서 ***출처가 통째로 사라졌다***. 사람보다 «기계»가 더 위험한 쪽이다.
    //   🔑 ***출처는 렌더가 아니라 값이다.*** 두 서피스에 따로 붙이면 한쪽이 반드시 샌다.
    // ⛔⭐ `found` 를 «이름만»으로 내면 ***「무료가 있나」를 기계가 못 묻는다.***
    //   🩸 2026-09-22: 매뉴얼에 적힌 「무료 구현이 있는 능력 16/19」를 «이 도구로» 다시 재려 했더니
    //      tier 가 JSON 에 «없어서» 못 쟀다 — 셀 수는 있는데 ***무료인지를 알 수 없었다.***
    //      ⇒ 결국 모듈을 직접 import 해서 셌다. ***도구가 못 답하면 그 수는 곧 늙는다.***
    //   🔑 같은 결함 가족: 「사람 화면엔 있는데 JSON 엔 없다」 — 바로 위 주석과 «같은 자리»다.
    const byTier = (r: (typeof rows)[number], t: Tier): number => r.found.filter((i) => i.tier === t).length;
    // ⛔⭐⭐ ***`console.log(JSON.stringify(...))` 는 바이트를 «잃을 수 있다».***
    //   프로세스가 끝나면서 stdout 이 다 비워지기 «전»에 나갈 수 있고, 그러면
    //   ***기계가 읽는 계약이 「잘린 JSON」으로 도착한다*** — 그리고 그것은 「빈 산출」처럼 보인다.
    // 🩸 2026-09-22: 이 규칙의 게이트(`ci-stdout-json-gate`)가 «있었는데 아무 데도 안 걸려 있었다»
    //   (🅢 보고 · #19747). 그래서 내 PR 이 4건을 이고 있었고 ***나는 몰랐다.***
    //   🔑 ***「관문이 있다」와 「그 관문이 «불린다»」는 다른 값이다.***
    await writeStdoutJson(JSON.stringify({
      source: PROVENANCE,
      capabilities: rows.map((r) => ({
        cap: r.cap, what: r.what, all: r.all,
        found: r.found.map((i) => ({ id: i.id, tier: i.tier, drive: i.drive ?? 'headless', provider: i.provider ?? null })),
        // ⛔ 「발견된 것 중 무료」와 「선언에 무료가 있나」는 다른 값이다 — 둘 다 낸다.
        freeFound: byTier(r, 'free'),
        // ⛔ 같은 규칙 — 사람 화면이 말하는 호스트 축을 기계도 받는다(같은 `hostState` 한 벌).
        hosts: r.found.filter((i) => i.drive === 'app-attached')
          .map((i) => ({ impl: i.id, hostKey: i.hostKey ?? null, state: hostState(i) })),
        freeDeclared: CAPS.find((c) => c.id === r.cap)?.impls.some((i) => i.tier === 'free') ?? false,
      })),
      unprobed: UNPROBED,
      unusable: UNUSABLE,
      // ⛔ 사람 화면에 있는 축은 «반드시» JSON 에도 둔다 — 안 그러면 기계 쪽에서 통째로 사라진다.
      wrongPlatform: WRONG_PLATFORM,
      // ⛔ 위 규칙 그대로 — 사람 화면의 「과금 강제」 축을 기계에도 낸다.
      //    ⚠️ 이름을 «계산»과 맞춘다: `freeReachable`=some · `freeOnly`=every · `paidOnly`=none.
      //    종전 사람 화면은 `every` 를 재고 「무료만으로 채워지는」이라 적어 3 과 16 을 뒤섞었다.
      summary: summarizeTiers(rows),
      platform: process.platform,
    }, null, 2) + '\n');
    return;
  }

  if (COMPACT) {
    const mark: Record<Tier, string> = { free: '🟢', owned: '🔵', metered: '🟠' };
    const L: string[] = [`🔎 능력 ${MACHINE_NAME ? `· 기계 ${MACHINE_NAME}` : '· 이 기계'}`, ''];
    for (const r of rows) {
      const best = r.found[0];
      L.push(best ? `${mark[best.tier]} ${r.cap.padEnd(15)} ${best.id}` : `⛔ ${r.cap.padEnd(15)} 없음`);
    }
    const dead = rows.filter((r) => r.found.length === 0);
    L.push('', `능력 ${rows.length} · 없음 ${dead.length}`);
    console.log(L.join('\n'));
    return;
  }

  const who = MACHINE ? `기계 «${MACHINE_NAME}»${MACHINE.detect === false ? ' (가정 — 실측 안 함)' : ''}` : '이 기계 (실측)';
  console.log(`\n🔎 능력 — ${who}`);
  console.log(`   설정: ${LOADED.source}${MACHINE?.note ? `\n   메모: ${MACHINE.note}` : ''}\n`);
  for (const r of rows) {
    const ok = r.found.length > 0;
    console.log(`${ok ? '✅' : '⛔'} ${r.cap.padEnd(16)} ${r.what}`);
    if (!ok) { console.log(`     ⛔ 구현 ${r.all}개 «전부» 없다 — 이 능력을 요구하는 노드는 못 돈다`); continue; }
    for (const i of r.found) {
      // ⛔⭐ 2026-09-22 — 이 한 줄이 «두 번» 과하게 말하고 있었다.
      //   ⓐ 「서버만 «확인»」 — ***확인한 적이 없다.*** `mcpServerEnabled()` 는 `~/.elanous/config.json` 을
      //      읽어 「설정에 있고 enabled 인가」만 본다. 서버를 «찌르지 않는다».
      //   ⓑ 「호스트 미확인」 — 호스트 축이 «있는» 구현에만 해당한다. 실측: mcp 탐침 14개 중
      //      호스트가 있는 것은 `drive === 'app-attached'` 셋뿐이고, 나머지 11개(topview·epidemic)는
      //      클라우드 서비스라 ***붙을 앱이 없다.*** 그런데 14개 전부에 같은 말을 붙이고 있었다.
      //   ⇒ 축을 갈라 말한다. 호스트 축은 `probe.kind` 가 아니라 `drive` 가 갖는다.
      // ⛔⭐ 축이 «둘»이고 겹치지 않는다 — 접으면 한쪽 표면에서만 사라진다(#19808 과 같은 병).
      //   ⓐ 탐침 낙관 = `probe.kind === 'mcp'` (설정만 읽었다 · 서버를 안 찔렀다)
      //   ⓑ 호스트 축 = `drive === 'app-attached'` (붙을 앱이 있다) — ***탐침 종류와 무관하다***
      //     예: affinity 는 `http` 탐침인데 app-attached 다. 종전엔 ⓐ 안에 ⓑ 를 넣어
      //     ***JSON 은 affinity 를 담고 사람 화면은 안 담는*** 어긋남이 났다.
      const probeNote = i.probe.kind === 'mcp'
        ? (i.drive === 'app-attached' ? '  ⚠️설정만 확인(서버 미확인)' : '  ⚠️설정만 확인 — 서버 «미확인»(호스트 축 없음)')
        : '';
      const optimistic = `${probeNote}${i.drive === 'app-attached' ? hostVerdict(i) : ''}`;
      console.log(`     ${TIER_MARK[i.tier]}  ${i.id}${i.unitCost ? `  (${i.unitCost})` : ''}${optimistic}`);
    }
  }
  const dead = rows.filter((r) => r.found.length === 0);
  // ⛔⭐ 칸 이름이 계산과 어긋나 있었다(2026-09-22). 종전 한 줄은 `every(tier==='free')` 를 재면서
  //    라벨은 「무료만으로 채워지는 능력」이라 적었다 — 읽는 사람은 그것을 `some`(무료로 «될 수 있다»)으로
  //    읽는다. 실측 차이가 ***3 대 16*** 이었다. 그리고 정작 결정을 가르는 사실
  //    (「무료가 «하나도» 없어서 돈을 써야만 하는 능력」)은 ***한 줄도 안 찍혔다.***
  //    ⇒ 이 파이프라인의 목적이 「크레딧 0 으로 끝까지」이므로 그 수가 1급이다.
  // ⛔⭐ 「있다」와 「이 기계에서 돌 만한가」는 다른 값이다 — 인계 §4 의 RAM 바닥이 그 답이다.
  const ram = freeRamGb();
  const tooBig = rows.flatMap((r) => r.found
    .filter((i) => i.minFreeRamGb !== undefined)
    .map((i) => ({ cap: r.cap, id: i.id, need: i.minFreeRamGb!, have: freeRamGbOf(i),
      where: i.probe.kind === 'ssh' ? i.probe.value.split(':')[0]! : '이 기계' }))
    .filter((x) => x.have !== null && x.need > x.have));
  const declaredRam = rows.flatMap((r) => r.found).filter((i) => i.minFreeRamGb !== undefined).length;
  const { freeReachable, freeOnly, paidOnly } = summarizeTiers(rows);
  console.log(`\n📊 능력 ${rows.length} · 구현 있음 ${rows.length - dead.length} · 없음 ${dead.length}`);
  console.log(`   🟢 무료로 «채울 수 있는» 능력 ${freeReachable.length}개 (무료 대안이 하나라도 있다)`);
  console.log(`      ↳ 그중 무료 «뿐»인 능력 ${freeOnly.length}개 (유료 대안이 아예 없다)`);
  // ⛔ 셋으로 말한다 — 「못 쟀다」를 침묵으로 두지 않는다.
  if (ram === null) console.log('   🔲 여유 메모리를 «못 쟀다» — RAM 바닥 판정을 할 수 없다(vm_stat 실패)');
  else if (tooBig.length > 0) {
    console.log(`   🧠 여유 메모리 ${ram}GB — ⛔ 바닥을 못 넘는 구현 ${tooBig.length}개`);
    for (const t of tooBig) console.log(`      ⛔ ${t.id} (${t.cap}) — ${t.need}GB 필요 · ${t.where} 의 여유 ${t.have}GB`);
  } else console.log(`   🧠 여유 메모리 ${ram}GB — 바닥이 «선언된» ${declaredRam}개가 전부 넘는다 (⚠️ 안 선언된 것은 «안 잰» 것이다)`);
  if (paidOnly.length) {
    console.log(`   💳 무료가 «하나도» 없어 과금이 강제되는 능력 ${paidOnly.length}개: ${paidOnly.join(', ')}`);
    console.log(`      ⇒ 이 능력을 «요구하지 않는» 레시피만이 크레딧 0 으로 끝까지 간다.`);
  } else {
    console.log(`   ✅ 과금이 강제되는 능력 0개 — 전 능력이 크레딧 0 으로 도달 가능하다.`);
  }
  if (dead.length) console.log(`   ⛔ 채울 수 없는 능력: ${dead.map((d) => d.cap).join(', ')}`);
  // ⛔⭐ ***이 줄이 없어서 `probe` 는 「왜 없는지」를 한 마디도 안 했다.***
  //   🩸 `sayUnprobed()` 가 `plan` «에서만» 불리고 있었다 — 나는 「배선했다」고 생각했고,
  //     리눅스인 척 눌러 보고서야 알았다. 🔑 ***칸을 만든 것 ≠ 그 칸이 «불린다».***
  sayUnprobed();
}

async function plan() {
  const need = new Set(list('need'));
  // ⛔ 없는 능력 이름을 조용히 버리지 않는다 — 요청이 «사라진» 계획을 내면 그것은 거짓이다.
  const unknownCaps = [...need].filter((c) => !CAP_BY_ID.has(c));
  if (unknownCaps.length) {
    console.error(`⛔ --need 에 없는 능력: ${unknownCaps.join(', ')}`);
    console.error(`   가능: ${CAPS.map((c) => c.id).join(' · ')}`);
    process.exit(2);
  }
  const preferRaw = opt('prefer', CFG.prefer ?? 'free');
  const TIERS: readonly Tier[] = ['free', 'owned', 'metered'];
  if (!TIERS.includes(preferRaw as Tier)) {
    console.error(`⛔ --prefer '${preferRaw}' 는 없는 값이다. 가능: ${TIERS.join(' · ')}`);
    process.exit(2);
  }
  const prefer = preferRaw as Tier;
  const seg = segmentOf(opt('from', 'ground'), opt('to') || undefined);
  const nodes = seg.nodes;
  if (seg.error) {
    // ⛔ 「비었다」로 뭉개지 않는다 — 오타와 역순은 처방이 다르다.
    const e = seg.error;
    if (e.kind === 'inverted') {
      console.error(`⛔ 구간이 뒤집혔다 — '${e.from}' 가 '${e.to}' «뒤»에 있다.`);
      console.error(`   뼈대 순서: ${SPINE.map((n) => n.id).join(' → ')}`);
    } else {
      const which = e.kind === 'unknown-from' ? '--from' : '--to';
      console.error(`⛔ ${which} '${e.name}' 는 뼈대에 «없는» 노드다.`);
      const near = SPINE.map((n) => n.id).filter((id) => id.startsWith(e.name.slice(0, 3)));
      if (near.length) console.error(`   비슷한 것: ${near.join(' · ')}`);
      console.error(`   전체: ${SPINE.map((n) => n.id).join(' · ')}`);
    }
    process.exit(2);
  }

  const order: Tier[] = prefer === 'free' ? ['free', 'owned', 'metered'] : ['owned', 'free', 'metered'];

  // ⭐⭐ 과금 «출처»가 둘 이상일 때의 정책 — 이것이 곧 크레딧 관리다.
  //   ① --provider-order 로 사람이 정한 순서가 «이긴다»
  //   ② 없으면 무료 할당이 있는 쪽부터 태운다(hasFreeQuota)
  //   ⛔ 잔량을 «실제로» 재지는 않는다 — 재려면 데몬이 필요하고, 그 사실을 화면에 말한다.
  const PROVIDER_ORDER = list('provider-order');
  // ⛔ 6차 리뷰(should-fix) — 오타가 나면 «모든 구현이 같은 순위»로 남아 사람이 정한 과금 순서가
  //   조용히 무시됐다. 「지정했는데 안 먹었다」가 가장 비싼 침묵이다.
  if (PROVIDER_ORDER.length > 0) {
    const known = new Set(CAPS.flatMap((c) => c.impls.map((i) => i.provider).filter(Boolean) as string[]));
    const unknown = PROVIDER_ORDER.filter((p) => !known.has(p));
    if (unknown.length > 0) {
      console.error(`⛔ --provider-order 에 «레지스트리에 없는» provider: ${unknown.join(', ')}`);
      console.error(`   가능: ${[...known].sort().join(' · ') || '(과금 구현이 하나도 없다)'}`);
      process.exit(2);
    }
  }
  const rankMetered = (a: Impl, b: Impl): number => {
    if (PROVIDER_ORDER.length) {
      const ia = PROVIDER_ORDER.indexOf(a.provider ?? ''), ib = PROVIDER_ORDER.indexOf(b.provider ?? '');
      const na = ia < 0 ? 99 : ia, nb = ib < 0 ? 99 : ib;
      if (na !== nb) return na - nb;
    }
    const fa = a.hasFreeQuota ? 0 : 1, fb = b.hasFreeQuota ? 0 : 1;
    return fa - fb;
  };

  /** ⭐ 「붙지 않아서 뺐다」를 «말하려고» 기록한다 — 조용히 빼면 「원래 없었다」와 구별이 안 된다. */
  const HOST_EXCLUDED = new Map<string, string>();
  const pick = (capId: string): { impl?: Impl; alts?: Impl[] } => {
    const cap = CAP_BY_ID.get(capId);
    if (!cap) return {};
    // ⛔⭐⭐ ***「안 붙었다」만 뺀다 — 「붙었다」로는 «고르지» 않는다.***
    //   골 `ASK-installed-and-usable-right-now-are-different-values-2026-09-22` 의 교리:
    //   > ***reachable 의 긍정은 언제나 «프로토콜 왕복»이다. 관측은 «부정에만» 싸게 쓴다.***
    //   ⇒ `disconnected`(벤더가 명시적으로 «아니다»라 답한 것)만 후보에서 뺀다.
    //     `unmeasured`·`no-field`·`not-asked` 는 ***「없다」가 아니므로 빼지 않는다.***
    //   🩸 계기: 그 골의 ⑵ 가 *"Premiere 확장 패널을 «닫은» 채로 plan 을 돌리면 premiere 가 «안 골라진다»
    //     (오늘은 골라졌다 — 그게 이 골의 계기다)"* 라고 적었다. 종전엔 호스트를 아예 안 봤다.
    const all = cap.impls.filter(available);
    const { kept: found, dropped } = gateByHost(all,
      (i) => (i.drive === 'app-attached' ? hostState(i) : 'no-host-key'));
    for (const e of dropped) HOST_EXCLUDED.set(e.id, capId);
    if (found.length === 0) return {};
    for (const t of order) {
      const same = found.filter((i) => i.tier === t);
      if (same.length === 0) continue;
      const sorted = t === 'metered' ? [...same].sort(rankMetered) : same;
      return { impl: sorted[0], alts: sorted.slice(1) };
    }
    return { impl: found[0] };
  };

  const gaps: string[] = [];
  const metered: Impl[] = [];
  const ALTS = new Map<string, Impl[]>();
  const out: { node: string; what: string; picks: { cap: string; impl?: Impl; required: boolean }[] }[] = [];

  for (const n of nodes) {
    const caps = [
      ...n.needs.map((c) => ({ c, required: true })),
      ...(n.optional ?? []).filter((c) => need.has(c)).map((c) => ({ c, required: false })),
    ];
    const picks = caps.map(({ c, required }) => {
      const { impl, alts } = pick(c);
      if (alts?.length) ALTS.set(c, alts);
      if (!impl && required) gaps.push(`${n.id}/${c}`);
      if (impl?.tier === 'metered') metered.push(impl);
      return { cap: c, impl, required };
    });
    out.push({ node: n.id, what: n.what, picks });
  }

  // ⛔ 요청했는데 «어느 노드도 안 쓰는» 능력을 조용히 버리지 않는다.
  //   ⭐ compact «보다 먼저» 센다 — 좁은 서피스일수록 「빠진 것」을 말해야 한다.
  const usedCaps = new Set(out.flatMap((o) => o.picks.map((p) => p.cap)));
  const unusedNeeds = [...need].filter((c) => !usedCaps.has(c));
  const unusedLines = unusedNeeds.map((u) => {
    const where = SPINE.filter((n) => (n.optional ?? []).includes(u) || n.needs.includes(u)).map((n) => n.id);
    return where.length ? `${u} → 구간을 «${where.join('/')}» 까지` : `${u} → ⛔ 스핀 결손`;
  });

  if (COMPACT) {
    sayUnprobed();
    // ⛔ 노드별로 찍지 않는다 — encode 가 세 번 나온다. 능력 단위로 «접는다».
    const seen = new Map<string, { impl?: Impl; required: boolean }>();
    for (const o of out) for (const p of o.picks) {
      const prev = seen.get(p.cap);
      if (!prev || (p.required && !prev.required)) seen.set(p.cap, { impl: p.impl, required: p.required });
    }
    const mark: Record<Tier, string> = { free: '🟢', owned: '🔵', metered: '🟠' };
    const L: string[] = [];
    L.push('🧱 추천 스택');
    L.push(`구간 ${nodes[0].id} → ${nodes[nodes.length - 1].id}`);
    L.push(`선호 ${prefer}${MACHINE_NAME ? ` · 기계 ${MACHINE_NAME}` : ''}`);
    L.push('');
    for (const [cap, v] of seen) {
      const tag = v.required ? '必' : '選';
      if (!v.impl) { L.push(`${tag} ${cap.padEnd(15)} ⛔ 없음`); continue; }
      const cost = v.impl.unitCost ? ` ${v.impl.unitCost}` : '';
      L.push(`${tag} ${cap.padEnd(15)} ${mark[v.impl.tier]} ${v.impl.id}${cost}`);
    }
    L.push('');
    const uniq = [...new Map(metered.map((m) => [m.id, m])).values()];
    L.push(uniq.length === 0 ? '💰 과금 없음' : `💰 과금 ${uniq.length}개: ${uniq.map((m) => m.id).join(', ')}`);
    // ⛔ compact 라고 «미확인»을 지우지 않는다 — 좁은 서피스일수록 단정이 위험하다.
    //   📏 리뷰 지적: mcp probe 는 «서버 설정»만 보는데 telegram 출력이 「끝까지 돈다」로 단언했다.
    const unverified = [...seen.values()]
      .filter((v) => v.impl?.probe.kind === 'mcp').map((v) => v.impl!.id);
    if (gaps.length) L.push(`⛔ 구멍 ${gaps.length}: ${gaps.join(', ')}`);
    // ⛔⭐ 15차 리뷰 ③ — 가정 표기를 «한 갈래»에만 붙였더니, 미확인 갈래로 새면 사라졌다.
    //   ⇒ 갈래마다 붙이지 않는다. ***접미로 «항상» 붙인다.*** 조건이 늘어도 안 샌다.
    else if (unverified.length) L.push(`⚠️ 구멍 없음 — 단 ${unverified.length}개는 «호스트 미확인»${ASSUME_SUFFIX}`);
    else L.push(`✅ 구멍 없음${ASSUME_SUFFIX}`);
    if (unverified.length) L.push(`   미확인: ${unverified.join(', ')} → probe --verify-hosts 로 «도구가» 묻는다`);
    if (unusedLines.length) {
      L.push('');
      L.push(`⚠️ 요청했는데 «안 쓰임» ${unusedLines.length}개`);
      for (const u of unusedLines) L.push(`  ${u}`);
    }
    L.push('');
    L.push(`🧩 시작에 필요: ${nodes[0].inputs.join(' · ')}`);
    const text = L.join('\n');
    console.log(text);
    // ⛔ 상한을 «말한다» — 조용히 잘리면 스택의 뒷부분이 사라진다.
    if (SURFACE === 'telegram' && text.length > 3800) {
      console.log(`\n⚠️ ${text.length}자 — 텔레그램 스트리밍 상한(3800)을 넘는다. 구간을 좁혀라.`);
    }
    return;
  }

  // ⛔⭐⭐⭐ ***그래프 오버레이*** — 「기본 템플릿을 목적에 맞게 «변형»한다」(RFC 2026-09-23 §6 ①).
  //   🩸 실측 2026-09-23: 엔진(`graph-overlay-yaml.ts`)은 «이미» 영상 선언에 오버레이를 얹을 수 있었다
  //     (선언 파싱 오류 0 · 적용 ok · compose·render 의 maxVisits 5→7). ***막힌 것은 엔진이 아니라
  //     「그것을 부르는 자리가 제품에 없다」*** 였고, 조건이 함수 꼴이라 판정이 전부 `unparseable` 이었다.
  //   ⛔ 기본은 «안 얹는다» — 계획의 뜻이 조용히 바뀌면 안 된다. `--overlay` 로만 켠다.
  //   ⛔ 「안 얹혔다」의 이유를 «다섯»으로 갈라 낸다(엔진이 이미 그렇게 답한다) —
  //     does-not-apply(정상) · key-absent(계측 결손) · unparseable(오버레이 결함) ·
  //     wrong-stage · target-mismatch. 한 칸으로 접으면 처방이 안 나온다.
  const pickedForOverlay: PickedForOverlay[] = out.flatMap((o) => o.picks)
    .map((p) => ({ cap: p.cap, tier: p.impl?.tier ?? null }));
  // ⭐ RFC §4 — `plan` 이 «원리상 못 재는» 사실을 사람이 값으로 댄다(`--told k=v,k=v`).
  //   ⛔ 섞지 않는다 — 아래 산출이 「잰 것」과 「말해 준 것」을 «따로» 낸다.
  const toldPairs: Record<string, number> = {};
  const toldBad: string[] = [];
  for (const kv of list('told')) {
    const at = kv.indexOf('=');
    if (at <= 0) { toldBad.push(kv); continue; }
    const n = Number(kv.slice(at + 1));
    if (!Number.isFinite(n)) { toldBad.push(kv); continue; }
    toldPairs[kv.slice(0, at)] = n;
  }
  if (toldBad.length > 0) {
    console.error(`⛔ --told 는 'key=수' 꼴이다 — 못 읽은 칸: ${toldBad.join(', ')}`);
    process.exit(2);
  }
  const ov = overlayState(pickedForOverlay, toldPairs);
  const ovState = ov.state;
  let ovSelections: { overlayId: string; verdict: string; detail?: string }[] = [];
  let ovPatches: { overlayId: string; node: string; field: string; before: unknown; after: unknown }[] = [];
  let ovError: string | null = null;
  if (flag('overlay')) {
    try {
      const declPath = join(HERE, '..', 'graphs', 'video', 'video-production-pipeline.declaration.yaml');
      const ovDir = join(HERE, '..', 'graphs', 'video', 'overlays');
      const decl = parseGraphTemplateYaml(readFileSync(declPath, 'utf8'), 'video-production');
      if (!decl.template) ovError = `선언을 못 읽었다 — errors ${decl.errors.length}`;
      else {
        const specs = readdirSync(ovDir).filter((n: string) => n.endsWith('.yaml')).flatMap((n: string) => {
          const r = parseGraphOverlayYaml(readFileSync(join(ovDir, n), 'utf8'), n);
          return r.overlay ? [r.overlay] : [];
        });
        const sel = selectOverlays(specs, { graphId: decl.template.graphId, stage: 'runtime', state: ovState });
        ovSelections = sel.selections.map((x) => ({ overlayId: x.overlayId, verdict: x.verdict, detail: x.detail }));
        if (sel.applied.length > 0) {
          const applied = applyGraphOverlays(decl.template, sel.applied);
          if (applied.ok) ovPatches = applied.patches.map((x) => ({ overlayId: x.overlayId, node: x.node, field: x.field, before: (x as { before: unknown }).before, after: (x as { after: unknown }).after }));
          else ovError = `얹다가 거절됐다 — ${applied.rejections.map((r) => r.kind).join(', ')}`;
        }
      }
    } catch (e) { ovError = `못 쟀다 — ${(e as Error).message}`; }   // ⛔ 「없다」가 아니다
  }

  if (flag('json')) {
    // ⛔⭐⭐ ***`console.log(JSON.stringify(...))` 는 바이트를 «잃을 수 있다».***
    //   프로세스가 끝나면서 stdout 이 다 비워지기 «전»에 나갈 수 있고, 그러면
    //   ***기계가 읽는 계약이 「잘린 JSON」으로 도착한다*** — 그리고 그것은 「빈 산출」처럼 보인다.
    // 🩸 2026-09-22: 이 규칙의 게이트(`ci-stdout-json-gate`)가 «있었는데 아무 데도 안 걸려 있었다»
    //   (🅢 보고 · #19747). 그래서 내 PR 이 4건을 이고 있었고 ***나는 몰랐다.***
    //   🔑 ***「관문이 있다」와 「그 관문이 «불린다»」는 다른 값이다.***
    await writeStdoutJson(JSON.stringify({ source: PROVENANCE, segment: nodes.map((n) => n.id), prefer, gaps,
      // ⛔ 같은 규칙 — 사람 화면이 구멍마다 「선언된 구현 ⊕ 무료가 선언돼 있나」를 말하므로 기계도 받는다.
      //   ⚠️ `gaps`(문자열 배열)는 «그대로» 둔다 — 소비자 계약을 깨지 않고 옆 칸으로 더한다.
      gapDetail: gaps.map((g) => {
        const cap = g.slice(g.indexOf('/') + 1);
        const impls = CAPS.find((c) => c.id === cap)?.impls ?? [];
        return {
          gap: g, cap,
          declared: impls.map((i) => ({ id: i.id, tier: i.tier })),
          freeDeclared: impls.some((i) => i.tier === 'free'),
        };
      }),
      metered: [...new Set(metered.map((m) => m.id))],
      // ⛔ 같은 규칙 — 사람 화면의 «오버레이 축»을 기계도 받는다.
      overlay: flag('overlay')
        ? { state: ovState, selections: ovSelections, patches: ovPatches, error: ovError }
        : null,
      // ⛔ 같은 규칙 — 사람 화면의 «계정 축»을 기계도 받는다. 돈 축(`metered`)과 «접지 않는다».
      accountsNeeded: [...new Set([...new Map(out.flatMap((o) => o.picks)
        .map((p) => p.impl).filter((i): i is Impl => Boolean(i)).map((i) => [i.id, i])).values()]
        .map((i) => i.provider).filter(Boolean) as string[])]
        .filter((id) => PROVIDERS.find((p) => p.id === id)?.needsAccount === true)
        .map((id) => ({ provider: id, auth: PROVIDERS.find((p) => p.id === id)?.auth ?? null })),
      // ⛔ 사람 화면에 있는 축은 «반드시» JSON 에도 둔다 — 17차 리뷰 ② 와 같은 자리다.
      handDriven: out.flatMap((o) => o.picks
        .filter((p) => p.impl?.drive !== undefined && p.impl.drive !== 'headless')
        .map((p) => ({ node: o.node, cap: p.cap, impl: p.impl!.id, drive: p.impl!.drive }))),
      stack: out.map((o) => ({ node: o.node, picks: o.picks.map((p) => ({ cap: p.cap, impl: p.impl?.id ?? null, tier: p.impl?.tier ?? null, drive: p.impl?.drive ?? 'headless', required: p.required })) })) }, null, 2) + '\n');
    return;
  }

  sayUnprobed();
  console.log(`\n🧱 추천 스택 — 구간 ${nodes[0].id} → ${nodes[nodes.length - 1].id} · 선호 ${TIER_MARK[prefer]}`);
  console.log(`   설정: ${LOADED.source}${MACHINE ? ` · 기계 «${MACHINE_NAME}»` : ''}`);
  if (MISSING.size) console.log(`   ⚠️ 없다고 «가정»한 것: ${[...MISSING].join(', ')}`);
  console.log(`   🧩 레고 돌기 — 여기서 시작하려면 미리 줘야 하는 것: ${nodes[0].inputs.join(' · ')}\n`);

  for (const o of out) {
    console.log(`  ${o.node.padEnd(11)} ${o.what}`);
    if (o.picks.length === 0) { console.log('               (능력 요구 없음)'); continue; }
    for (const p of o.picks) {
      const mark = p.required ? '必' : '選';
      if (!p.impl) { console.log(`     ${mark} ${p.cap.padEnd(16)} ⛔ 구현 없음${p.required ? '  ← 이 노드를 못 돈다' : ''}`); continue; }
      console.log(`     ${mark} ${p.cap.padEnd(16)} ${TIER_MARK[p.impl.tier]} ${p.impl.id}${p.impl.unitCost ? `  (${p.impl.unitCost})` : ''}`);
      if (p.impl.note) console.log(`        ↳ ${p.impl.note}`);
    }
  }

  if (unusedLines.length) {
    console.log(`\n⚠️ 요청했지만 이 구간의 «어느 노드도 안 쓰는» 능력 ${unusedLines.length}개`);
    for (const u of unusedLines) console.log(`   · ${u}`);
  }

  const uniqMetered = [...new Map(metered.map((m) => [m.id, m])).values()];
  console.log('\n──────────────────────────────────────────────');

  // ⛔⭐ ***뺐으면 «말한다».*** 조용히 빼면 「붙지 않아서 뺐다」와 「원래 없었다」를 구별할 수 없다.
  if (HOST_EXCLUDED.size > 0) {
    console.log(`🚪 호스트가 «안 붙어서» 후보에서 뺀 구현 ${HOST_EXCLUDED.size}개 — ⛔ 「없는 것」이 아니다`);
    for (const [impl, cap] of HOST_EXCLUDED) console.log(`   ⛔ ${impl}  (${cap}) — 앱을 띄우면 «다시 후보»가 된다`);
  } else if (flag('verify-hosts')) {
    console.log('🚪 호스트 때문에 뺀 구현 «0개» — 물어봤고, 안 붙은 것이 없었다');
  }

  // ⛔ 얹었으면 «말한다». 조용히 바뀌면 「원래 그랬다」와 구별이 안 된다.
  if (flag('overlay')) {
    if (ovError) {
      console.log(`🪄 오버레이 «못 쟀다» — ${ovError}`);
      console.log('   ⇒ 「안 얹혔다」가 아니다. 이 상태에서는 판정할 수 없다.');
    } else if (ovPatches.length > 0) {
      console.log(`🪄 오버레이 ${new Set(ovPatches.map((p) => p.overlayId)).size}장이 기본 템플릿을 «변형»했다`);
      for (const p of ovPatches) console.log(`   ⭐ ${p.node}  ${p.field}  ${String(p.before)} → ${String(p.after)}   [${p.overlayId}]`);
    } else {
      console.log('🪄 얹힌 오버레이 «0장» — 기본 템플릿 그대로다');
    }
    // ⛔⭐ 「안 얹혔다」의 이유를 갈라 낸다 — 다섯이고 처방이 전부 다르다.
    const notable = ovSelections.filter((x) => x.verdict !== 'applies' && x.verdict !== 'target-mismatch');
    for (const x of notable) {
      const why = x.verdict === 'does-not-apply' ? '조건이 거짓 (정상)'
        : x.verdict === 'key-absent' ? `⚠️ 상태에 그 키가 «없다» — 계측 결손(${x.detail})`
        : x.verdict === 'unparseable' ? `⛔ 조건을 «못 읽었다» — 오버레이 결함(${x.detail})`
        : `⚠️ ${x.verdict}${x.detail ? ` (${x.detail})` : ''}`;
      console.log(`   · ${x.overlayId.padEnd(24)} ${why}`);
    }
    // ⛔ 한 줄로 접으면 읽는 사람이 「도구가 쟀다」와 「내가 그렇게 말했다」를 구분 못 한다.
    const show = (keys: readonly string[]): string =>
      keys.map((k) => `${k}=${ovState[k]}`).join(' · ') || '—';
    console.log(`   📏 도구가 «잰» 상태: ${show(ov.measured)}`);
    if (ov.told.length > 0) console.log(`   🗣️ 사람이 «말해 준» 상태: ${show(ov.told)}  (⛔ 실측이 아니다)`);
    for (const r of ov.refused) console.log(`   ⛔ --told ${r.key} 는 «안 받았다» — ${r.why}`);
  }

  // ⛔⭐⭐ ***「돈이 든다」와 「계정이 필요하다」는 «다른 축»이다*** — 2026-09-22.
  //   🩸 실물: `--need app-control` 이 `bridge-ae` 를 골라 놓고 «💰 과금 구현 0개 — 돈이 안 든다»
  //      라고만 말했다. 맞는 말이다. 그런데 그 브리지는 ***higgsfield OAuth 를 탄다***
  //      (`tier: 'owned'` = 앱을 샀다 ≠ 계정이 필요 없다 · #19815).
  //      ⇒ 읽는 사람은 「돈이 안 든다」에서 ***「그냥 쓰면 된다」를 읽는다.*** 그리고 로그인에서 막힌다.
  //   🔑 그래서 돈 축 «옆»에 계정 축을 따로 낸다. 접으면 한쪽이 반드시 사라진다.
  const picked = [...new Map(out.flatMap((o) => o.picks)
    .map((p) => p.impl).filter((i): i is Impl => Boolean(i)).map((i) => [i.id, i])).values()];
  const needAcct = [...new Set(picked.map((i) => i.provider).filter(Boolean) as string[])]
    .filter((id) => PROVIDERS.find((p) => p.id === id)?.needsAccount === true);
  if (needAcct.length === 0) {
    console.log('🔑 계정이 필요한 구현 «0개» — 이 스택은 로그인 없이 돈다');
  } else {
    console.log(`🔑 계정이 필요한 구현 ${needAcct.length}곳 — ⛔ 「돈이 안 든다」와 «다른 축»이다`);
    for (const id of needAcct) {
      const pv = PROVIDERS.find((p) => p.id === id)!;
      const users = picked.filter((i) => i.provider === id).map((i) => `${i.id}(${i.tier})`);
      console.log(`   🔑 ${id}  [${pv.auth ?? '?'}]  ← ${users.join(' · ')}`);
    }
    if (picked.some((i) => i.tier === 'owned' && needAcct.includes(i.provider ?? ''))) {
      console.log('   ⚠️ 그중 «owned»(앱을 이미 샀다)가 섞여 있다 — ***앱을 샀어도 계정 없이는 못 몬다.***');
    }
  }

  if (uniqMetered.length === 0) console.log('💰 과금 구현 «0개» — 이 스택은 돈이 안 든다');
  else {
    console.log(`💰 과금 구현 ${uniqMetered.length}개 — ⛔ 견적을 믿지 말고 «실측 델타»로 재라`);
    for (const m of uniqMetered) {
      console.log(`   🟠 ${m.id}  ${m.unitCost ?? ''}${m.provider ? `  [${m.provider}]` : ''}` +
        `${m.hasFreeQuota ? '  ⭐무료쿼터' : ''}`);
      if (m.quotaProbe) console.log(`      잔량: ${m.quotaProbe}`);
    }
    const byProvider = new Map<string, number>();
    for (const m of uniqMetered) byProvider.set(m.provider ?? '?', (byProvider.get(m.provider ?? '?') ?? 0) + 1);
    if (byProvider.size > 1) {
      console.log(`   ⚖️ 출처 ${byProvider.size}곳으로 갈린다 — ${[...byProvider].map(([p, n]) => `${p}:${n}`).join(' · ')}`);
      console.log('      ⇒ --provider-order <a,b> 로 태울 순서를 «사람이» 정한다');
    }
  }
  // ⛔ 대안을 «한 라벨»로 묶지 않는다 — 실측 결함: free 대안(sips·sox)에
  //    「크레딧이 마르면 여기로 돌린다」가 붙어 있었다. sips 는 마를 크레딧이 없다.
  if (ALTS.size) {
    const credit = new Map<string, Impl[]>();
    const plain = new Map<string, Impl[]>();
    for (const [cap, alts] of ALTS) {
      const m = alts.filter((a) => a.tier === 'metered');
      const o = alts.filter((a) => a.tier !== 'metered');
      if (m.length) credit.set(cap, m);
      if (o.length) plain.set(cap, o);
    }
    if (credit.size) {
      console.log('\n💳 같은 능력의 «다른 과금 출처» — 한쪽 크레딧이 마르면 여기로 돌린다');
      for (const [cap, alts] of credit) {
        console.log(`   ${cap.padEnd(16)} → ${alts.map((a) => `${a.id}${a.provider ? `[${a.provider}]` : ''}`).join(' · ')}`);
      }
    }
    if (plain.size) {
      console.log('\n🔁 같은 능력의 «다른 구현» — 고른 것이 안 되면 대신 쓴다 (과금 아님)');
      for (const [cap, alts] of plain) {
        console.log(`   ${cap.padEnd(16)} → ${alts.map((a) => `${a.id}(${a.tier})`).join(' · ')}`);
      }
    }
  }
  // ⛔⭐⭐ ***「살 수 있다」(tier)와 「부를 수 있다」(drive)는 «다른 축»이다.***
  //   🩸 2026-09-22: `client-affinity` 프로파일은 Affinity 를 「있다」고 답하는데,
  //      실측해 보니 v3.3.0 에 ***스크립트 표면이 0***(sdef·NSAppleScriptEnabled·CLI 전부 없음)이다.
  //      ⇒ 그 프로파일은 ***사람이 없으면 못 도는 라인을 「된다」고 말하고 있었다.***
  //   🔑 구멍(gap)은 「아무것도 없다」이고, 이것은 「있는데 «내가» 못 부른다」다 — ***접으면 안 된다.***
  const handDriven = out.flatMap((o) => o.picks.map((p) => ({ node: o.node, p })))
    .filter((x) => x.p.impl !== undefined && x.p.impl.drive !== undefined && x.p.impl.drive !== 'headless');
  if (handDriven.length > 0) {
    const guiOnly = handDriven.filter((x) => x.p.impl!.drive === 'gui-only');
    console.log(`\n🖐️ 무인으로 «못 도는» 칸 ${handDriven.length}개 — 있긴 한데 «내가 못 부른다»`);
    for (const { node, p } of handDriven) {
      const mark = p.impl!.drive === 'gui-only' ? '⛔ 사람만' : '⚠️ 앱이 떠 있어야';
      console.log(`   ${mark}  ${node}/${p.cap.padEnd(14)} ${p.impl!.id}`);
    }
    if (guiOnly.length > 0) {
      console.log('   ⛔ `gui-only` 는 ***프로그램 표면이 «없다»*** — 무인 런은 여기서 needs-human 으로 멈춘다');
      console.log('   ⇒ 처방: 사람이 그 단계를 하거나 · headless 대체를 고르거나 · app-control 로 화면을 몬다');
    }
  }

  if (gaps.length) {
    console.log(`\n⛔ 구멍 ${gaps.length}개 — 이 능력이 없으면 그 노드에서 멈춘다`);
    // ⛔⭐ 처방은 «자리»가 아니라 «값»을 댄다(2026-09-22).
    //   종전 한 줄은 *"도구를 설치하거나"* 로 끝나서 ***어느 도구인지 말하지 않았다*** — 그런데
    //   도구는 그 순간 선언 목록을 «이미 쥐고 있다». 사람이 그것을 다시 찾아야 했다.
    //   🔑 그리고 여기서 갈리는 축이 하나 더 있다: ***「무료가 선언돼 있나」***.
    //      무료가 선언돼 있으면 «깔면 공짜»가 되고, 선언된 것이 전부 유료면 깔아도 과금이 남는다.
    //      둘을 한 줄로 접으면 「크레딧 0 으로 갈 수 있나」에 답이 안 나온다.
    let anyFreeDeclared = false;
    for (const g of gaps) {
      const capId = g.slice(g.indexOf('/') + 1);
      const impls = CAPS.find((c) => c.id === capId)?.impls ?? [];
      console.log(`   ⛔ ${g}`);
      if (impls.length === 0) {
        console.log(`      ↳ 선언된 구현이 «하나도 없다» — 레지스트리에 능력만 있고 구현이 비었다`);
        continue;
      }
      const free = impls.filter((i) => i.tier === 'free');
      if (free.length > 0) anyFreeDeclared = true;
      console.log(`      ↳ 선언된 구현 ${impls.length}개: ${impls.map((i) => `${TIER_MARK[i.tier]} ${i.id}`).join(' · ')}`);
      console.log(free.length > 0
        ? `      💡 무료 구현이 ${free.length}개 «선언돼» 있다 — 설치하면 이 능력은 크레딧 0 이 된다: ${free.map((i) => i.id).join(', ')}`
        : `      💳 선언된 것이 «전부 과금/보유»다 — 설치해도 이 능력은 크레딧 0 이 안 된다`);
    }
    console.log('   ⇒ 처방: 위 구현 중 하나를 설치하거나 · 그 노드를 건너뛸 구간으로 자르거나 · 사람이 그 산출을 준다');
    if (!anyFreeDeclared) {
      console.log('   ⚠️ 어느 구멍에도 «무료» 선언이 없다 — 이 구간은 설치만으로 크레딧 0 이 되지 않는다');
    }
  } else {
    const unverified = out.flatMap((o) => o.picks)
      .filter((p) => p.impl?.probe.kind === 'mcp').map((p) => p.impl!.id);
    if (unverified.length) {
      console.log(`\n⚠️ 구멍은 없다 — 단 ${[...new Set(unverified)].length}개 구현이 «호스트 미확인»이다${ASSUME_SUFFIX}`);
      // ⛔⭐ 21차 리뷰 — bridge-ae · bridge-premiere · bridge-blender 는 ***같은 MCP 서버 하나***로 감지된다.
      //   ⇒ 「서버가 있다」가 「그 앱이 떠 있다」를 뜻하지 않는다. 이 문장을 «값으로» 말한다.
      console.log('   ⛔ bridge-* 는 «MCP 서버 하나»로 감지된다 — 서버가 있다고 그 앱이 떠 있는 것이 아니다');
      console.log(`   ${[...new Set(unverified)].join(' · ')}`);
      // ⛔ #19814 이 `probe` 에만 닿았다 — 여기도 «사람에게 시키지» 않는다.
    console.log('   ⇒ 「끝까지 돈다」고 «단정하지 않는다». `probe --verify-hosts` 가 «도구로» 물어 실측을 낸다');
    } else if (ASSUMED_ANY && !unverified.length) {
      // ⛔⭐⭐ 14차 리뷰 ② — `detect:false` 면 `have` 는 ***실측이 아니라 «선언»***이다.
      //   그런데 여기서 「지금 기계에서 끝까지 돈다」고 ***사실로 단언***했다.
      //   🔑 이 저장소의 규율 그대로다 — ***실측과 가정을 갈라 적는다.*** 섞으면 가장 비싼 거짓이 된다.
      console.log(`\n✅ 구멍 없음 — ⚠️ 단 «가정»이다(${PROVENANCE.overrides.join(' · ')})`);
      console.log('   ⇒ 실제로 재려면 그 덮개를 걷고 `probe` 를 직접 돌려라');
    } else {
      // ⛔⭐ 20차 리뷰(should-fix) — `which` 성공은 ***「있다」이지 「된다」가 아니다***.
      //   권한·버전·라이선스·호스트 상태는 안 봤다. ⇒ 「돈다」고 단언하지 않는다.
      //   🔑 이 PR 이 다른 축에서 배운 것과 «같은 규율»이다(포트 점유 ≠ reachable).
      console.log('\n✅ 구멍 없음 — 이 구간의 모든 능력에 «발견된» 구현이 있다');
      console.log('   ⚠️ 「발견됐다」는 「된다」가 아니다 — 실제 실행은 첫 회차가 답한다');
    }
  }
}

/** ⛔⭐ 선언(YAML)과 뼈대(spine.ts)가 «갈렸나»를 도구가 «잰다».
 *  📏 계기 2026-09-22(2차 리뷰 ①): 두 벌이 실제로 갈려 있었고 —
 *     선언 compose 가 vo·music 을, plan 이 specs 를 «더» 요구했다.
 *     도구는 그때도 «선언과 다른 계약»을 태연히 보고했다.
 *  ⛔ 규율을 «문서에 적는» 것으로는 안 막힌다 — 그 규율이 이미 문서에 있었다. 재야 막힌다. */
function drift(): number {
  const yamlPath = join(process.cwd(), 'graphs/video/video-production-pipeline.declaration.yaml');
  let raw: string;
  try { raw = readFileSync(yamlPath, 'utf8'); }
  catch { console.error(`⛔ 선언을 못 읽었다: ${yamlPath}`); return 2; }

  // ⛔⭐⭐ 6차 리뷰 ③ — 종전엔 이 자가 «정규식»으로 node_id·inputs 를 긁었다.
  //   그래서 ***소비자(로더)가 «거부하는» 선언***을 이 자는 「드리프트 없음」으로 통과시켰다.
  //   📏 실측: entry_node 를 지운 선언 ⇒ 진짜 파서 exit 1 · 옛 drift 「✅ 드리프트 없음」 exit 0.
  //   🔑 ***자는 소비자가 읽는 방식으로 읽어야 한다*** — 더 느슨한 독자는 더 관대한 거짓을 낸다.
  const parsed = parseGraphTemplateYaml(raw, 'video-production-pipeline.declaration.yaml');
  const perr = parsed.errors ?? [];
  if (!parsed.template || perr.length > 0) {
    console.error(`⛔ 선언을 «로더가 읽는 방식»으로 못 읽었다 — errors ${perr.length}`);
    for (const e of perr.slice(0, 5)) console.error(`   ⛔ ${e.path} — ${e.message}`);
    console.error('   ⇒ 이 상태에서는 드리프트를 «잴 수 없다». 「없다」가 아니라 「못 쟀다」다.');
    return 2;
  }
  const declared = new Map<string, string[]>(
    parsed.template.nodes.map((n) => [n.nodeId, [...(n.contract?.inputs ?? [])]]),
  );
  if (declared.size === 0) { console.error('⛔ 선언에서 노드를 «하나도» 못 읽었다'); return 2; }

  // ⛔⭐ 4차 리뷰 ⑤ — 종전엔 「선언에 없다」를 ⚠️ 로만 찍고 «통과»시켰다.
  //   그러면 뼈대 노드 이름이 바뀌는 순간 이 자가 「드리프트 없음」이라 말한다(fail-open).
  //   ✅ 종단은 «선언이 이름을 준다» — terminal_nodes 에 있는 것만 면제하고, 나머지 결손은 실패다.
  const terminals = new Set(parsed.template.terminalNodes);
  if (terminals.size === 0) { console.error('⛔ 선언에 terminal_nodes 가 없다 — 면제 목록 없이 판정하지 않는다'); return 2; }

  let bad = 0, checked = 0;
  console.log(`\n🔍 선언 ↔ 뼈대 대조 — 선언에서 읽은 노드 ${declared.size}개 · 종단 ${terminals.size}개\n`);
  for (const n of SPINE) {
    const d = declared.get(n.id);
    if (!d) {
      if (terminals.has(n.id)) { console.log(`  ➖ ${n.id.padEnd(11)} 종단이라 대조 면제(선언이 이름을 준다)`); continue; }
      console.log(`  ⛔ ${n.id.padEnd(11)} 선언에 «없다» — 종단도 아니다`);
      bad++; continue;
    }
    checked++;
    const a = [...n.inputs].sort().join(' · ');
    const b = [...d].sort().join(' · ');
    if (a === b) { console.log(`  ✅ ${n.id.padEnd(11)} ${a}`); continue; }
    bad++;
    console.log(`  ⛔ ${n.id.padEnd(11)} 갈렸다`);
    console.log(`       뼈대 ${a}`);
    console.log(`       선언 ${b}`);
  }
  // ⛔⭐⭐ 13차 리뷰 ③ — 여기까지는 «뼈대 → 선언» 한 방향만 봤다.
  //   ⇒ 선언에 «비종단 노드»가 새로 생겨도 이 자는 아무 말도 안 했다(exit 0).
  //   🔑 집합 대조는 «양방향»이다. 한쪽만 보면 「없는 것」의 절반을 영원히 못 본다.
  const spineIds = new Set(SPINE.map((n) => n.id));
  for (const id of declared.keys()) {
    if (spineIds.has(id) || terminals.has(id)) continue;
    console.log(`  ⛔ ${id.padEnd(11)} 선언에만 있다 — 뼈대에 «없고» 종단도 아니다`);
    bad++;
  }

  // ⛔ 관문은 «못 보는 것»을 말해야 한다 — 선언 스키마엔 «선택 입력» 자리가 없다.
  console.log('\n📏 이 자가 «못 보는 것»: 선택 입력(optionalInputs)·도구 목록·max_visits — 선언 스키마에 자리가 없거나 대조 축이 아니다');
  console.log(bad === 0
    ? `✅ 대조 ${checked}개 — 드리프트 없음`
    : `\n⛔ 대조 ${checked}개 중 ${bad}개가 갈렸다 — 도구가 «선언과 다른 계약»을 보고한다`);
  return bad === 0 ? 0 : 1;
}

function spine() {
  console.log('\n🦴 뼈대 — ⭐ inputs 가 «레고 돌기»다. 채울 수 있으면 그 노드에서 시작할 수 있다.\n');
  for (const n of SPINE) {
    console.log(`  ${n.id.padEnd(11)} ${n.what}`);
    console.log(`     inputs  ${n.inputs.join(' · ')}`);
    console.log(`     outputs ${n.outputs.join(' · ')}`);
    if (n.needs.length) console.log(`     必 ${n.needs.join(' · ')}`);
    if (n.optional?.length) console.log(`     選 ${n.optional.join(' · ')}`);
  }
}

function showConfig() {
  const path = findConfigPath(opt('config') || undefined);
  console.log(`\n⚙️  설정 출처: ${LOADED.source}`);
  if (!path) {
    console.log('   ⇒ 내장 레지스트리만 쓰고 있다. 설정을 만들려면:');
    console.log('      bun scripts/video-pipeline.ts config --init [--out <path>]');
  }
  console.log(`\n   기본 선호     ${CFG.prefer ?? 'free (내장 기본)'}`);
  // ⛔ 수를 «박지» 않는다 — 13 이라 박아 뒀는데 실제로는 19였다(리뷰 must-fix ⑤).
  const builtin = CAPABILITIES.length;
  console.log(`   능력          ${CAPS.length}개 (내장 ${builtin} + 설정 추가 ${Math.max(0, CAPS.length - builtin)})`);
  const machines = Object.entries(CFG.machines ?? {});
  console.log(`   기계 프로파일  ${machines.length}개`);
  for (const [name, m] of machines) {
    console.log(`     · ${name.padEnd(20)} detect=${m.detect !== false}` +
      `${m.have ? ` have=${m.have.length}` : ''}${m.missing ? ` missing=${m.missing.length}` : ''}`);
    if (m.note) console.log(`       ${m.note}`);
  }
  const overrides = Object.keys(CFG.impls ?? {});
  if (overrides.length) console.log(`   impl 덮어쓰기  ${overrides.join(', ')}`);
  // ⛔ 설정이 내장 구현을 «가렸으면» 조용히 넘기지 않는다.
  const sh = EFF.shadowed;
  if (sh.length) {
    console.log(`\n   ⚠️ 설정이 내장 능력을 «덮어» 구현이 사라졌다 (${sh.length}개 능력)`);
    for (const x of sh) console.log(`      ${x.capability} — 잃은 구현: ${x.lostImpls.join(', ')}`);
    console.log('      ⇒ 내장에 «더하려면» capabilities 가 아니라 impls 로 추가하라');
  }
  console.log('\n   📌 찾는 순서: --config → $ELANOUS_VIDEO_TOOLS → ./video-tools.json → ~/.elanous/video-tools.json');
}

function initConfig() {
  const out = opt('out', join(homedir(), '.elanous', 'video-tools.json'));
  if (existsSync(out) && !flag('force')) {
    console.error(`⛔ 이미 있다: ${out}  (덮으려면 --force)`); process.exit(2);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(STARTER_CONFIG, null, 2) + '\n', 'utf8');
  console.log(`✅ 썼다: ${out}`);
  console.log('   ⇒ machines 에 고객 기계를 추가하고  --machine <name> 으로 계획하라');
}

/**
 * 🚶 `walk --graph <graph_id> [--state <state.json>] [--told k=v,…] [--out D] [--json]`
 *   — 영상 선언 «어느 것이든» 레시피 표 «하나»(ALL_RECIPES)로 끝까지 걷는다.
 * ⛔ 라인 스크립트(vlog·film·character)는 «인자 편의»만 다르다 — 걷는 규칙은 `walk-line.ts` 한 벌이다.
 * ⛔ `--told` 는 `state.told` 로 들어간다(레시피가 «말해 준 값»으로 표시한다 · 잰 값이 아니다).
 * 종료코드: 0 delivered · 1 그 밖의 종단 · 2 「못 쟀다」(unobserved) · 3 준비 실패
 */
async function walk(): Promise<number> {
  const graphId = opt('graph');
  if (!graphId) { console.error('⛔ --graph <graph_id> 가 필요하다 — 목록은 `recipes`'); return 3; }
  const decl = findTemplate(graphId, join(HERE, '..', 'graphs', 'video'));
  if (!decl) { console.error(`⛔ 그런 선언이 없다: ${graphId} — 목록은 \`recipes\``); return 3; }
  const walker = await loadWalker();
  if (!walker) { console.error('➖ 워커를 못 찾았다 — 「못 돌렸다」다. GRAPH_WALKER 로 경로를 줘라.'); return 3; }
  const { spec, error } = walker.readGraphSpec(decl);
  if (!spec) { console.error(`⛔ 선언을 못 읽었다: ${error}`); return 3; }
  let state: Record<string, unknown> = {};
  if (opt('state')) {
    try { state = JSON.parse(readFileSync(opt('state'), 'utf8')) as Record<string, unknown>; }
    catch (e) { console.error(`⛔ --state 를 못 읽었다: ${(e as Error).message}`); return 3; }
  }
  const told: Record<string, number> = { ...((state.told as Record<string, number> | undefined) ?? {}) };
  for (const kv of list('told')) {
    const at = kv.indexOf('='); const n = Number(kv.slice(at + 1));
    if (at <= 0 || !Number.isFinite(n)) { console.error(`⛔ --told 는 'key=수' 꼴이다: ${kv}`); return 3; }
    told[kv.slice(0, at)] = n;
  }
  if (Object.keys(told).length) state.told = told;
  const workdir = opt('out') || join(tmpdir(), `walk-${graphId}-${Date.now()}`);
  mkdirSync(workdir, { recursive: true });
  const quiet = flag('json');
  if (!quiet) console.log(`\n🚶 ${spec.graph_id} (노드 ${spec.nodes.length}) · 작업 ${workdir}${Object.keys(told).length ? ` · 🗣️ 말해 준 사실 ${JSON.stringify(told)} (⛔ 실측 아님)` : ''}\n`);
  const r = await walkLine({ spec: spec as GraphSpecLike, walker, state, workdir, onStep: (row) => { if (!quiet) console.log(formatStep(row)); } });
  if (quiet) await writeStdoutJson(JSON.stringify({ graphId, decl, workdir, told, ...r }, null, 2) + '\n');
  else {
    console.log(`\n═══ 종단 ${r.terminal ?? '(없음)'} · stop ${r.stopReason} · 걸음 ${r.steps} ═══\n   ${r.path}`);
    if (r.unknownRecipe) console.log(`\n⛔ 구현이 «없는» 레시피에서 멎었다: ${r.unknownRecipe}`);
  }
  return exitCodeOf(r.terminal);
}

if (sub === 'drift') process.exit(drift());
else if (sub === 'config') { flag('init') ? initConfig() : showConfig(); }
else if (sub === 'probe') await probe();
else if (sub === 'plan') await plan();
else if (sub === 'recipes') process.exit(await recipes());  // ⛔ 판정을 «읽는다» — 안 읽으면 래칫이 장식이다
else if (sub === 'walk') process.exit(await walk());
else if (sub === 'spine') spine();
else {
  console.error('사용: bun scripts/video-pipeline.ts <probe|plan|walk|recipes|spine|config|drift> [옵션]');
  console.error('  drift                            선언(YAML) ↔ 뼈대(spine.ts) 대조');
  console.error('  walk   --graph <id> [--state f.json] [--told k=v,…]   영상 선언을 레시피로 끝까지 걷는다');
  console.error('  config [--init] [--out <path>]   설정 보기 / 시작 설정 쓰기');
  console.error('  probe  [--verify-hosts]          app-attached 구현에 «앱이 지금 붙었나»를 실제로 묻는다');
  console.error('  공통: --config <path> --machine <name> --surface cli|tui|telegram');
  console.error('  크레딧: --provider-order higgsfield,topview   과금 출처를 태울 순서');
  console.error('  plan --need <cap,...> [--from N --to N] [--prefer free|owned] [--assume-missing id,...]');
  process.exit(2);
}
