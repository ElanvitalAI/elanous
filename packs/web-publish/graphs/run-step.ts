// web-publish — 그래프 단계 실행기.
// 새로 씀. 단계 구조·원칙 출처: passeth/business-motion-websites (MIT · © 2026 passeth ·
//   https://github.com/passeth/business-motion-websites) · 원작자 허락(2026-10-09).
//
// 계약: `bun run-step.ts <step> [--dry]` · 문맥 = $ELANOUS_GRAPH_CONTEXT(JSON: input·outputs) · 마지막 줄 JSON {outcome}.
// ⛔ 이 파일은 «생성»도 «외부 호출»도 하지 않는다(이미지·영상·음성·네트워크 0). 결정적 일만 한다:
//    입력 검사 · 기획 문서 계약(근거 등급·페이지 지도·DESIGN.md) · 예산 장부 · 미디어 메타 검사(로컬 ffprobe) ·
//    QA 표 계약 · 발행 어댑터(folder 는 로컬 복사, pub·vercel 은 명령 안내만) · 공개 재검증 기록 확인.
//    산출이 아직 없으면 outcome=pending → 그래프가 wait_<stage> 승인에서 멈추고,
//    승인 ⊕ `elanous graph run … --resume <run>` 이면 이 검사로 되돌아온다.
import { appendFileSync, closeSync, cpSync, openSync, readSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {});
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

const GRAPH_DIR = process.env.ELANOUS_GRAPH_DIR ?? import.meta.dir;
const PLUGIN_ROOT = resolve(GRAPH_DIR, '..');
const SKILL = join(PLUGIN_ROOT, 'skills', 'business-motion-websites');
const AUDIT_MEDIA = join(SKILL, 'scripts', 'audit-media.mjs');
const DRY = process.argv.includes('--dry') || process.env.ELANOUS_GRAPH_DRY_RUN === '1';
const STEP = process.argv[2] ?? '';
const MODES = ['build', 'plan-only'] as const;
const TARGETS = ['folder', 'pub', 'vercel'] as const;
// 주장 근거 5등급(원 스킬 business-content.md) — 한국어 원문 ⊕ 영어 별칭
const GRADES: Record<string, string> = {
  '출처 사실': 'source-fact', '사용자 경험': 'user-experience', '제안': 'proposal', '예시': 'example', '미확인': 'unverified',
  'source-fact': 'source-fact', 'user-experience': 'user-experience', proposal: 'proposal', example: 'example', unverified: 'unverified',
};
// 미디어 역할 5종(원 스킬 SKILL.md §5) — 한국어 원문 ⊕ 영어 별칭
const ROLES: Record<string, string> = {
  '브랜드 분위기': 'mood', '실제 사용 근거': 'evidence', '절차 설명': 'process', '데이터 관계': 'data', '미래 가능성': 'future',
  mood: 'mood', evidence: 'evidence', process: 'process', data: 'data', future: 'future',
};
const MEDIA_FILE = /\.(png|jpe?g|gif|webp|avif|svg|ico|mp4|webm|mov|m4v|mp3|m4a|wav|ogg)$/i;
const PROBE_EXT = /\.(png|jpe?g|webp|avif|gif|mp4|webm|mov|m4v)$/i;
const NOT_PROBED_EXT = /\.(svg|ico|mp3|m4a|wav|ogg)$/i;
const PLAYLIST_MARK = /#EXTM3U|#EXT-X-|<MPD[\s>]|ffconcat|\[playlist\]|<smil/i;
function playlistLike(path: string): boolean {
  try {
    const fd = openSync(path, 'r');
    try {
      const head = Buffer.alloc(65536);
      const n = readSync(fd, head, 0, head.length, 0); // 머리 64KB 만 읽는다
      return PLAYLIST_MARK.test(head.subarray(0, n).toString('latin1'));
    } finally { closeSync(fd); }
  } catch { return false; } // 없는 파일은 검사기가 «없음»으로 보고한다
}
const DRY_OWNER_FILE = '.web-publish-dry-owner';
const QA_WIDTHS = ['390', '768', '1280'] as const;
const GRADE_VALUES = ['pass', 'fail', 'unverified'] as const;

// ── 관측 ─────────────────────────────────────────────────────────────
// 팩은 elanous 소스를 import 하지 않는다(설치본에 src/ 가 없다). 같은 모양의 debug.log 를 두고
// stderr(그래프 실행기가 런 원장에 남긴다) ⊕ <workspace>/.web-publish/events.jsonl 두 곳에 남긴다.
let eventsFile: string | undefined;
const debug = {
  log(category: string, event: string, data: Obj = {}): void {
    const row = { ts: new Date().toISOString(), category, event, step: STEP, dry: DRY, ...data };
    const line = JSON.stringify(row);
    process.stderr.write(`[debug] ${line}\n`);
    if (eventsFile && !DRY) { // 드라이런은 사용자 workspace 에 아무것도 쓰지 않는다
      try {
        // .web-publish/·events.jsonl 이 링크면 파일 기록을 건너뛴다(stderr 만) — workspace 밖에 쓰지 않는다.
        const dir = dirname(eventsFile);
        if (lstatKind(dir) === 'none') mkdirSync(dir);
        if (lstatKind(dir) === 'dir' && ['none', 'file'].includes(lstatKind(eventsFile))) appendFileSync(eventsFile, line + '\n');
      } catch { /* 관측 실패가 단계를 깨지 않는다 */ }
    }
  },
};

function emit(out: Obj): never {
  debug.log('plugin.web-publish', STEP || 'unknown', { outcome: out.outcome, ...(out.error ? { error: out.error } : {}), ...(out.waiting_for ? { waiting_for: out.waiting_for } : {}) });
  console.log(JSON.stringify(out));
  process.exit(0);
}
const fail = (error: string, next?: string): never => emit({ outcome: 'fail', error, ...(next ? { next } : {}) });
// 산출이 «아직» 없다 = 실패가 아니라 대기. 그래프가 wait_<stage> 승인 노드로 보낸다.
const pending = (what: string, next: string, extra: Obj = {}): never => emit({ outcome: 'pending', waiting_for: what, next, ...extra });

