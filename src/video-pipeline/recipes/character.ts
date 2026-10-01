/**
 * 🧑‍🎨 캐릭터 → 영상 레시피 — `character-video-standard.yaml` 의 «코드» 쪽.
 *
 * ⭐ 출처 — 2026-09-17 `~/Movies/CharacterPipeline`(NOVA) 실물 작업과 그 README 의 «잰» 지형:
 *   - Higgsfield 에는 «시트를 그려 주는» 도구가 없다 — 일반 이미지 모델에 프롬프트로 그린다.
 *   - 등록 갈래: **Element**(이미지 한 장 · 즉시) ↔ **Soul**(5~20장 · 얼굴 검출이 선행 관문 — 일러스트는 `face_not_found`).
 *   - 편집 엔진은 DaVinciStack build.py 와 «같다» ⇒ film 레시피(마스터·소셜)를 그대로 쓴다.
 *
 * ⛔ 생성 노드(시트·뷰·등록·샷)는 ***Higgsfield 크레딧을 쓴다*** — 이 레시피들은 «이미 생성된 것»을 받는다.
 *   (2026-09-23 과금 인시던트 직후라 러너가 스스로 크레딧을 태우지 않는다. 생성은 스킬·MCP 세션의 몫.)
 * ⛔⭐ 판정 둘은 ***도구가 원리상 못 잰다*** — 사람이 «말해 준» 사실로만 통과한다(`told` · RFC §4 의 그 패턴):
 *   - 정체성 유지(identity-holds-gate): 「새 장면에서도 같은 캐릭터인가」는 눈이 본다.
 *   - 연출 원칙(animation-principles-gate): 샷 자(`08_shot_ruler.py`)는 스스로 ***「순위 자일 뿐 판정선이 없다」***고 적었다
 *     (📏 2026-09-23: 연출 있는 shot2 = 0.708 < 연출 없는 대조군 0.851).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { searchVflowReferences } from '../vflow-reference.js';
import { run } from './ffmpeg.js';
import { resolvePython } from '../../python/resolve-python.js';
import { UNOBSERVED, type Recipe } from './types.js';
import { assembleMaster, DEFAULT_TARGETS, inkRuler as filmInkRuler, measureInk, reframeSocial, type PlanRow, type Target } from './film.js';

const need = (key: string) => ({ outcome: UNOBSERVED, note: `계약 입력 '${key}' 가 state 에 없다 — 앞 노드가 안 채웠다(실패가 «아니다»)` });
const IMG = /\.(png|jpe?g|webp)$/i;
const imagesIn = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((f) => IMG.test(f) && !f.startsWith('_')).sort().map((f) => join(dir, f)) : []);
/** 사람이 «말해 준» 사실(1/0). ⛔ 없으면 undefined — 「아니다」가 아니다. */
const told = (state: Readonly<Record<string, unknown>>, key: string): boolean | undefined => {
  const v = (state.told as Record<string, unknown> | undefined)?.[key];
  return v === undefined ? undefined : Number(v) === 1;
};

// ── reference · pin-collect ────────────────────────────────────────────────
export const pinCollect: Recipe = async (ctx) => {
  const dir = ctx.state.pins_dir as string | undefined;
  if (!dir) return need('pins_dir');
  const pins = imagesIn(dir);
  const queries = (ctx.state.queries as string[] | undefined) ?? [];
  return pins.length === 0
    ? { outcome: 'empty', produced: { pins: [], query_count: queries.length }, note: '핀 0 — ⚠️ 로그아웃이면 쿼리당 16~22핀에서 멎는다(폭은 쿼리 수로 번다)' }
    : { outcome: 'ok', produced: { pins, query_count: queries.length }, note: `핀 ${pins.length}장` };
};

// ── sheet · model-sheet ────────────────────────────────────────────────────
export const modelSheet: Recipe = async (ctx) => {
  const p = ctx.state.sheet_path as string | undefined;
  if (p && existsSync(p)) return { outcome: 'ok', produced: { sheet_path: p, sheet_job: null }, note: `⚠️ 이미 그린 시트를 받았다 — ${p.split('/').pop()}` };
  return { outcome: 'error', produced: { sheet_path: null, sheet_job: null }, note: '시트가 없다 — ⛔ 이 러너는 크레딧을 안 쓴다. 이미지 모델(nano_banana_pro)로 그려 sheet_path 로 준다' };
};

