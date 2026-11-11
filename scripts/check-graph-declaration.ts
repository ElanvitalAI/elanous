#!/usr/bin/env bun
// ── 그래프 «선언»을 실제 파서에 물린다 ────────────────────────────────────
//
// ⛔ 계기(2026-09-10): `graphs/` 에 스키마가 다른 파일을 하나 넣었더니 로더가
//    ***YAML 을 전부 버리고 하드코딩 상수로 폴백***했다. 템플릿 4개 → 2개.
//    변경파일 스코프 게이트는 이것을 원리상 못 잡는다(테스트 파일을 안 바꿨으니까).
//    ⇒ 그래서 「놓기 전에 로더에게 «묻는»」 이 도구가 관문이다.
//
// 사용:
//   bun scripts/check-graph-declaration.ts <file.yaml> [...]     파싱 검사
//   bun scripts/check-graph-declaration.ts --index <file.yaml>   오버레이용 노드 인덱스 표
//
// exit 0 = 전부 파싱됨 · exit 1 = 하나라도 오류

import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { parseGraphTemplateYaml } from '../src/self-implement/graph-yaml.js';
import { lowerGraphV2 } from '../src/graph-v2/lower.js';
import { parseArgv } from './lib/argv.js';
import { parseGraphOverlayYaml } from '../src/self-implement/graph-overlay-yaml.js';

const args = process.argv.slice(2);

// ⛔⭐⭐ 10차 리뷰 — 이 입구도 «같은» 인자 계약을 쓴다(`scripts/lib/argv.ts`).
//   📏 9차엔 계약이 «아예» 없었고, 급히 세운 1판은 `--check-overlays=` 를 또 놓쳤다.
//      ⇒ 급히 세운 계약은 급히 새는 계약이다. 한 벌을 공유한다.
const PARSED = parseArgv(args, {
  known: { '--index': 'bool', '--expect-fail': 'value', '--check-overlays': 'value' },
  allowPositional: true, // ⭐ 이 입구는 «파일 목록»을 받는다
});
if (PARSED.errors.length > 0) {
  for (const e of PARSED.errors) console.error(`⛔ ${e}`);
  process.exit(2);
}

const wantIndex = PARSED.flags.has('index');

// ⛔⭐ 오버레이는 `/nodes/<인덱스>` 로 때린다. 노드 순서가 바뀌면 «조용히» 다른 노드를 때린다
//   (README 가 그 위험을 적어 놓고 «재는 자»는 없었다).
//   ✅ 오버레이가 path 옆에 적어 둔 «노드 이름 주석»을 계약으로 삼아 인덱스↔이름을 대조한다.
const overlayDir = PARSED.values['check-overlays'] ?? null;

// ⛔⭐ 「기대 실패」를 선언할 자리 — 없으면 «전수 검사»가 원리상 불가능하다.
//   📏 계기 2026-09-22(3차 리뷰 ①): 이 저장소엔 ***의도적으로 파싱 실패하는*** 선언이 있다
//      (evas-shorts-pipeline — 2026-09-10 사고의 기록물이고 «고치지 않는 것»이 결정이다).
//      그래서 전수를 돌리면 언제나 exit 1 이고, 내가 PR·매뉴얼에 적은 「errors 0」은 ***거짓 검증 주장***이었다.
//   ⛔ 기대 실패가 «통과»해도 관문은 깨진다 — 그 파일이 고쳐졌다는 뜻이고 선언이 낡았다.
const expectFail = new Set(
  (PARSED.values['expect-fail'] ?? '').split(',').map((x) => x.trim()).filter(Boolean),
);

const files = PARSED.positional;

function isGraphV2(source: string): boolean {
  try {
    const parsed: unknown = parseYaml(source);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      && (parsed as Record<string, unknown>).apiVersion === 'elanous.dev/graph/v2';
  } catch {
    return false;
  }
}

if (files.length === 0) {
  console.error('사용: bun scripts/check-graph-declaration.ts [--index] <file.yaml> [...]');
  process.exit(2);
}

