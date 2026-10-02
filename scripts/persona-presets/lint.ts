#!/usr/bin/env bun
// 페르소나 프리셋 문면 검사(PS1 · 2026-10-02) — persona-presets/<id>.yaml
//   bun scripts/persona-presets/lint.ts   오류가 있으면 rc 1 · 경고만이면 rc 0
// 지키는 것: 도구는 «지금 설치할 수 있는 것»만(공개 묶음 표 · 저장소 플러그인 · core) · 용어(«캐릭터» 금지) ·
//           자리(OP·MK·TC·UX)와 이름이 겹치지 않음 · 직함은 선택 속성 · 과장 금지어.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

const ROOT = resolve(import.meta.dir, '../..');
const DIR = join(ROOT, 'persona-presets');

export type Preset = {
  personaId: string; displayName: string; names: string[]; role: string; title?: string | null; oneLine: string;
  voice: { rule: string; examples: string[] }; tasks: Array<{ when: string; what: string }>;
  tools: Array<{ name: string; from: string; optional?: boolean }>; firstQuestions: string[]; askBefore?: string[]; doesNot: string[]; forWhom: string;
};

const CORE = new Set(['harness']);
const TITLES = new Set(['COO', 'CMO', 'CTO', 'CXO']);
const SEATS = /^(OP|MK|TC|UX)$/i;
const BANNED = ['캐릭터', '완전 자율', '무엇이든', '유일', '알아서 다'];

/** Official packs and the skills each one lists, read from the public plugin table (the same page users read). */
export function officialPacks(root = ROOT): Map<string, string> {
  const table = readFileSync(join(root, 'release/public/docs/plugins.md'), 'utf8');
  const packs = new Map<string, string>();
  for (const row of table.split('\n')) {
    const m = row.match(/^\| `([a-z0-9-]+)` \| (.*) \| (.*) \|$/);
    if (m && !/not published/i.test(m[3]!)) packs.set(m[1]!, m[2]!);
  }
  return packs;
}

export function lintPreset(p: Preset, file: string, packs: Map<string, string>, root = ROOT): { errors: string[]; warnings: string[] } {
  const errors: string[] = []; const warnings: string[] = [];
  const need = (ok: unknown, msg: string) => { if (!ok) errors.push(msg); };
  need(/^[a-z][a-z0-9-]{1,30}$/.test(p.personaId ?? '') && file.endsWith(`/${p.personaId}.yaml`), 'personaId = 파일 이름(소문자)');
  need(p.displayName && p.role && p.oneLine && p.forWhom, 'displayName · role · oneLine · forWhom 필요');
  need(Array.isArray(p.names) && p.names.length >= 2, 'names 후보 둘 이상');
  need(p.voice?.rule && p.voice.examples?.length === 2, 'voice = rule ⊕ 예시 두 줄');
  need(p.tasks?.length === 3 && p.tasks.every((t) => t.when && t.what), 'tasks = 할 일 셋(when · what)');
  need(p.firstQuestions?.length >= 2 && p.firstQuestions.length <= 3, 'firstQuestions = 처음 묻는 칸 둘~셋');
  need(p.doesNot?.length >= 2, 'doesNot = 하지 않는 것 둘 이상');
  if (p.title != null && !TITLES.has(p.title)) errors.push(`title 은 없음 또는 ${[...TITLES].join('·')}`);
  for (const name of p.names ?? []) if (SEATS.test(name)) errors.push(`이름 «${name}» 이 자리(OP·MK·TC·UX)와 겹친다`);
  const text = JSON.stringify(p);
  for (const word of BANNED) if (text.includes(word)) errors.push(`금지어 «${word}»`);
  for (const tool of p.tools ?? []) {
    if (tool.from === 'core') { if (!CORE.has(tool.name)) errors.push(`core 도구 «${tool.name}» 는 없다`); continue; }
    const row = packs.get(tool.from);
    if (row !== undefined) {
      if (tool.from !== tool.name && !row.includes(`\`${tool.name}\``)) errors.push(`«${tool.name}» 이 묶음 «${tool.from}» 의 목록에 없다`);
      continue;
    }
    // 공식 묶음에 없는 도구 = 저장소 플러그인일 때만 · 반드시 optional(공개 판 사용자는 따로 설치해야 쓴다)
    if (tool.from !== tool.name || !existsSync(join(root, 'plugins', tool.name, 'plugin.json'))) errors.push(`«${tool.name}» 은 공식 묶음에도 plugins/${tool.name}/plugin.json 에도 없다`);
    else if (tool.optional !== true) errors.push(`«${tool.name}» 은 공식 묶음에 없다 — optional: true 로 둔다`);
    else warnings.push(`«${tool.name}» 은 선택 도구(공식 묶음 게재 전)`);
  }
  return { errors, warnings };
}

if (import.meta.main) {
  const packs = officialPacks();
  const index = parse(readFileSync(join(DIR, '_index.yaml'), 'utf8')) as { presets: string[] };
  const files = readdirSync(DIR).filter((f) => f.endsWith('.yaml') && !f.startsWith('_'));
  let bad = 0; const names = new Map<string, string>();
  for (const f of files) {
    const p = parse(readFileSync(join(DIR, f), 'utf8')) as Preset;
    const { errors, warnings } = lintPreset(p, `persona-presets/${f}`, packs);
    if (!index.presets.includes(p.personaId)) errors.push('_index.yaml presets 에 없다');
    for (const n of p.names ?? []) { if (names.has(n)) errors.push(`이름 «${n}» 이 ${names.get(n)} 와 겹친다`); names.set(n, p.personaId); }
    for (const e of errors) console.log(`✗ ${f}: ${e}`);
    for (const w of warnings) console.log(`⚠ ${f}: ${w}`);
    if (errors.length) bad++; else console.log(`✓ ${f} · ${p.displayName} · 도구 ${p.tools.length}`);
  }
  process.exit(bad ? 1 : 0);
}