/**
 * 시트에서 «칸»을 센다 — 배경과 다른 열의 «덩어리» 수(가로 방향). ⛔ 표정·팔레트는 못 잰다(null).
 * ⛔ 못 읽으면 unreadable — 0 칸이 아니다.
 */
export function countPanels(path: string): number | null {
  const W = 400, H = 225;
  const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-vf', `scale=${W}:${H},format=gray`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 }).stdout as Buffer;
  if (!raw || raw.length < W * H) return null;
  const border = [...Array(W).keys()].flatMap((x) => [raw[x]!, raw[(H - 1) * W + x]!]).sort((a, b) => a - b);
  const bg = border[Math.floor(border.length / 2)]!;
  const content = [...Array(W).keys()].map((x) => {
    let n = 0; for (let y = 0; y < H; y++) if (Math.abs(raw[y * W + x]! - bg) > 30) n++;
    return n > H * 0.02;
  });
  let runs = 0, gap = 99;
  for (const c of content) { if (c) { if (gap >= Math.round(W * 0.01)) runs++; gap = 0; } else gap++; }
  return runs;
}

// ── sheet-gate · sheet-panels-gate ─────────────────────────────────────────
export const sheetPanelsGate: Recipe = async (ctx) => {
  const p = ctx.state.sheet_path as string | undefined;
  if (!p || !existsSync(p)) return { outcome: 'unreadable', note: '시트 파일이 없다' };
  const n = countPanels(p);
  if (n === null) return { outcome: 'unreadable', note: '시트를 못 읽었다' };
  const produced = { turnaround_views: n, expression_count: null, palette_found: null };
  return n >= 3 ? { outcome: 'pass', produced, note: `칸 ${n}개(가로 덩어리) · ⚠️ 표정·팔레트는 «안 쟀다»(null)` }
    : { outcome: 'thin', produced, note: `칸 ${n}개 — 턴어라운드가 되려면 3 이상` };
};

// ── views · single-character-views ─────────────────────────────────────────
export const singleCharacterViews: Recipe = async (ctx) => {
  const dir = ctx.state.views_dir as string | undefined;
  if (!dir) return need('views_dir');
  const views = imagesIn(dir);
  if (views.length === 0) return { outcome: 'error', note: '뷰 0 — ⛔ 이 러너는 크레딧을 안 쓴다' };
  return { outcome: views.length >= 3 ? 'ok' : 'partial', produced: { view_jobs: views, view_count: views.length }, note: `뷰 ${views.length}장${views.length < 3 ? ' — 3장 미만' : ''} · ⚠️ 이미 생성된 것을 받았다` };
};

// ── register · identity-register ──────────────────────────────────────────
export const identityRegister: Recipe = async (ctx) => {
  const element_id = (ctx.state.element_id as string | undefined) ?? null;
  const soul_id = (ctx.state.soul_id as string | undefined) ?? null;
  const soul_fail_reason = (ctx.state.soul_fail_reason as string | undefined) ?? null;
  const produced = { element_id, soul_id, soul_fail_reason };
  if (element_id && soul_id) return { outcome: 'both', produced, note: `Element ${element_id.slice(0, 8)} ⊕ Soul ${soul_id.slice(0, 8)}` };
  if (element_id) return { outcome: 'element-only', produced, note: `Element ${element_id.slice(0, 8)}${soul_fail_reason ? ` · Soul 실패(${soul_fail_reason}) — 일러스트는 Element 가 맞는 갈래다` : ''}` };
  return { outcome: 'none', produced, note: '등록된 정체성이 없다 — Element(이미지 한 장)부터' };
};