function readJson(path: string): unknown { return JSON.parse(readFileSync(path, 'utf8')); }
function readJsonl(path: string): Obj[] {
  return readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => obj(JSON.parse(l)));
}
/** 이 경로에 무언가 있으면 «보통 파일»이어야 한다(링크·폴더면 거부) — 쓰기 대상이 workdir 밖으로 새지 않게. */
function lstatKind(path: string): 'none' | 'file' | 'dir' | 'link' | 'other' {
  try { const s = lstatSync(path); return s.isSymbolicLink() ? 'link' : s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other'; }
  catch { return 'none'; }
}
/** 링크를 따라 쓰지 않는다 — 대상이 링크·폴더거나, 조상 폴더(예: release/)가 링크라 실제 위치가 «글자 그대로의» workspace 경로와 다르면 거부. */
function writablePath(ws: string, rel: string): string {
  const path = join(realpathSync(ws), rel);
  mkdirSync(dirname(path), { recursive: true });
  if (insideWorkspace(ws, rel) !== path) fail(`쓰기 경로 ${rel} 의 상위 폴더가 링크다(workspace 밖일 수 있다) — 보통 폴더로 바꾸고 다시`);
  const kind = lstatKind(path);
  if (kind !== 'none' && kind !== 'file') fail(`쓰기 대상이 보통 파일이 아니다(${kind}): ${basename(path)} — 지우고 다시`);
  return path;
}
function safeWrite(ws: string, rel: string, data: string): void {
  writeFileSync(writablePath(ws, rel), data);
}
/** ref/assets/ 의 파일 — ref·ref/assets 가 링크면(workspace 밖일 수 있다) 읽지 않고 멈춘다. */
function refAssetFiles(ws: string): string[] {
  const root = realpathSync(ws);
  for (const rel of ['ref', 'ref/assets']) {
    const kind = lstatKind(join(root, rel));
    if (kind === 'none') return [];
    if (kind !== 'dir') fail(`${rel} 이 보통 폴더가 아니다(${kind}) — 링크를 따라 읽지 않는다`);
  }
  const links = linksUnder(join(root, 'ref', 'assets'));
  if (links.length) fail(`ref/assets/ 안에 링크가 있다(${links.length}) — 원본 파일을 실제 파일로 두어야 해시 대조가 된다`);
  return walk(join(root, 'ref', 'assets'));
}
/** site/ 안 미디어 파일 중 매니페스트(file·poster)에 없는 것. */
function unlistedMedia(ws: string, assets: unknown[]): string[] {
  const listed = new Set(assets.flatMap(raw => { const a = obj(raw); return [str(a.file), str(a.poster)].filter(Boolean).map(f => resolve(ws, f)); }));
  return walk(join(ws, 'site')).filter(f => MEDIA_FILE.test(f) && !listed.has(resolve(f))).map(f => relative(ws, f));
}
/** 감사한 미디어의 지문(매니페스트 바이트 ⊕ 목록에 있는 파일 바이트) — 감사 뒤 미디어가 바뀌었는지 발행 때 대조한다. */
export function mediaDigest(ws: string): string {
  const manifestPath = join(ws, 'media-manifest.json');
  if (!existsSync(manifestPath)) return createHash('sha256').update('no-manifest').digest('hex');
  const assets = obj(readJson(manifestPath)).assets;
  const files = (Array.isArray(assets) ? assets : []).flatMap(raw => { const a = obj(raw); return [str(a.file), str(a.poster)].filter(Boolean); }).sort();
  const rows = files.map(f => { const full = insideWorkspace(ws, f); return [f, full && existsSync(full) && statSync(full).isFile() ? sha256(full) : 'missing']; });
  return createHash('sha256').update(JSON.stringify([sha256(manifestPath), rows])).digest('hex');
}
/** site/ 전체의 내용 지문(경로 ⊕ 바이트) — QA 가 본 판과 발행하는 판이 같은지 묶는다. */
export function siteDigest(site: string): string {
  // 파일마다 (경로, 내용 해시) 쌍을 JSON 으로 직렬화한다 — 이어 붙이기 모호성(경계 위조) 없이.
  const rows = walk(site).sort().map(f => [relative(site, f), sha256(f)]);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
function linksUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    return e.isSymbolicLink() ? [p] : e.isDirectory() ? linksUnder(p) : [];
  });
}
function sha256(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) return [];
    return e.isDirectory() ? walk(p) : e.isFile() ? [p] : [];
  });
}

function context(): { input: Obj; outputs: Obj } {
  const path = process.env.ELANOUS_GRAPH_CONTEXT;
  if (!path) return { input: obj(readJson(join(PLUGIN_ROOT, 'examples', 'input.json'))), outputs: {} }; // 그래프 밖 단독 시험
  const c = obj(readJson(path));
  return { input: obj(c.input), outputs: obj(c.outputs) };
}

function workspace(input: Obj, outputs: Obj): string {
  const ws = str(obj(outputs.brief).workspace) || str(input.workspace);
  if (!ws || !isAbsolute(ws)) fail('input.workspace 에 «절대 경로» 작업 폴더를 주세요');
  eventsFile = join(ws, '.web-publish', 'events.jsonl');
  return ws;
}

/** workdir 가두기(가벼운 판 — 본격 보안 검토는 별도 칸): 상대 경로를 ws 기준으로 풀고, 있으면 realpath 로 링크를 따라가 ws 안인지 본다. */
export function insideWorkspace(ws: string, rel: string): string | undefined {
  if (!rel || isAbsolute(rel) || rel.split(/[\\/]+/).includes('..')) return undefined; // `..` 구성요소는 끝이 안이어도 거부
  const root = existsSync(ws) ? realpathSync(ws) : resolve(ws);
  const full = resolve(root, rel);
  // 경로의 각 구성요소가 링크면 실제로 풀려야 한다 — 끊어진 링크(가리키는 곳 없음)는 «없는 경로»가 아니라 거부.
  for (let at = full; at !== root && at.startsWith(root); at = dirname(at)) {
    if (lstatKind(at) === 'link' && !existsSync(at)) return undefined;
  }
  // 가장 가까운 «있는» 조상을 realpath 로 풀고 나머지를 붙인다 — 없는 파일이라도 밖을 가리키는 링크 폴더 아래면 밖이다.
  let base = full;
  while (!existsSync(base) && dirname(base) !== base) base = dirname(base);
  const real = join(existsSync(base) ? realpathSync(base) : base, relative(base, full));
  const r = relative(root, real);
  return r && !r.startsWith('..') && !isAbsolute(r) ? real : undefined;
}

const brief0 = (outputs: Obj): Obj => obj(outputs.brief);
const modeOf = (input: Obj, outputs: Obj): string => str(brief0(outputs).mode) || str(input.mode) || 'build';
const targetOf = (input: Obj, outputs: Obj): string => str(brief0(outputs).publish_target) || str(input.publish_target) || 'folder';
function budget(input: Obj): { image_generations: number; video_credits: number; voice_chars: number } {
  const b = obj(input.budget);
  return { image_generations: num(b.image_generations, 0), video_credits: num(b.video_credits, 0), voice_chars: num(b.voice_chars, 0) };
}

