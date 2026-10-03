import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const STORYBOARD_ROOT = resolve(import.meta.dir, '../..');
const DIR = join(STORYBOARD_ROOT, 'storyboards');

type Text = { text: string; source: string; ref?: string };
type Shot = {
  id: string; t: [number, number]; stage: string; layer?: string; persona?: string; purpose: string; subject?: string; action?: string;
  camera?: { move?: string; lens_mm?: number; angle?: string; framing?: string }; lighting?: string; color?: string;
  transition_in?: { type: string; intent: string }; on_screen_text?: Text[]; audio?: { vo?: string; sfx?: string; bgm?: string };
  generation?: { tool: string; model?: string; prompt?: string; asset?: string }; real_or_staged: string; state: string; notes?: string;
};
/** kind: site — a site's page structure, menu and copy draft, planned like a storyboard (SITE2 · 10-02). */
type Section = { id: string; title: string; purpose: string; change: string; copy?: Text[]; notes?: string };
type Site = { domain: string; role: string; preview?: string; branch?: string; nav: Array<{ label: string; href: string }>; pages: Array<{ path: string; sections: Section[] }> };
export type Storyboard = {
  id: string; kind: string; title: string; version: number; status: string; approved?: { by: string; at: string; note?: string } | null;
  supersedes?: string; owner: string; directive?: string; format: { aspects: string[]; duration_s: number; fps?: number; loop?: boolean; surface?: string };
  scqa?: { s?: string; c?: string; q?: string; a?: string }; principles?: string[]; layers?: Record<string, string>; shots: Shot[]; sites?: Site[];
  references?: string[]; open_questions?: string[];
};

const KINDS = ['teaser', 'site-hero', 'event-demo', 'persona-scene', 'explainer', 'ad', 'site'];
const CHANGES = ['keep', 'move', 'new', 'replace', 'remove'];
const STAGES = ['hook', 'buildup', 'climax', 'transition', 'end', 'loop'];
const SOURCES = ['real-ui', 'real-cli', 'real-output', 'copy', 'example'];

export function lint(sb: Storyboard, file = ''): { errors: string[]; warnings: string[] } {
  const errors: string[] = [], warnings: string[] = [];
  const need = (cond: unknown, msg: string) => { if (!cond) errors.push(msg); };
  need(/^[a-z0-9][a-z0-9-]{2,80}$/.test(sb.id ?? ''), 'id: 소문자·숫자·하이픈 3~80자');
  need(KINDS.includes(sb.kind), `kind: ${KINDS.join('|')}`);
  need(Number.isInteger(sb.version) && sb.version >= 1, 'version: 1 이상 정수');
  need(['draft', 'approved', 'superseded'].includes(sb.status), 'status: draft|approved|superseded');
  need(sb.owner, 'owner 필요');
  if (sb.status === 'approved') need(sb.approved?.by && sb.approved?.at, '승인본은 approved.by·at 필요');
  if (file && sb.kind && !file.includes(`/${sb.kind}/`)) errors.push(`파일 위치가 kind(${sb.kind}) 폴더가 아니다`);
  if (sb.kind === 'site') return lintSite(sb, errors, warnings);
  need(sb.format?.aspects?.length && sb.format.duration_s > 0, 'format.aspects ⊕ duration_s 필요');
  if (!Array.isArray(sb.shots) || !sb.shots.length) { errors.push('shots 가 비었다'); return { errors, warnings }; }
  const ids = new Set<string>();
  sb.shots.forEach((s, i) => {
    const at = `shots[${i}](${s.id ?? '?'})`;
    need(s.id && !ids.has(s.id), `${at}: id 없음·중복`); ids.add(s.id);
    need(Array.isArray(s.t) && s.t.length === 2 && s.t[0] < s.t[1], `${at}: t = [시작, 끝] 이고 시작 < 끝`);
    need(STAGES.includes(s.stage), `${at}: stage ${STAGES.join('|')}`);
    need(s.purpose, `${at}: purpose(이 비트의 한 가지) 필요`);
    need(['real', 'staged', 'composite'].includes(s.real_or_staged), `${at}: real_or_staged 필요`);
    need(['planned', 'shot', 'approved'].includes(s.state), `${at}: state planned|shot|approved`);
    if (s.transition_in && !s.transition_in.intent) errors.push(`${at}: 전환에는 의도 한 줄(«그냥 컷»은 설계가 아니다)`);
    for (const txt of s.on_screen_text ?? []) {
      need(SOURCES.includes(txt.source), `${at}: 화면 문구 «${txt.text}» 의 source 가 ${SOURCES.join('|')} 가 아니다`);
      if (txt.source?.startsWith('real-') && !txt.ref) warnings.push(`${at}: 실제 문면 «${txt.text}» 에 ref(출처) 가 없다`);
      if (/\d/.test(txt.text) && txt.source === 'copy') warnings.push(`${at}: 마케팅 문구에 숫자 «${txt.text}» — 실측 근거나 «example» 로`);
    }
    if (s.generation?.tool === 'higgsfield' && !s.generation.prompt) warnings.push(`${at}: 힉스필드 샷에 prompt 가 없다`);
    if (s.real_or_staged !== 'real' && !/연출/.test(JSON.stringify(sb))) warnings.push(`${at}: 연출 샷이 있는데 문서 어디에도 «연출 장면» 표기가 없다`);
  });
  const end = Math.max(...sb.shots.map((s) => s.t?.[1] ?? 0));
  if (sb.format?.duration_s && Math.abs(end - sb.format.duration_s) > 0.5) warnings.push(`마지막 샷 끝(${end}s) ≠ format.duration_s(${sb.format.duration_s}s)`);
  return { errors, warnings };
}