// ── register-gate · identity-holds-gate ───────────────────────────────────
export const identityHoldsGate: Recipe = async (ctx) => {
  if (!ctx.state.element_id) return need('element_id');
  const probe_job = (ctx.state.probe_image as string | undefined) ?? null;
  const t = told(ctx.state, 'identity_holds');
  if (t === undefined) return { outcome: 'unprobed', produced: { identity_holds: null, probe_job }, note: `⛔ 「새 장면에서도 같은 캐릭터인가」는 눈이 본다 — ${probe_job ? `검증 컷 ${probe_job.split('/').pop()} 을 보고 ` : ''}--told identity_holds=1|0` };
  return { outcome: t ? 'holds' : 'drifts', produced: { identity_holds: t, probe_job }, note: `🗣️ 사람이 «말해 준» 값 — ${t ? '유지된다' : '흔들린다'} (⛔ 실측이 아니다)` };
};

// ── shots · directed-shots ────────────────────────────────────────────────
export const directedShots: Recipe = async (ctx) => {
  const src = ctx.state.shot_sources as Record<string, string> | undefined;
  if (!src) return need('shot_sources');
  const prompts = ctx.state.shot_prompts as Record<string, string> | undefined;
  const existingShots = Object.entries(src).filter(([, path]) => existsSync(path));
  const shot_paths = existingShots.map(([, path]) => path);
  const promptedShots = existingShots.filter(([shot]) => prompts?.[shot] !== undefined);
  const shot_references: Record<string, { url: string; videoUrl: string | null; model: string; name: string; author: string | null; authorUrl: string | null; camera: string[] }[]> = {};
  let referenceNote = '';
  if (prompts && Object.keys(prompts).length && shot_paths.length) {
    const file = (ctx.state.vflow_file as string | undefined) ?? join(homedir(), 'docs', 'ref', 'vflow', 'prompts.ndjson');
    const taxonomy = readFileSync(join(import.meta.dir, '../../../graphs/video/reference/vflow-taxonomy.yaml'), 'utf8');
    const cameraAxis = taxonomy.match(/^  camera_movement:.*\n((?:^    .*\n)*)/m)?.[1] ?? '';
    const cameraTerms = [...cameraAxis.matchAll(/term:\s*([^,}]+)/g)].map((match) => match[1]!.trim());
    // These shot-prompt camera terms supplement the site's taxonomy axis.
    cameraTerms.push('crash zoom', 'dolly', 'static');
    const cameraPatterns = cameraTerms.map((term) => {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return { term, pattern: new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu') };
    });
    let found = 0;
    for (const [shot] of promptedShots) {
      const prompt = prompts[shot]!;
      const camera = cameraPatterns.filter(({ pattern }) => pattern.test(prompt)).map(({ term }) => term);
      const result = searchVflowReferences(file, { camera, model: ctx.state.shot_model as string | undefined, limit: camera.length ? 3 : 0 });
      if (!result.available) {
        referenceNote = `vflow DB 없음(${result.reason})`;
        break;
      }
      shot_references[shot] = result.rows.map((row) => ({
        url: row.url, videoUrl: row.video?.url ?? null, model: row.model, name: row.name,
        author: row.author, authorUrl: row.authorUrl, camera: row.spec?.camera ?? [],
      }));
      if (shot_references[shot]!.length) found++;
    }
    if (!referenceNote) referenceNote = `vflow 참고 ${found}샷/${shot_paths.length}샷`;
  }
  const note = (text: string) => referenceNote ? `${text}\n${referenceNote}` : text;
  if (shot_paths.length === 0) return { outcome: 'error', produced: prompts ? { shot_references } : undefined, note: note('샷 0 — ⛔ 이 러너는 크레딧을 안 쓴다(Seedance·Kling 생성은 스킬 세션의 몫)') };
  const produced = { shot_paths, shot_count: shot_paths.length, ...(prompts ? { shot_references } : {}) };
  // ⛔⭐ 되돌이 수렴(🩸 2026-09-23 실물: fullbleed → shots → «같은» 샷 → fullbleed … 예산 소진).
  //   리프레임 자가 「그 비율로 다시 렌더하라」고 돌려보냈는데 이 러너는 다시 그릴 수 없다(크레딧 무사용)
  //   ⇒ 같은 샷을 또 내면 같은 판정이 난다. 「못 다시 그린다」를 error 로 말해 `rendered-unedited` 로 끝낸다.
  const pending = (ctx.state.fullbleed_cuts as string[] | undefined) ?? [];
  if (pending.length) return { outcome: 'error', produced, note: note(`전용 비율 재렌더가 필요한 샷 ${pending.join(', ')} — ⛔ 이 러너는 다시 그리지 않는다(크레딧 무사용) · 그 비율 렌더를 스킬 세션에서 만든 뒤 native 로 넘겨라`) };
  return { outcome: 'ok', produced, note: note(`샷 ${shot_paths.length}개 · ⚠️ 이미 생성된 것을 받았다`) };
};