// ── 단계 ─────────────────────────────────────────────────────────────
function brief(input: Obj): never {
  const business = str(input.business);
  const goal = str(input.goal);
  if (!business) fail('input.business(사업 설명)가 없다');
  if (!goal) fail('input.goal(이 사이트로 얻으려는 것)이 없다');
  const mode = str(input.mode) || 'build';
  if (!MODES.includes(mode as typeof MODES[number])) fail(`input.mode 는 ${MODES.join('|')} 중 하나`);
  const target = str(input.publish_target) || 'folder';
  if (!TARGETS.includes(target as typeof TARGETS[number])) fail(`input.publish_target 는 ${TARGETS.join('|')} 중 하나`);
  const refs = Array.isArray(input.reference_urls) ? input.reference_urls.map(str).filter(Boolean) : [];
  const badRef = refs.find(u => { try { return new URL(u).protocol !== 'https:'; } catch { return true; } });
  if (badRef) fail(`reference_urls 는 https URL 이어야 한다: ${badRef}`);
  const b = budget(input);
  if (Object.values(b).some(v => v < 0)) fail('budget 값은 0 이상');
  const ws = DRY ? mkdtempSync(join(tmpdir(), 'web-publish-dry-')) : workspace(input, {});
  // 드라이런 임시 폴더의 소유 표지 — done/failed 가 «자기가 만든» 폴더만 지우게 한다.
  const dryOwner = DRY ? createHash('sha256').update(`${ws}\0${process.pid}\0${Date.now()}\0${Math.random()}`).digest('hex') : undefined;
  if (dryOwner) writeFileSync(join(ws, DRY_OWNER_FILE), dryOwner);
  eventsFile = join(ws, '.web-publish', 'events.jsonl');
  for (const d of ['strategy', 'site', 'media', 'ledger', 'qa', 'release', 'ref', 'out']) mkdirSync(join(ws, d), { recursive: true });
  safeWrite(ws, 'brief.json', JSON.stringify({ ...input, workspace: ws, mode, publish_target: target, reference_urls: refs, budget: b }, null, 1));
  const briefTemplate = join(ws, 'project-brief.md');
  if (lstatKind(briefTemplate) === 'none') safeWrite(ws, 'project-brief.md', readFileSync(join(SKILL, 'assets', 'project-brief.md'), 'utf8'));
  emit({ outcome: 'ok', workspace: ws, mode, publish_target: target, references: refs.length, budget: b, dry: DRY, ...(dryOwner ? { dry_owner: dryOwner } : {}) });
}

const FORBIDDEN_SEED = /\.(png|jpe?g|gif|webp|avif|svg|mp4|webm|mov|woff2?|ttf|otf)(\?|$)|^data:/i;
function seedViolations(v: unknown, at = 'seed'): string[] {
  if (typeof v === 'string') return FORBIDDEN_SEED.test(v.trim()) ? [at] : [];
  if (Array.isArray(v)) return v.flatMap((x, i) => seedViolations(x, `${at}[${i}]`));
  if (v && typeof v === 'object') return Object.entries(v as Obj).flatMap(([k, x]) => seedViolations(x, `${at}.${k}`));
  return [];
}

function absorb(input: Obj, outputs: Obj): never {
  const ws = workspace(input, outputs);
  const refs = Array.isArray(input.reference_urls) ? input.reference_urls.map(str).filter(Boolean) : [];
  if (refs.length === 0) emit({ outcome: 'skip', references: 0 });
  if (DRY) emit({ outcome: 'ok', dry: true, references: refs.length, would_check: 'ref/seed.json 에 «값»만(파일·data: URI 0) ⊕ ref/assets/ 해시를 ref/assets.sha256 로' });
  const seedPath = join(ws, 'ref', 'seed.json');
  if (!existsSync(seedPath)) pending(`참고 사이트 값 씨앗이 없다: ref/seed.json (${refs.length}곳)`, 'webclone 등으로 «값»(색·활자·간격·배치·모션 수치)만 재서 ref/seed.json 에 쓰고 wait_absorb 승인 — 글·사진·로고·폰트 파일은 가져오지 않는다');
  const bad = seedViolations(readJson(seedPath));
  if (bad.length) fail(`ref/seed.json 에 파일·data URI 참조 ${bad.length}건(값만 남긴다): ${bad.slice(0, 5).join(', ')}`);
  // 측정 중에 내려받은 원 사이트 파일이 있다면(ref/assets/) 해시만 남겨 발행 직전에 섞였는지 대조한다.
  const hashes = refAssetFiles(ws).map(sha256);
  safeWrite(ws, 'ref/assets.sha256', hashes.join('\n') + (hashes.length ? '\n' : ''));
  emit({ outcome: 'ok', references: refs.length, reference_files_hashed: hashes.length });
}

function strategy(input: Obj, outputs: Obj): never {
  const ws = workspace(input, outputs);
  if (DRY) emit({ outcome: 'ok', dry: true, would_check: 'strategy/claims.json(근거 5등급 · 미확인 주장은 public=false) ⊕ strategy/page-map.json(질문→답→근거→관련→다음 행동) ⊕ DESIGN.md' });
  const claimsPath = join(ws, 'strategy', 'claims.json');
  const mapPath = join(ws, 'strategy', 'page-map.json');
  const designPath = join(ws, 'DESIGN.md');
  const missing = [claimsPath, mapPath, designPath].filter(p => !existsSync(p)).map(p => relative(ws, p));
  if (missing.length) pending(`기획 문서 없음: ${missing.join(', ')}`, 'SKILL.md §1~3 · references/business-content.md · art-direction.md — 쓴 뒤 wait_strategy 승인');
  const claimsRaw = readJson(claimsPath);
  const claims: unknown[] = Array.isArray(claimsRaw) && claimsRaw.length ? claimsRaw : fail('strategy/claims.json 은 비어 있지 않은 배열이어야 한다');
  const problems: string[] = [];
  const unverifiedPublic: string[] = [];
  for (const [i, raw] of claims.entries()) {
    const c = obj(raw);
    const grade = GRADES[str(c.grade)];
    if (!str(c.claim)) problems.push(`claims[${i}].claim 없음`);
    if (!grade) problems.push(`claims[${i}].grade 는 출처 사실|사용자 경험|제안|예시|미확인 중 하나`);
    if (grade === 'source-fact' && !str(c.source)) problems.push(`claims[${i}]: 출처 사실인데 source 가 없다`);
    if (typeof c.public !== 'boolean') problems.push(`claims[${i}].public 는 true|false(공개 문구에 쓰나)`);
    // 미확인 주장은 «명시적으로» 비공개여야 한다 — 빠졌거나 불명이면 넘기지 않는다.
    else if (grade === 'unverified' && c.public !== false) unverifiedPublic.push(str(c.claim).slice(0, 40));
  }
  const pagesRaw = readJson(mapPath);
  const pages: unknown[] = Array.isArray(pagesRaw) && pagesRaw.length ? pagesRaw : fail('strategy/page-map.json 은 비어 있지 않은 배열이어야 한다');
  for (const [i, raw] of pages.entries()) {
    const p = obj(raw);
    // 방문자 질문 → 핵심 답변 → 근거/시각 설명 → 관련 페이지 → 다음 행동(원 스킬 SKILL.md §2)
    for (const k of ['page', 'question', 'answer', 'evidence', 'next_action']) if (!str(p[k])) problems.push(`page-map[${i}].${k} 없음`);
    if (!Array.isArray(p.related) || !p.related.every(r => typeof r === 'string')) problems.push(`page-map[${i}].related 는 관련 페이지 이름 배열(없으면 [])`);
  }
  if (!readFileSync(designPath, 'utf8').trim()) problems.push('DESIGN.md 가 비었다');
  if (problems.length) fail(`기획 계약 위반 ${problems.length}건: ${problems.slice(0, 6).join(' · ')}`);
  if (unverifiedPublic.length) fail(`미확인 주장이 공개 문구로 표시됐다(${unverifiedPublic.length}건): ${unverifiedPublic.slice(0, 3).join(' / ')}`, '근거를 확보하거나 public=false 로 내리고 다시');
  emit({ outcome: 'ok', claims: claims.length, pages: pages.length });
}