/** A site plan has pages instead of shots: every section says why it is there and what changes; copy names its source. */
function lintSite(sb: Storyboard, errors: string[], warnings: string[]): { errors: string[]; warnings: string[] } {
  if (!Array.isArray(sb.sites) || !sb.sites.length) { errors.push('site 종류는 sites 가 필요하다'); return { errors, warnings }; }
  for (const site of sb.sites) {
    const at = `sites(${site.domain ?? '?'})`;
    if (!site.domain || !site.role) errors.push(`${at}: domain ⊕ role(이 사이트가 맡는 것) 필요`);
    if (!site.nav?.length) errors.push(`${at}: nav(메뉴) 필요`);
    if (!site.pages?.length) errors.push(`${at}: pages 필요`);
    if (!site.preview) warnings.push(`${at}: preview(미리보기 주소) 없음`);
    const ids = new Set<string>();
    for (const page of site.pages ?? []) for (const sec of page.sections ?? []) {
      const where = `${at}${page.path} #${sec.id ?? '?'}`;
      if (!sec.id || ids.has(`${page.path}#${sec.id}`)) errors.push(`${where}: id 없음·중복`);
      ids.add(`${page.path}#${sec.id}`);
      if (!sec.purpose) errors.push(`${where}: purpose(이 칸이 하는 한 가지) 필요`);
      if (!CHANGES.includes(sec.change)) errors.push(`${where}: change ${CHANGES.join('|')}`);
      for (const txt of sec.copy ?? []) {
        if (!SOURCES.includes(txt.source)) errors.push(`${where}: 문구 «${txt.text}» 의 source 가 ${SOURCES.join('|')} 가 아니다`);
        if (/\d/.test(txt.text) && txt.source === 'copy' && !txt.ref) warnings.push(`${where}: 마케팅 문구에 숫자 «${txt.text}» — ref(실측 근거) 를 단다`);
      }
    }
  }
  return { errors, warnings };
}

function renderSites(sb: Storyboard): string[] {
  return (sb.sites ?? []).flatMap((site) => [
    `## ${site.domain} — ${site.role}`, '',
    ...(site.preview ? [`- 미리보기: ${site.preview}${site.branch ? ` (가지 \`${site.branch}\`)` : ''}`] : []),
    `- 메뉴: ${site.nav.map((n) => `${n.label}(${n.href})`).join(' · ')}`, '',
    ...site.pages.flatMap((page) => [
      `### ${page.path}`, '', '| # | 칸 | 제목 | 목적 | 바뀜 | 문구(출처) | 메모 |', '|---|---|---|---|---|---|---|',
      ...page.sections.map((sec, i) => `| ${i + 1} | ${md(sec.id)} | ${md(sec.title)} | ${md(sec.purpose)} | ${sec.change} | ${md((sec.copy ?? []).map((x) => `«${x.text}»(${x.source}${x.ref ? ` · ${x.ref}` : ''})`).join(' / '))} | ${md(sec.notes)} |`),
      '',
    ]),
  ]);
}