let bad = 0;
const seen = new Set<string>();
for (const f of files) {
  let src: string;
  try { src = readFileSync(f, 'utf8'); }
  catch (e) { console.log(`\n=== ${f} ===\n  ⛔ 못 읽었다 — ${(e as Error).message}`); bad++; continue; }

  // Keep graph.yaml v2's publish-time safety verdict on the same lowering path as MVP-B.
  // The YAML parse above only selects the format; all v2 policy checks live in lowerGraphV2.
  const r = isGraphV2(src)
    ? lowerGraphV2(src, { label: basename(f) })
    : parseGraphTemplateYaml(src, basename(f));
  const errors = r.errors ?? [];
  const warnings = r.warnings ?? [];
  const base = basename(f);
  seen.add(base);
  const expected = expectFail.has(base);

  console.log(`\n=== ${base} ===${expected ? '   (기대: 실패)' : ''}`);
  if (r.template) {
    const t = r.template;
    console.log(`  ✅ 파싱됨 — graph_id=${t.graphId} v${t.version} · 노드 ${t.nodes.length} · 간선 ${t.edges.length}`);
    console.log(`     진입=${t.entryNode} · 종단=[${t.terminalNodes.join(', ')}]`);
  } else if (expected) {
    console.log('  ✅ 기대대로 파싱 실패 — 이 파일은 «고치지 않는 것»이 결정이다(사고 기록물)');
  } else {
    console.log('  ⛔ 파싱 실패 — 이 파일을 graphs/ 에 넣으면 로더가 «전체»를 버린다');
    bad++;
  }
  // ⛔ 기대 실패가 «통과»하면 그것도 결함이다 — 선언이 낡았다는 뜻이다.
  if (expected && r.template) {
    console.log('  ⛔ 기대 실패로 선언됐는데 «통과»했다 — --expect-fail 목록이 낡았다');
    bad++;
  }
  // ⛔⭐ template 이 «있어도» errors 가 하나라도 있으면 실패다.
  //   📏 오늘의 파서는 errors>0 이면 template 을 «안» 준다(graph-yaml.ts:197)지만,
  //      그 계약이 바뀌면 이 관문이 «조용히» exit 0 을 낸다. 관문은 fail-closed 여야 한다.
  if (r.template && errors.length > 0) {
    console.log('  ⛔ template 은 나왔으나 errors 가 있다 — 관문은 이것을 «통과시키지 않는다»');
    bad++;
  }
  console.log(`  errors ${errors.length} · warnings ${warnings.length}`);
  for (const e of errors.slice(0, 8)) console.log(`   ⛔ ${e.path} — ${e.message}`);
  if (errors.length > 8) console.log(`   … +${errors.length - 8} more`);
  for (const w of warnings.slice(0, 5)) console.log(`   ⚠️ ${w.path} — ${w.message}`);
  if (warnings.length > 5) console.log(`   … +${warnings.length - 5} more`);

  // ⛔⭐⭐ 2026-09-22 — `contract.tools` 가 ***「걷는 자가 아는 이름」인지***를 본다.
  //   🩸 계기: 이 선언이 `local-compute` · `generate` · `none` 을 «지어 썼고»,
  //      그 이름들은 워커의 `TOOL_RANK` 에 없어서 ***전 노드의 계약이 undeclared 로 판정***됐다 —
  //      ***이 그래프의 「권한 축」이 통째로 죽어 있었다***(아무것도 허용 않고 아무것도 검사 않는다).
  //   ⛔ 스키마 파서도 drift 도 이것을 «원리상» 못 본다 — 둘 다 「문자열인가」만 묻는다.
  //   🔑 ***어휘는 「있다/없다」가 아니라 「«상대가» 아는가」로 검사해야 한다.***
  if (r.template) {
    const KNOWN_TOOLS = new Set([
      'read-only', 'read-and-run', 'network-read', 'workspace-write', 'network-write', 'git-write',
    ]);
    const badTools = r.template.nodes
      .filter((n) => n.contract !== undefined && n.contract.tools !== '' && !KNOWN_TOOLS.has(n.contract.tools))
      .map((n) => `${n.nodeId}:${n.contract!.tools}`);
    if (badTools.length > 0) {
      console.log(`  ⛔ contract.tools 가 «걷는 자가 모르는» 이름이다 — ${badTools.join(' · ')}`);
      console.log(`     ⇒ 그 노드의 계약은 undeclared 로 판정된다(권한 축이 죽는다).`);
      console.log(`     가능: ${[...KNOWN_TOOLS].join(' · ')}`);
      bad++;
    }
  }

  // ⭐ 오버레이는 path 를 «인덱스»로 쓴다(/nodes/3/maxVisits) — 이름↔인덱스를 여기서 낸다.
  //   ⛔ 노드 순서가 바뀌면 오버레이가 «조용히» 다른 노드를 때린다. 그래서 표를 낸다.
  if (wantIndex && r.template) {
    console.log('  ── 오버레이용 인덱스 (⛔ 노드 순서를 바꾸면 오버레이를 같이 고쳐라) ──');
    r.template.nodes.forEach((n, i) => {
      console.log(`     /nodes/${String(i).padStart(2)}  ${n.nodeId.padEnd(14)} kind=${n.kind.padEnd(6)} max_visits=${n.maxVisits}`);
    });
  }
}