function heroSlice(input: Obj, outputs: Obj): never {
  if (modeOf(input, outputs) === 'plan-only') emit({ outcome: 'plan_only', note: '기획만 요청됨 — 구현·유료 생성·발행으로 넘어가지 않는다(SKILL.md «시작 범위»)' });
  const ws = workspace(input, outputs);
  if (DRY) emit({ outcome: 'ok', dry: true, would_check: 'site/index.html ⊕ site/tokens.css(머리에 DESIGN.md 출처 표기)' });
  const index = join(ws, 'site', 'index.html');
  const tokens = join(ws, 'site', 'tokens.css');
  const missing = [index, tokens].filter(p => !existsSync(p)).map(p => relative(ws, p));
  if (missing.length) pending(`대표 구간 없음: ${missing.join(', ')}`, 'SKILL.md §4 — 홈 대표 구간 ⊕ 가장 정보가 많은 상세 구간을 실제 화면으로 · wait_build 승인');
  if (!readFileSync(tokens, 'utf8').includes('DESIGN.md')) fail('site/tokens.css 가 DESIGN.md 에서 왔다는 표기가 없다(머리 주석에 «DESIGN.md» 를 적는다)');
  emit({ outcome: 'ok', index: relative(ws, index) });
}

function media(input: Obj, outputs: Obj): never {
  const ws = workspace(input, outputs);
  const b = budget(input);
  if (DRY) emit({ outcome: 'ok', dry: true, budget: b, would_check: 'media-manifest.json(자산마다 role·rights) ⊕ ledger/media_spend.jsonl 합 ≤ budget' });
  const manifestPath = join(ws, 'media-manifest.json');
  if (!existsSync(manifestPath)) pending('media-manifest.json 없음', 'SKILL.md §5 · references/media-production.md — 자산 역할을 정하고 만든 뒤 목록을 쓰고 wait_media 승인(미디어 없는 사이트면 {"assets":[]})');
  const assetsRaw = obj(readJson(manifestPath)).assets;
  const assets: unknown[] = Array.isArray(assetsRaw) ? assetsRaw : fail('media-manifest.json 에 assets 배열이 없다');
  const problems: string[] = [];
  for (const [i, raw] of assets.entries()) {
    const a = obj(raw);
    const id = str(a.id) || `#${i}`;
    if (!ROLES[str(a.role)]) problems.push(`${id}: role 은 브랜드 분위기|실제 사용 근거|절차 설명|데이터 관계|미래 가능성 중 하나`);
    if (!str(a.rights)) problems.push(`${id}: rights(공급·권리 근거)가 비었다`);
  }
  if (problems.length) fail(`미디어 목록 계약 위반 ${problems.length}건: ${problems.slice(0, 6).join(' · ')}`);
  // site/ 안의 미디어 파일은 모두 목록에 있어야 한다(역할·권리 근거·메타 검사를 비켜 가지 않게).
  const unlisted = unlistedMedia(ws, assets);
  if (unlisted.length) pending(`목록에 없는 미디어 ${unlisted.length}개: ${unlisted.slice(0, 6).join(', ')}`, 'media-manifest.json 에 역할·권리 근거와 함께 올리고(경로는 workspace 기준, 예: site/media/a.jpg) wait_media 승인');
  const ledger = join(ws, 'ledger', 'media_spend.jsonl');
  const rows = existsSync(ledger) ? readJsonl(ledger) : [];
  const spent = { image_generations: 0, video_credits: 0, voice_chars: 0 } as Record<keyof typeof b, number>;
  for (const r of rows) {
    const k = str(r.kind) === 'image' ? 'image_generations' : str(r.kind) === 'video' ? 'video_credits' : str(r.kind) === 'voice' ? 'voice_chars' : undefined;
    if (!k) { problems.push(`장부 kind 는 image|video|voice: ${JSON.stringify(r).slice(0, 60)}`); continue; }
    if (typeof r.units !== 'number' || !Number.isFinite(r.units) || r.units < 0) { problems.push(`장부 units 는 0 이상의 수: ${JSON.stringify(r).slice(0, 60)}`); continue; }
    spent[k] += r.units;
  }
  if (problems.length) fail(problems.slice(0, 3).join(' · '));
  const over = (Object.keys(b) as Array<keyof typeof b>).filter(k => spent[k] > b[k]);
  if (over.length) fail(`예산 초과: ${over.map(k => `${k} ${spent[k]} > ${b[k]}`).join(', ')} — 사람 확인 전 추가 생성 금지`);
  emit({ outcome: 'ok', assets: assets.length, spent, budget: b });
}