const md = (v: unknown) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
export function render(sb: Storyboard, file: string): string {
  const head = [
    `# STORYBOARD — ${sb.title} (v${sb.version} · ${sb.status}${sb.approved ? ` · 승인 ${sb.approved.by} ${sb.approved.at}` : ''})`,
    '',
    `> ⛔ 자동 생성 — 손으로 고치지 않는다. 정본 = \`${file}\` · 다시 뽑기 = \`bun scripts/storyboard/storyboard.ts render ${file}\`.`,
    `> 종류 ${sb.kind} · 소유 ${sb.owner}${sb.format ? ` · ${sb.format.aspects.join(' · ')} · ${sb.format.duration_s}초${sb.format.loop ? ' · 반복' : ''}${sb.format.surface ? ` · ${sb.format.surface}` : ''}` : ''}${sb.supersedes ? ` · 앞 판 ${sb.supersedes}` : ''}`,
    ...(sb.directive ? [`> 지시: ${sb.directive}`] : []),
    '',
  ];
  const scqa = sb.scqa ? ['## SCQA', ...(['s', 'c', 'q', 'a'] as const).filter((k) => sb.scqa?.[k]).map((k) => `- **${k.toUpperCase()}** — ${sb.scqa![k]}`), ''] : [];
  const pr = sb.principles?.length ? ['## 원칙', ...sb.principles.map((p, i) => `${i + 1}. ${p}`), ''] : [];
  const layers = sb.layers ? ['## 층', ...Object.entries(sb.layers).map(([k, v]) => `- **${k}** — ${v}`), ''] : [];
  const table = sb.kind === 'site' ? renderSites(sb) : [
    '## 샷 구조표',
    '| # | 초 | 단계 | 층·인물 | 목적 | 화면(피사체·행동) | 카메라 | 빛·색 | 전환(의도) | 화면 문구(출처) | 소리 | 만들기 | 실물/연출 · 상태 |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...sb.shots.map((s) => `| ${md(s.id)} | ${s.t[0]}–${s.t[1]} | ${s.stage} | ${md([s.layer, s.persona].filter(Boolean).join(' · '))} | ${md(s.purpose)} | ${md([s.subject, s.action].filter(Boolean).join(' — '))} | ${md(s.camera ? [s.camera.move, s.camera.lens_mm ? `${s.camera.lens_mm}mm` : '', s.camera.angle, s.camera.framing].filter(Boolean).join(' · ') : '')} | ${md([s.lighting, s.color].filter(Boolean).join(' · '))} | ${md(s.transition_in ? `${s.transition_in.type} — ${s.transition_in.intent}` : '')} | ${md((s.on_screen_text ?? []).map((x) => `«${x.text}»(${x.source}${x.ref ? ` · ${x.ref}` : ''})`).join(' / '))} | ${md(s.audio ? [s.audio.vo && `VO ${s.audio.vo}`, s.audio.sfx && `SFX ${s.audio.sfx}`, s.audio.bgm && `BGM ${s.audio.bgm}`].filter(Boolean).join(' · ') : '')} | ${md(s.generation ? [s.generation.tool, s.generation.model].filter(Boolean).join(' · ') : '')} | ${s.real_or_staged} · ${s.state} |`),
    '',
  ];
  const shots = sb.shots ?? [];
  const prompts = shots.filter((s) => s.generation?.prompt);
  const pblock = prompts.length ? ['## 생성 프롬프트', ...prompts.flatMap((s) => [`### ${s.id} · ${s.generation!.tool}${s.generation!.model ? ` · ${s.generation!.model}` : ''}`, '```', s.generation!.prompt!.trim(), '```', ...(s.generation!.asset ? [`결과: \`${s.generation!.asset}\``] : []), ''])] : [];
  const notes = shots.filter((s) => s.notes).map((s) => `- ${s.id}: ${s.notes}`);
  const tail = [
    ...(notes.length ? ['## 샷 메모', ...notes, ''] : []),
    ...(sb.open_questions?.length ? ['## 열린 물음', ...sb.open_questions.map((q) => `- ${q}`), ''] : []),
    ...(sb.references?.length ? ['## 참고', ...sb.references.map((r) => `- ${r}`), ''] : []),
  ];
  return [...head, ...scqa, ...pr, ...layers, ...table, ...pblock, ...tail].join('\n');
}

export function files(args: string[]): string[] {
  if (args.length) return args.map((a) => resolve(a));
  const out: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.ya?ml$/.test(f) && !f.startsWith('_')) out.push(p); } };
  walk(DIR);
  return out.sort();
}