/** `08_shot_ruler.py` 의 `shot_variation` 한 칸만 읽는다(그 자가 «살아남은 유일한 칸»이라 스스로 적었다). */
export function shotVariation(ruler: string, paths: readonly string[]): Record<string, number> | null {
  const r = run(resolvePython()?.path ?? 'python3', [ruler, ...paths], 900_000);
  if (!r.ok) return null;
  const out: Record<string, number> = {};
  for (const line of r.out.split('\n')) {
    const cols = line.split('|').map((x) => x.trim());
    if (cols.length >= 7 && /\.mp4$/i.test(cols[0]!)) out[cols[0]!] = Number(cols[6]);
  }
  return Object.keys(out).length ? out : null;
}

// ── shot-gate · animation-principles-gate ─────────────────────────────────
export const animationPrinciplesGate: Recipe = async (ctx) => {
  const shots = ctx.state.shot_paths as string[] | undefined;
  if (!shots) return need('shot_paths');
  const ruler = ctx.state.shot_ruler as string | undefined;
  const sv = ruler && existsSync(ruler) ? shotVariation(ruler, shots) : null;
  const svNote = sv ? `shot_variation ${Object.entries(sv).map(([k, v]) => `${k.replace(/\.mp4$/, '')} ${v}`).join(' · ')}` : 'shot_variation 못 잼';
  const produced = { anticipation_seen: null, squash_seen: null, character_held: null, shot_variation: sv };
  const t = told(ctx.state, 'shots_principled');
  if (t === undefined) return { outcome: 'unviewed', produced, note: `⛔ 판정선이 없는 순위 자다(연출 있는 shot2 0.708 < 대조군 0.851) — 사람이 본다: --told shots_principled=1|0 · ${svNote}` };
  return { outcome: t ? 'principled' : 'flat', produced, note: `🗣️ 사람이 «말해 준» 값(⛔ 실측 아님) · 📏 참고 ${svNote}` };
};

// ── reframe-decide · ink-ruler (film 과 «이름»을 같이 쓴다) ───────────────
/**
 * ⛔⭐ 이 이름을 film 과 character 가 «다른 계약»으로 쓴다(2026-09-23 · find-narrative 와 같은 함정):
 *   film      inputs [mixed_path, plan, targets] → croppable | needs-native
 *   character inputs [shot_paths, targets]       → croppable | fullbleed
 *   ⇒ 한 이름 · ***입력 모양으로 갈래를 고른다***. 레시피 표를 합쳐도 어느 쪽이 걷든 죽지 않는다.
 */