function auditMedia(input: Obj, outputs: Obj): never {
  const ws = workspace(input, outputs);
  if (DRY) emit({ outcome: 'ok', dry: true, would_run: 'node skills/business-motion-websites/scripts/audit-media.mjs <ws>/media-manifest.json --out <ws>/media-audit.json (workdir 안 경로만 · --ffprobe 안 씀)' });
  const manifestPath: string = insideWorkspace(ws, 'media-manifest.json') ?? fail('media-manifest.json 이 workdir 밖을 가리킨다');
  if (!existsSync(manifestPath)) fail('media-manifest.json 이 workdir 안에 없다');
  const assets = obj(readJson(manifestPath)).assets;
  if (!Array.isArray(assets) || assets.length === 0) emit({ outcome: 'skip', assets: 0, media_digest: mediaDigest(ws), note: '미디어 없는 사이트 — 메타 검사 건너뜀' });
  // workdir 가두기: 매니페스트의 file·poster 가 ws 밖(../ · 절대 경로 · 밖을 가리키는 링크)이면 검사기를 부르지 않는다.
  const outside = assets.flatMap(raw => { const a = obj(raw); return [str(a.file), ...(a.poster === undefined ? [] : [str(a.poster)])]; })
    .filter(f => !insideWorkspace(ws, f));
  if (outside.length) fail(`매니페스트 경로가 workdir 밖이다(${outside.length}건): ${outside.slice(0, 4).join(', ')}`);
  // 네트워크 0 가두기: ffprobe 는 내용으로 형식을 고르므로, 재생목록·매니페스트형 파일(HLS·DASH·concat 등)이 원격 URL 을
  // 참조하면 요청을 낼 수 있다. 정해진 이미지·영상 확장자만 ⊕ 머리 64KB 에 재생목록 표지가 없을 때만 검사기에 넘긴다.
  // SVG 는 목록·역할·권리는 보되 ffprobe 로 재지 않는다(not_probed).
  // 검사기는 image|video 만 잰다. SVG·음성(mp3·m4a·wav·ogg)은 목록·역할·권리만 보고 재지 않는다(not_probed).
  // 재지 않는 자산(SVG·음성)도 포함해 모든 file·poster 가 workspace 안의 «실제 보통 파일»이어야 한다.
  const missing = assets.flatMap(raw => { const a = obj(raw); return [str(a.file), ...(a.poster === undefined ? [] : [str(a.poster)])]; })
    .filter(f => { const full = insideWorkspace(ws, f); return !full || lstatKind(full) !== 'file'; });
  if (missing.length) emit({ outcome: 'fix', problems: missing.slice(0, 8).map(f => `${f}: 파일이 없다(또는 보통 파일이 아니다)`), next: '파일을 두거나 목록을 고치고 wait_media 승인' });
  // 선언한 종류와 파일 형식이 어긋나면(예: kind=video 인데 .mp3) 고치게 돌려보낸다.
  const mismatched = assets.filter(raw => { const a = obj(raw); const f = str(a.file);
    return (str(a.kind) === 'video' && !/\.(mp4|webm|mov|m4v)$/i.test(f)) || (str(a.kind) === 'image' && !/\.(png|jpe?g|webp|avif|gif|svg|ico)$/i.test(f))
      || (str(a.kind) === 'audio' && !/\.(mp3|m4a|wav|ogg)$/i.test(f)) || !['image', 'video', 'audio'].includes(str(a.kind)); }).map(raw => str(obj(raw).id));
  if (mismatched.length) emit({ outcome: 'fix', problems: mismatched.map(id => `${id}: kind 와 파일 형식이 맞지 않는다(image·video·audio)`), next: '목록의 kind 를 고치고 wait_media 승인' });
  const probeAssets = assets.filter(raw => !NOT_PROBED_EXT.test(str(obj(raw).file)));
  const notProbed = assets.filter(raw => NOT_PROBED_EXT.test(str(obj(raw).file))).map(raw => str(obj(raw).id));
  const unsafe = probeAssets.flatMap(raw => { const a = obj(raw); return [str(a.file), ...(a.poster === undefined ? [] : [str(a.poster)])]; })
    .filter(f => !PROBE_EXT.test(f) || playlistLike(insideWorkspace(ws, f)!));
  if (unsafe.length) fail(`ffprobe 에 넘기지 않는 파일(확장자 밖이거나 재생목록형 · 네트워크 참조 가능)(${unsafe.length}): ${unsafe.slice(0, 4).join(', ')}`);
  if (probeAssets.length === 0) emit({ outcome: 'skip', assets: assets.length, not_probed: notProbed, media_digest: mediaDigest(ws), note: 'ffprobe 로 잴 자산이 없다(SVG·음성만)' });
  let probeManifest = manifestPath;
  if (notProbed.length) {
    probeManifest = writablePath(ws, 'media-manifest.audit.json');
    writeFileSync(probeManifest, JSON.stringify({ ...obj(readJson(manifestPath)), assets: probeAssets }, null, 1));
  }
  const out = join(realpathSync(ws), 'media-audit.json');
  const outKind = lstatKind(out);
  if (outKind !== 'none' && outKind !== 'file') fail(`media-audit.json 이 보통 파일이 아니다(${outKind}) — 지우고 다시`);
  if (outKind === 'file') rmSync(out);
  const p = spawnSync('node', [AUDIT_MEDIA, probeManifest, '--out', out], { encoding: 'utf8', timeout: 110_000, cwd: ws });
  if (p.error) fail(`audit-media 실행 실패: ${p.error.message}`);
  if (p.status === 2) fail(`audit-media 입력/도구 오류: ${p.stderr.trim().slice(0, 200)}`);
  const report = existsSync(out) ? obj(readJson(out)) : {};
  const bad = (Array.isArray(report.assets) ? report.assets : []).map(obj).filter(a => Array.isArray(a.issues) && a.issues.length);
  if (p.status === 1) emit({ outcome: 'fix', report: 'media-audit.json', problems: bad.map(a => `${str(a.id)}: ${(a.issues as unknown[]).map(String).join('; ')}`).slice(0, 8), next: '미디어를 고치고 wait_media 승인' });
  if (p.status !== 0) fail(`audit-media 비정상 종료 코드 ${p.status}`);
  emit({ outcome: 'ok', report: 'media-audit.json', assets: assets.length, not_probed: notProbed, media_digest: mediaDigest(ws), limits: str(report.limits) });
}

// 원 스킬 §6 «스크롤과 행동에 의미» — 모션 다섯 종류(references/scroll-and-mobile.md 표)를 구분해 계획했나.
const MOTION_KINDS: Record<string, string> = {
  '분위기 영상 루프': 'loop', '프레임 스크러빙': 'scrub', '구간 진입 등장': 'enter', '설명용 연결선': 'connector', 'UI 피드백': 'feedback',
  loop: 'loop', scrub: 'scrub', enter: 'enter', connector: 'connector', feedback: 'feedback',
};
function motion(input: Obj, outputs: Obj): never {
  const ws = workspace(input, outputs);
  if (DRY) emit({ outcome: 'ok', dry: true, would_check: 'motion/motion-plan.json — 항목마다 element · kind(5종) · reduced_motion(모션 감소 때) · mobile(휴대폰에서) · 모션 없는 사이트면 []' });
  const planPath = join(ws, 'motion', 'motion-plan.json');
  if (!existsSync(planPath)) pending('모션 계획 없음: motion/motion-plan.json', 'SKILL.md §6 · references/scroll-and-mobile.md — 모션을 종류별로 나눠 구현하고 모션 감소·휴대폰 동작을 적은 뒤 wait_motion 승인(모션 없는 사이트면 [])');
  const raw = readJson(planPath);
  const rows: unknown[] = Array.isArray(raw) ? raw : fail('motion/motion-plan.json 은 배열이어야 한다');
  const problems: string[] = [];
  for (const [i, r] of rows.entries()) {
    const m = obj(r);
    if (!str(m.element)) problems.push(`motion[${i}].element 없음`);
    if (!MOTION_KINDS[str(m.kind)]) problems.push(`motion[${i}].kind 는 분위기 영상 루프|프레임 스크러빙|구간 진입 등장|설명용 연결선|UI 피드백 중 하나`);
    if (!str(m.reduced_motion)) problems.push(`motion[${i}].reduced_motion(모션 감소 때 본문·CTA 가 어떻게 보이나) 없음`);
    if (!str(m.mobile)) problems.push(`motion[${i}].mobile(휴대폰에서의 순서·조작) 없음`);
  }
  if (problems.length) fail(`모션 계획 계약 위반 ${problems.length}건: ${problems.slice(0, 6).join(' · ')}`);
  emit({ outcome: 'ok', motions: rows.length, kinds: [...new Set(rows.map(r => MOTION_KINDS[str(obj(r).kind)]))] });
}