// ══ 오버레이 인덱스 ↔ 이름 대조 ══
if (overlayDir !== null) {
  const names = new Map<string, string[]>(); // graph_id → 노드 이름(선언 순서)
  for (const f of files) {
    let src: string; try { src = readFileSync(f, 'utf8'); } catch { continue; }
    const r = isGraphV2(src)
      ? lowerGraphV2(src, { label: basename(f) })
      : parseGraphTemplateYaml(src, basename(f));
    if (r.template) names.set(r.template.graphId, r.template.nodes.map((n) => n.nodeId));
  }
  const ovs = readdirSync(overlayDir).filter((f) => f.endsWith('.yaml'));
  if (ovs.length === 0) { console.error(`⛔ ${overlayDir} 에 오버레이가 «하나도» 없다`); process.exit(2); }
  console.log(`\n══ 오버레이 인덱스 대조 — ${ovs.length}개 ══`);
  for (const o of ovs) {
    const raw = readFileSync(join(overlayDir, o), 'utf8');
    // ⛔⭐⭐⭐ 15차 리뷰 — ***세 번째로 같은 잘못***이다: 나는 또 «내 파서»를 손으로 지었다.
    //   ⑴ 6차: drift 가 정규식으로 선언을 읽었다 → 진짜 파서로
    //   ⑵ 13차: 이 자가 정규식으로 오버레이를 읽었다 → yaml 파서로
    //   ⑶ 15차: 그 yaml 판도 «내가 지은 검사»였다 — `op: bogus` 가 통과했고 인용된 path 를 놓쳤다
    //   🔑 ***이 저장소엔 이미 `parseGraphOverlayYaml` 이 있다.*** 오버레이를 «실제로 얹는» 코드가
    //      쓰는 바로 그 파서다. ⇒ 재발명하지 않고 그것을 부른다. 그러면 op 목록·stage·JSON Pointer 를
    //      «한 벌»로 지킨다.
    const ov = parseGraphOverlayYaml(raw, o);
    if (!ov.overlay) {
      for (const e of ov.errors) console.log(`  ⛔ ${e.path} — ${e.message}`);
      bad += 1; continue;
    }
    const target = ov.overlay.target;
    const nodes = names.get(target);
    if (!nodes) {
      // ⛔ 7차 리뷰 ② — 「대조 못 함」은 통과가 아니다. target 오타면 그 오버레이는 영영 안 얹힌다.
      console.log(`  ⛔ ${o} — target=${target} 를 이번 검사 대상에서 «못 찾았다»`);
      console.log('     ⇒ 오타면 그 오버레이는 영영 안 얹힌다. 대상에 그 선언을 포함시켜 다시 재라.');
      bad++; continue;
    }

    // ⛔⭐ 여기서부터가 «이 자만 하는 일»이다 — path 의 인덱스가 «어느 노드»를 가리키나.
    //   파서는 JSON Pointer 꼴만 본다. 인덱스가 «맞는 노드»인지는 아무도 안 본다.
    //   ⇒ 오버레이가 path 옆에 적어 둔 «노드 이름 주석»을 계약으로 삼는다.
    //   ⛔ 15차 리뷰 ② — 주석 지도를 «인용된 path» 도 잡도록 고쳤다(`path: "/nodes/7/…"`).
    const commentAt = new Map<number, string>();
    for (const m of raw.matchAll(/path:\s*["']?(\/nodes\/(\d+)\/\w+)["']?\s*(?:#\s*([\w-]+))?/g)) {
      if (m[3]) commentAt.set(Number(m[2]), m[3]);
    }
    for (const op of ov.overlay.patch) {
      const im = op.path.match(/^\/nodes\/(\d+)\//);
      if (!im) { console.log(`  ➖ ${o} — ${op.path} 는 노드 인덱스를 안 가리킨다(대조 생략)`); continue; }
      const i = Number(im[1]);
      // ⛔ 15차 리뷰 ② — 인덱스가 «범위 밖»이면 그 패치는 조용히 버려지거나 엉뚱한 곳을 때린다.
      if (i >= nodes.length) {
        console.log(`  ⛔ ${o} — /nodes/${i} 는 «범위 밖»이다(노드는 0..${nodes.length - 1})`);
        bad++; continue;
      }
      const want = commentAt.get(i);
      const actual = nodes[i];
      // ⛔ 「못 잰다」를 「통과」로 읽지 않는다 — 이름 주석이 없는 path 는 실패로 센다.
      if (!want) { console.log(`  ⛔ ${o} — /nodes/${i} 에 «노드 이름 주석»이 없다 — 인덱스를 검증할 수 없다`); bad++; continue; }
      if (actual !== want) { console.log(`  ⛔ ${o} — /nodes/${i} 는 «${actual}» 인데 주석은 «${want}» 다`); bad++; continue; }
      console.log(`  ✅ ${o} — /nodes/${i} = ${actual}`);
    }
  }
}

// ⛔⭐ 4차 리뷰 ② — 기대 실패로 «이름 댄» 파일이 검사 대상에 «없으면» 이 관문은 아무것도 재지 않았다.
//   그런데도 exit 0 이었다 — 오타 하나로 전수 검사가 «조용히» 무력해진다.
const unseen = [...expectFail].filter((n) => !seen.has(n));
if (unseen.length > 0) {
  console.error(`\n⛔ --expect-fail 로 이름 댄 파일이 검사 대상에 없다: ${unseen.join(', ')}`);
  console.error('   이름이 틀렸거나 파일이 사라졌다 — 그 상태로는 «기대 실패»를 잴 수 없다');
  process.exit(2);
}

process.exit(bad > 0 ? 1 : 0);