export const inkRulerAny: Recipe = async (ctx) => {
  if (ctx.state.plan && ctx.state.mixed_path) return filmInkRuler(ctx);
  const shots = ctx.state.shot_paths as string[] | undefined;
  if (!shots) return need('shot_paths');
  const targets = (ctx.state.targets as Target[] | undefined) ?? DEFAULT_TARGETS;
  const native = (ctx.state.native_sources as Record<string, Record<string, string>> | undefined) ?? {};
  const max_zoom: Record<string, number> = {};
  const fullbleed_cuts: string[] = [];
  const ink: Record<string, ReturnType<typeof measureInk>> = {};
  for (const p of shots) {
    const d = Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p]).out.trim()) || 5;
    const k = measureInk(p, d);
    const name = p.split('/').pop()!.replace(/\.[^.]+$/, '');
    ink[name] = k;
    const width = (k.R - k.L) / 1920;
    max_zoom[name] = +(1 / Math.max(width, 1e-3)).toFixed(3);
    // ⛔ 잉크 폭이 ~1.00 이면 «잘라선 못 키운다» — 전용 비율 렌더가 없으면 샷으로 되돌아간다(템플릿 갈림 ⑵).
    if (width >= 0.97 && !targets.every((t) => native[name]?.[t.key])) fullbleed_cuts.push(name);
  }
  const produced = { max_zoom, fullbleed_cuts, ink };
  return fullbleed_cuts.length
    ? { outcome: 'fullbleed', produced, note: `잉크 폭 ≈1.00 인 샷: ${fullbleed_cuts.join(', ')} — 그 비율로 다시 렌더해야 한다` }
    : { outcome: 'croppable', produced, note: `샷 ${shots.length}개 잘라서 된다 · 최대 줌 ${Object.entries(max_zoom).map(([k, v]) => `${k} ${v}`).join(' · ')}` };
};

// ── edit · bar-snapped-assemble ───────────────────────────────────────────
/** 편집 엔진은 build.py 와 «같다»(CharacterPipeline 07_edit.py 머리말) ⇒ film 의 마스터·소셜을 그대로 부른다. */
export const barSnappedAssemble: Recipe = async (ctx) => {
  const plan = ctx.state.plan as PlanRow[] | string | undefined;
  if (!plan) return { outcome: 'no-plan', note: '편집 원장(plan)이 없다 — 컷은 났지만 편집이 못 돌았다' };
  if (!ctx.state.audio && !ctx.state.track_path) return { outcome: 'error', note: '음악(audio)이 없다' };
  const sub = { ...ctx.state, track_path: ctx.state.track_path ?? ctx.state.audio };
  const m = await assembleMaster({ ...ctx, state: sub });
  if (m.outcome !== 'ok') return { outcome: 'error', note: `마스터: ${m.note}` };
  Object.assign(sub, m.produced);
  const inkByCut: Record<string, unknown> = {};
  const inkByName = (ctx.state.ink as Record<string, unknown> | undefined) ?? {};
  const src = (ctx.state.shot_sources as Record<string, string> | undefined) ?? {};
  // ⛔ 잉크 자와 «네이티브 소재»는 샷 «파일 이름»으로 키를 쓰고, 편집(reframeSocial)은 «컷 이름»으로 찾는다 — 둘 다 옮겨 준다.
  //   🩸 2026-09-23: 네이티브만 안 옮겨서, 9:16 을 다시 그려 줘도 소셜은 16:9 를 잘라 썼다.
  const nativeByName = (ctx.state.native_sources as Record<string, Record<string, string>> | undefined) ?? {};
  const nativeByCut: Record<string, Record<string, string>> = {};
  for (const [cut, p] of Object.entries(src)) {
    const stem = p.split('/').pop()!.replace(/\.[^.]+$/, '');
    inkByCut[cut] = inkByName[stem];
    const n = nativeByName[stem] ?? nativeByName[cut];
    if (n) nativeByCut[cut] = n;
  }
  const s = await reframeSocial({ ...ctx, state: { ...sub, ink: inkByCut, native_sources: nativeByCut, mixed_path: undefined } });
  if (s.outcome !== 'ok') return { outcome: 'error', note: `소셜: ${s.note}` };
  return { outcome: 'ok', produced: { master: m.produced!.master_path, social_paths: s.produced!.social_paths, duration: m.produced!.expected_seconds }, note: `마스터 ⊕ ${s.note}` };
};

export const CHARACTER: Readonly<Record<string, Recipe>> = {
  'pin-collect': pinCollect,
  'model-sheet': modelSheet,
  'sheet-panels-gate': sheetPanelsGate,
  'single-character-views': singleCharacterViews,
  'identity-register': identityRegister,
  'identity-holds-gate': identityHoldsGate,
  'directed-shots': directedShots,
  'animation-principles-gate': animationPrinciplesGate,
  'ink-ruler': inkRulerAny,
  'bar-snapped-assemble': barSnappedAssemble,
};