function webcloneRuler(input: Obj): string | undefined {
  const root = str(input.webclone_root);
  if (!root || !isAbsolute(root)) return undefined;
  const script = join(root, 'scripts', 'webclone', 'check-layout.ts');
  return existsSync(script) ? script : undefined;
}

function qa(input: Obj, outputs: Obj): never {
  const ruler = webcloneRuler(input);
  if (DRY) emit({ outcome: 'ok', dry: true, webclone: ruler ? 'present' : 'absent', qa_status: ruler ? 'would-check' : 'pending',
    would_check: 'qa/qa-report.json — ruler(webclone|manual) · widths 390·768·1280 · reduced_motion_content_visible · evidence{emulator,webkit,real_device}(안 잰 칸 = unverified)' });
  const ws = workspace(input, outputs);
  const reportPath = join(ws, 'qa', 'qa-report.json');
  if (!existsSync(reportPath)) {
    if (!ruler) pending('QA 표 없음 ⊕ webclone 자 없음(input.webclone_root 미지정 또는 scripts/webclone 부재)', '수동으로 재서 qa/qa-report.json 을 쓰거나(ruler=manual) webclone_root 를 주고 다시 — 그 뒤 wait_qa 승인', { webclone: 'absent' });
    pending('QA 표 없음: qa/qa-report.json', `webclone 자(scripts/webclone/check-layout.ts)로 390·768·1280 · 모션 감소를 재서 qa/qa-report.json 에 · wait_qa 승인`, { webclone: 'present' });
  }
  const r = obj(readJson(reportPath));
  const problems: string[] = [];
  const widths = obj(r.widths);
  for (const w of QA_WIDTHS) if (!['pass', 'fail'].includes(str(widths[w]))) problems.push(`widths.${w} 는 pass|fail`);
  if (typeof r.reduced_motion_content_visible !== 'boolean') problems.push('reduced_motion_content_visible 는 true|false');
  if (!['webclone', 'manual'].includes(str(r.ruler))) problems.push('ruler 는 webclone|manual(무엇으로 쟀는지 표에 적는다)');
  if (str(r.ruler) === 'webclone' && !ruler) problems.push('ruler=webclone 인데 webclone 자를 찾을 수 없다(input.webclone_root) — 수동이면 manual 로 적는다');
  const ev = obj(r.evidence);
  for (const k of ['emulator', 'webkit', 'real_device']) if (!GRADE_VALUES.includes(str(ev[k]) as typeof GRADE_VALUES[number])) problems.push(`evidence.${k} 는 pass|fail|unverified(안 쟀으면 unverified 라고 적는다)`);
  if (problems.length) fail(`QA 표 계약 위반 ${problems.length}건: ${problems.join(' · ')}`);
  const failing = [...QA_WIDTHS.filter(w => widths[w] === 'fail').map(w => `width ${w}`),
    ...(r.reduced_motion_content_visible === false ? ['reduced-motion 에서 본문·CTA 안 보임'] : []),
    ...['emulator', 'webkit', 'real_device'].filter(k => ev[k] === 'fail').map(k => `evidence ${k}`)];
  if (failing.length) emit({ outcome: 'fix', failing, next: '사이트를 고치고 wait_build 승인 → 대표 구간부터 다시' });
  if (ev.emulator !== 'pass' && ev.webkit !== 'pass' && ev.real_device !== 'pass') fail('잰 증거가 하나도 없다(전부 unverified) — 적어도 하나는 재야 한다');
  const site = join(ws, 'site');
  emit({ outcome: 'ok', ruler: str(r.ruler), webclone_available: Boolean(ruler), site_digest: lstatKind(site) === 'dir' ? siteDigest(site) : null,
    measurement: 'reported-by-table', note: '이 단계는 QA 표의 계약만 본다 — 자로 다시 재지 않았다(독립 측정 아님)', evidence: ev, unverified: Object.keys(ev).filter(k => ev[k] === 'unverified') });
}

/** 공개 사이트 URL 로 받을 수 있나 — https 이고 호스트가 있어야 한다(file:, http:, 빈 값, 임의 문자열 거부). */
export function isPublicHttpsUrl(value: string): boolean {
  let u: URL;
  try { u = new URL(value); } catch { return false; }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, ''); // 끝의 점(FQDN 표기)을 걷고 본다
  if (!host || !host.includes('.')) return false; // 점 없는 단일 이름(내부 호스트)은 공개 주소가 아니다
  // IP 리터럴(IPv4·IPv6, 매핑 주소 포함)은 공개 사이트 주소로 받지 않는다 — 도메인 이름이어야 한다.
  if (host.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  // 명백한 로컬·사설 주소는 «공개» 가 아니다.
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa|test|example|invalid)$/.test(host)) return false;
  if (/(^|\.)example\.(com|net|org)$/.test(host)) return false; // 문서용 예약 도메인
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return false;
  if (host === '::1' || host === '::' || /^(fc|fd|fe80)[0-9a-f]*:/.test(host)) return false;
  return true;
}

/** 발행 어댑터 명령(실행하지 않는다 — 사람이 친다). */
export function adapterCommand(target: string, siteDir: string): string[] {
  if (target === 'pub') return ['pub', 'add', siteDir, '--copy'];
  if (target === 'vercel') return ['vercel', 'deploy', siteDir, '--prod'];
  return [];
}

