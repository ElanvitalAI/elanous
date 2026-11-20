// ELS-PRODUCT-SPLIT 경계 가드의 스캐너(boundary.test.ts 가 쓴다 · 단위 시험 boundary-scan.test.ts).
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type ImportSite = { spec: string; typeOnly: boolean };

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
  for (const m of text.matchAll(staticRe)) sites.push({ spec: m[2]!, typeOnly: !!m[1] });
  const sideEffectRe = /^[ \t]*import\s*['"]([^'"]+)['"]/gm;
  for (const m of text.matchAll(sideEffectRe)) sites.push({ spec: m[1]!, typeOnly: false });
  const dynamicRe = /(?<!typeof\s+)\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of text.matchAll(dynamicRe)) sites.push({ spec: m[1]!, typeOnly: false });
  const typeofRe = /\btypeof\s+import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of text.matchAll(typeofRe)) sites.push({ spec: m[1]!, typeOnly: true });
  const requireRe = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of text.matchAll(requireRe)) sites.push({ spec: m[1]!, typeOnly: false });
  return sites;
};
