// ELS-PRODUCT-SPLIT 경계 가드의 스캐너(boundary.test.ts 가 쓴다 · 단위 시험 boundary-scan.test.ts).
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type ImportKind = 'static' | 'side-effect' | 'dynamic' | 'require' | 'typeof';
export type ImportSite = { spec: string; typeOnly: boolean; kind: ImportKind };

export const walkSources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walkSources(p);
    return /\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [p] : [];
  });

// import 문 단위로 판별한다(같은 경로의 `import type` 과 런타임 import 가 섞여도 각각 본다).
// 잡는 것: 정적 import/export…from · 부수효과 import 'x' · 동적 import('x') · require('x').
// `typeof import('x')` 는 타입 위치라 type-only. `import { type A } from` 은 보수적으로 런타임으로 센다.
export const scanImports = (text: string): ImportSite[] => {
  const sites: ImportSite[] = [];
  const staticRe = /^[ \t]*(?:import|export)\s+(type\s+)?[^'"]*?from\s*['"]([^'"]+)['"]/gm;
  for (const m of text.matchAll(staticRe)) sites.push({ spec: m[2]!, typeOnly: !!m[1], kind: 'static' });
  const sideEffectRe = /^[ \t]*import\s*['"]([^'"]+)['"]/gm;
  for (const m of text.matchAll(sideEffectRe)) sites.push({ spec: m[1]!, typeOnly: false, kind: 'side-effect' });
  const dynamicRe = /(?<!typeof\s+)\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of text.matchAll(dynamicRe)) sites.push({ spec: m[1]!, typeOnly: false, kind: 'dynamic' });
  const typeofRe = /\btypeof\s+import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of text.matchAll(typeofRe)) sites.push({ spec: m[1]!, typeOnly: true, kind: 'typeof' });
  const requireRe = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of text.matchAll(requireRe)) sites.push({ spec: m[1]!, typeOnly: false, kind: 'require' });
  return sites;
};

export type SourceFile = { path: string; text: string };
export const tallyImports = (files: SourceFile[], accept: (site: ImportSite, path: string) => boolean): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const f of files) {
    for (const site of scanImports(f.text)) {
      if (!accept(site, f.path)) continue;
      const key = `${f.path}|${site.spec}|${site.kind}`;
      out[key] = (out[key] ?? 0) + 1;
    }
  }
  return out;
};
// 기준선 단위 = (파일 | 지정자 문자열 | 종류) 별 허용 건수. 초과 = 새 결합(FAIL) · 감소 = 표를 줄여 갱신하라는 안내.
export const compareToBaseline = (actual: Record<string, number>, baseline: Record<string, number>): { over: string[]; under: string[] } => ({
  over: Object.keys(actual).filter((k) => actual[k]! > (baseline[k] ?? 0)).sort(),
  under: Object.keys(baseline).filter((k) => (actual[k] ?? 0) < baseline[k]!).sort(),
});

// ELN-AGENT-EVENT-PROTOCOL(#121363/#121367 mustFix · 안2) — 위 accept 래칫은 표기(문자 패턴)만 세고 지정자를
// 해석한 뒤의 실제 목적지를 보지 못한다('../tui/../els/protocol.js' 같은 우회 표기는 /^(..\/)+els(\/|$)/ 밖).
// agentEventElsImports 는 기존 검사(boundary.test.ts agent-event 블록)의 표기 기준과 동등 이상으로
// 중립 규약 파일(src/tui/agent-event-bridge.ts · src/agent-events/**)의 src/els 유입을 잡는다:
// ① 표기에 els 경로 세그먼트가 있으면 잡는다(해석 불능 지정자도 여기서 안전하게 잡힌다 — 건너뛰지 않는다).
// ② 해석 가능한 지정자는 해석해 실제 목적지가 src/els 안이면 잡는다(우회 표기 — 래칫 문자 패턴 밖 — 도 잡는다).
const ELS_SEGMENT_RE = /(^|\/)els(\/|$)/; // 기존 검사와 동일한 표기 기준

// 상대(./ · ../)·절대(/) 지정자만 해석한다 — 나머지(bare 패키지 · node: 스킴 · http…)는 해석 불능(null).
// 가상 루트 '/' 를 얹어 해석: file.path 가 저장소 상대(src/…)여도 절대 경로여도 cwd 무관 같은 세그먼트가 나온다.
const resolvedSegments = (from: string, spec: string): string[] | null => {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null;
  return resolve(dirname(from.startsWith('/') ? from : `/${from}`), spec).split('/').filter(Boolean);
};

// 해석된 목적지 세그먼트에 src/els 쌍이 있으면 src/els 안으로 본다(중간에 src/…/src/els 처럼 겹쳐도
// 넓게 잡는 쪽이 경계 가드에 안전 — 과잉은 거짓 양성 방향이지 누락 방향이 아니다).
const underEls = (segments: string[]): boolean => segments.some((seg, i) => seg === 'els' && segments[i - 1] === 'src');

export const agentEventElsImports = (files: SourceFile[]): string[] => {
  const hits: string[] = [];
  for (const f of files) {
    for (const site of scanImports(f.text)) {
      const segments = resolvedSegments(f.path, site.spec);
      if (ELS_SEGMENT_RE.test(site.spec) || (segments !== null && underEls(segments))) hits.push(`${f.path}: ${site.spec}`);
    }
  }
  return hits;
};