function publish(input: Obj, outputs: Obj): never {
  const target = targetOf(input, outputs);
  if (DRY) emit({ outcome: 'ok', dry: true, target, would_run: target === 'folder' ? 'site/ → out/site/ 로컬 복사 ⊕ 참고 사이트 원본 파일 해시 대조' : `${adapterCommand(target, '<ws>/site').join(' ')} — 안내만(사람이 실행)` });
  if (obj(outputs.approve_release).outcome !== 'approved') fail('발행 승인(approve_release) 기록이 없다');
  const ws = workspace(input, outputs);
  const site = join(realpathSync(ws), 'site');
  if (lstatKind(site) !== 'dir') fail('site/ 가 보통 폴더가 아니다(링크·파일·없음) — 링크를 따라 발행하지 않는다');
  const links = linksUnder(site);
  if (links.length) fail(`site/ 안에 링크가 있다(${links.length}): ${links.slice(0, 4).map(l => relative(ws, l)).join(', ')} — 실제 파일로 바꾸고 다시`);
  const files = walk(site);
  if (!existsSync(join(site, 'index.html'))) fail('site/index.html 이 없다');
  // 권리 관문: 참고 사이트에서 내려받은 원본 파일(해시)이 산출물에 섞였으면 fail(값만 가져온다).
  // absorb 때 남긴 해시 ⊕ 지금 ref/assets/ 에 있는 파일의 해시(그 뒤에 더해진 것도 본다). ref/ 밖으로 옮긴 원본까지는 못 본다.
  const refHashes = new Set([
    ...(existsSync(join(ws, 'ref', 'assets.sha256')) ? readFileSync(join(ws, 'ref', 'assets.sha256'), 'utf8').split('\n').filter(Boolean) : []),
    ...refAssetFiles(ws).map(sha256),
  ]);
  const mixed = refHashes.size ? files.filter(f => refHashes.has(sha256(f))).map(f => relative(ws, f)) : [];
  if (mixed.length) fail(`참고 사이트 원본 파일이 산출물에 섞였다(${mixed.length}): ${mixed.slice(0, 5).join(', ')}`);
  // 발행 직전 미디어 재대조: site/ 미디어가 모두 목록에 있고, 목록·파일이 감사(audit_media) 때와 같아야 한다.
  const manifestNow = existsSync(join(ws, 'media-manifest.json')) ? obj(readJson(join(ws, 'media-manifest.json'))).assets : [];
  const lateUnlisted = unlistedMedia(ws, Array.isArray(manifestNow) ? manifestNow : []);
  if (lateUnlisted.length) fail(`목록에 없는 미디어가 발행 대상에 있다(${lateUnlisted.length}): ${lateUnlisted.slice(0, 5).join(', ')}`, 'approve_release 반려 → 목록·감사부터 다시');
  const audited = str(obj(outputs.audit_media).media_digest);
  if (!audited || audited !== mediaDigest(ws)) fail('미디어 목록·파일이 감사(audit_media) 뒤 바뀌었다(또는 감사 지문이 없다) — 다시 감사하라', 'approve_release 반려 → media 부터');
  // 승인한 판 = QA 가 본 판. 그 뒤 site/ 가 바뀌었으면(미디어 추가 포함) 발행하지 않는다 — 런 원장의 qa 산출과 대조.
  const reviewed = str(obj(outputs.qa).site_digest);
  if (!reviewed || reviewed !== siteDigest(site)) fail('site/ 가 QA·발행 승인 뒤 바뀌었다(또는 QA 지문이 없다) — 고친 판으로 다시 걸어라', 'approve_release 반려 → hero_slice 부터');
  if (target === 'folder') {
    // 발행 대상은 «글자 그대로» <ws>/out/site 다. out·out/site 가 링크면(안을 가리키든 밖을 가리키든) 거부한다 —
    // 링크를 따라가 지우면 원본 site/·기획 문서나 workdir 밖을 지울 수 있다.
    const realWs = realpathSync(ws);
    const outDir = join(realWs, 'out');
    const outKind = lstatKind(outDir);
    if (outKind !== 'none' && outKind !== 'dir') fail(`out/ 이 보통 폴더가 아니다(${outKind}) — 지우고 다시`);
    mkdirSync(outDir, { recursive: true });
    const dest = join(outDir, 'site');
    writablePath(ws, 'release/publish-record.json'); // 기록 자리를 먼저 확인 — 복사만 되고 기록이 실패하는 판을 만들지 않는다
    const destKind = lstatKind(dest);
    if (destKind !== 'none' && destKind !== 'dir') fail(`out/site 가 보통 폴더가 아니다(${destKind}) — 지우고 다시`);
    if (destKind === 'dir') rmSync(dest, { recursive: true, force: true }); // 재발행: 지난 판의 남은 파일을 두지 않는다
    cpSync(site, dest, { recursive: true });
    if (lstatKind(dest) !== 'dir' || linksUnder(dest).length) fail('복사 결과 out/site 가 보통 폴더가 아니다');
    mkdirSync(join(ws, 'release'), { recursive: true });
    safeWrite(ws, 'release/publish-record.json', JSON.stringify({ target, location: dest, files: files.length, at: new Date().toISOString() }, null, 1));
    emit({ outcome: 'ok', target, location: dest, files: files.length });
  }
  const vercelApproval = join(ws, 'release', 'vercel-approval.json');
  const approvalRec = target === 'vercel' && existsSync(vercelApproval) ? obj(readJson(vercelApproval)) : {};
  // vercel 승인 기록도 «이번» 발행 승인(approve_release) 뒤의 것이어야 한다 — 지난 판 승인 재사용 금지.
  const releaseApprovedAt = Date.parse(str(obj(outputs.approve_release).decidedAt));
  const vercelApprovedAt = Date.parse(str(approvalRec.approved_at));
  const vercelFileAt = target === 'vercel' && existsSync(vercelApproval) ? statSync(vercelApproval).mtimeMs : NaN;
  if (target === 'vercel' && (!str(approvalRec.approved_by) || !Number.isFinite(vercelApprovedAt) || !Number.isFinite(releaseApprovedAt)
    || vercelApprovedAt <= releaseApprovedAt || vercelApprovedAt > Date.now() || !(vercelFileAt > releaseApprovedAt))) {
    fail('vercel 발행은 이번 발행 승인 뒤의 명시 승인 기록이 필요하다: release/vercel-approval.json({approved_by, approved_at:<ISO 시각>})', '기본은 folder — 외부 호스팅이 꼭 필요할 때만 승인 기록을 남기고 다시');
  }
  const record = join(ws, 'release', 'publish-record.json');
  const rec = existsSync(record) ? obj(readJson(record)) : {};
  // 이번 런의 기록이어야 한다 — 이번 발행 승인(approve_release.decidedAt) 뒤에 쓰인 기록만 받는다(지난 판 기록 재사용 금지).
  const approvedAt = Date.parse(str(obj(outputs.approve_release).decidedAt));
  // at 은 필수·유효 시각이어야 하고, at 과 파일 mtime 둘 다 승인 뒤여야 한다.
  const recordAt = existsSync(record) ? Math.min(statSync(record).mtimeMs, Date.parse(str(rec.at))) : NaN;
  const thisRun = Number.isFinite(approvedAt) && Number.isFinite(recordAt) && recordAt > approvedAt && recordAt <= Date.now(); // 미래 시각 기록은 인정 안 함
  if (str(rec.target) !== target || !isPublicHttpsUrl(str(rec.url)) || !thisRun) {
    pending(`${target} 이번 발행 기록 없음: release/publish-record.json({target:"${target}", url:<https 공개 URL>, at:<ISO 시각>}) — 이번 승인 뒤에 쓴 것만 인정`, '아래 명령을 사람이 직접 실행하고 기록을 남긴 뒤 wait_publish 승인', { would_run: adapterCommand(target, site) });
  }
  emit({ outcome: 'ok', target, url: str(rec.url) });
}

function verifyPublic(input: Obj, outputs: Obj): never {
  const target = targetOf(input, outputs);
  if (DRY) emit({ outcome: 'ok', dry: true, target, would_check: target === 'folder' ? 'out/site/index.html 존재' : 'release/verify-public.json(공개 URL 200 ⊕ qa 재실행) — 없으면 unobserved' });
  const ws = workspace(input, outputs);
  if (target === 'folder') {
    const realWs = realpathSync(ws);
    if (lstatKind(join(realWs, 'out')) !== 'dir' || lstatKind(join(realWs, 'out', 'site')) !== 'dir') fail('발행 폴더 out/·out/site 가 보통 폴더가 아니다(링크 거부)');
    if (linksUnder(join(realWs, 'out', 'site')).length) fail('발행 폴더 out/site 안에 링크가 있다');
    const index = join(ws, 'out', 'site', 'index.html');
    if (!existsSync(index) || !statSync(index).isFile()) fail('발행 폴더에 index.html 이 없다');
    // 복사본 = QA 가 본 판인지 지문으로 대조한다.
    const reviewed = str(obj(outputs.qa).site_digest);
    if (!reviewed || siteDigest(join(ws, 'out', 'site')) !== reviewed) fail('발행 폴더 out/site 가 QA 가 본 site/ 와 다르다 — 다시 발행하라');
    emit({ outcome: 'ok', target, location: join(ws, 'out', 'site'), public_url: null, note: '로컬 폴더 발행 — 공개 URL 없음' });
  }
  const publishedUrl = str(obj(outputs.publish).url);
  const v = join(ws, 'release', 'verify-public.json');
  const rec = existsSync(v) ? obj(readJson(v)) : {};
  // 그 발행 URL 의 기록이어야 한다 — 다른 URL·빈 URL 의 200 은 재검증이 아니다.
  const matches = isPublicHttpsUrl(publishedUrl) && str(rec.url) === publishedUrl;
  // 이번 발행의 기록이어야 한다 — 재검증 시각(checked_at)이 이번 발행 기록(publish-record.json)보다 뒤여야 한다.
  const recordPath = join(ws, 'release', 'publish-record.json');
  // 발행 기록의 at 은 유효한 시각이어야 한다(없거나 잘못되면 재검증을 인정하지 않는다).
  const recordAtRaw = existsSync(recordPath) ? Date.parse(str(obj(readJson(recordPath)).at)) : NaN;
  const publishedAt = Number.isFinite(recordAtRaw) ? Math.max(statSync(recordPath).mtimeMs, recordAtRaw) : Infinity;
  const checkedAt = Date.parse(str(rec.checked_at));
  // 이번 발행 «뒤»(같은 시각은 아니다)이고 «지금 이전»(미래 시각은 아직 일어나지 않은 관찰)이어야 한다.
  const fresh = Number.isFinite(checkedAt) && checkedAt > publishedAt && checkedAt <= Date.now();
  if (!matches || !fresh || num(rec.status, 0) !== 200 || rec.qa_rerun !== true) {
    emit({ outcome: 'unobserved', target, url: publishedUrl || null, record_url_matches: matches, record_after_publish: fresh,
      waiting_for: `이번 발행 뒤의 공개 URL 재검증 기록 release/verify-public.json({url:"${publishedUrl}", status:200, qa_rerun:true, checked_at:<ISO 시각>})` });
  }
  emit({ outcome: 'ok', target, url: publishedUrl });
}

function unobserved(_input: Obj, outputs: Obj): never {
  emit({ outcome: 'ok', verdict: 'unobserved', url: obj(outputs.verify_public).url ?? null, note: '발행은 됐지만 공개 URL 을 다시 재지 못했다 — 완료로 보고하지 않는다' });
}

/** 드라이런이 만든 임시 작업 폴더만 지운다(그 이름·위치일 때만). */
function cleanupDryWorkspace(outputs: Obj): void {
  const ws = str(obj(outputs.brief).workspace);
  if (!DRY || !ws || !/^web-publish-dry-[A-Za-z0-9]+$/.test(basename(ws))) return;
  if (dirname(ws) !== tmpdir() && dirname(ws) !== realpathOr(tmpdir())) return;
  // 이 런의 brief 가 만든 폴더인지 표지로 확인한다 — 표지가 없거나 다르면 지우지 않는다.
  const marker = join(ws, DRY_OWNER_FILE);
  const token = str(obj(outputs.brief).dry_owner);
  if (!token || lstatKind(marker) !== 'file' || readFileSync(marker, 'utf8') !== token) return;
  eventsFile = undefined;
  try { rmSync(ws, { recursive: true, force: true }); } catch { /* 남아도 다음 단계에 영향 없다 */ }
}
function realpathOr(p: string): string { try { return realpathSync(p); } catch { return p; } }

function done(input: Obj, outputs: Obj): never {
  cleanupDryWorkspace(outputs);
  // verified·published-local 은 verify_public 이 ok 를 낸 런에서만 — 그 밖에는 unobserved/incomplete.
  const verifyOk = obj(outputs.verify_public).outcome === 'ok';
  const verdict = obj(outputs.hero_slice).outcome === 'plan_only' ? 'plan_only'
    : DRY || obj(outputs.brief).dry === true ? 'dry-run'
    : str(obj(outputs.unobserved).verdict) === 'unobserved' ? 'unobserved'
    : !verifyOk ? 'incomplete'
    : targetOf(input, outputs) === 'folder' ? 'published-local' : 'verified';
  const target = targetOf(input, outputs);
  emit({ outcome: 'ok', verdict, ...(verdict === 'verified' ? { public_check: 'record-based', note: '공개 재검증은 사람이 남긴 기록(release/verify-public.json)에 근거한다 — 이 단계가 URL 을 직접 열지 않았다' } : {}),
    mode: modeOf(input, outputs), target, workspace: brief0(outputs).workspace ?? null,
    location: obj(outputs.publish).location ?? obj(outputs.publish).url ?? null });
}

function failed(_input: Obj, outputs: Obj): never {
  cleanupDryWorkspace(outputs);
  const prev = Object.entries(outputs).map(([k, v]) => [k, obj(v)] as const).reverse().find(([, v]) => v.outcome === 'fail' || v.outcome === 'rejected');
  emit({ outcome: 'fail', at: prev?.[0] ?? null, error: str(prev?.[1].error) || '제작 중단', next: str(prev?.[1].next) || null });
}

if (import.meta.main) {
  try {
    const { input, outputs } = context();
    const table: Record<string, (i: Obj, o: Obj) => never> = {
      brief: i => brief(i), absorb, strategy, 'hero-slice': heroSlice, media, 'audit-media': auditMedia, motion, qa, publish,
      'verify-public': verifyPublic, unobserved, done, failed,
    };
    const fn = table[STEP];
    if (!fn) fail(`알 수 없는 단계: ${STEP || '(없음)'}`);
    fn!(input, outputs);
  } catch (error) {
    fail((error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ').slice(0, 300));
  }
}
