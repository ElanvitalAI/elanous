// image-first-shorts — 그래프 단계 실행기.
// 새로 씀. 단계 구조·원칙 출처: 공냥이 AI 실험실 «악역영애 말포이» AI 영상 제작 키트(https://malfoy-meme-making.vercel.app/)
//   · 원작자 허락(2026-10-08) · 출처 명기 조건.
//
// 계약: `bun run-step.ts <step> [--dry]` · 문맥 = $ELANOUS_GRAPH_CONTEXT(JSON: input·outputs) · 마지막 줄 JSON {outcome}.
// ⛔ 이 파일은 «생성»을 하지 않는다(이미지·영상·음성 0 호출). 결정적 일만 한다:
//    입력 검사 · 프롬프트 조립(템플릿) · IP 0건 검사 · 크레딧 예산 · 산출물 존재/계약 확인.
//    생성은 스킬(SKILL.md)이 에이전트에게 시킨다. 산출이 아직 없으면 outcome=pending → 그래프가 wait_<stage> 승인에서 멈추고,
//    승인 ⊕ `elanous graph run … --resume <run>` 이면 이 검사로 되돌아온다.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {});
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

const GRAPH_DIR = process.env.ELANOUS_GRAPH_DIR ?? import.meta.dir;
const PLUGIN_ROOT = resolve(GRAPH_DIR, '..');
const SKILL = join(PLUGIN_ROOT, 'skills', 'image-first-shorts');
const TEMPLATES = join(SKILL, 'templates');
const DRY = process.argv.includes('--dry') || process.env.ELANOUS_GRAPH_DRY_RUN === '1';
const BACKENDS = ['flow-aside', 'higgsfield'] as const;

function emit(out: Obj): never {
  console.log(JSON.stringify(out));
  process.exit(0);
}
const fail = (error: string, next?: string): never => emit({ outcome: 'fail', error, ...(next ? { next } : {}) });
// 산출이 «아직» 없다 = 실패가 아니라 대기. 그래프가 wait_<stage> 승인 노드로 보내고, 사람이 «생성 끝»을 승인하면 이 검사로 되돌아온다.
const pending = (what: string, next: string): never => emit({ outcome: 'pending', waiting_for: what, next });

function readJson(path: string): unknown { return JSON.parse(readFileSync(path, 'utf8')); }
function readJsonl(path: string): Obj[] {
  return readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => obj(JSON.parse(l)));
}

// 키트 fill.py 의 fill_text 와 같은 규칙: 공백으로 나뉜 {BLOCK} 토큰, 빈 블록은 건너뛴다.
const TOKEN = /\{([A-Z_]+)\}/g;
export function fillText(template: string, vars: Obj): string {
  const out: string[] = [];
  for (const tok of template.trim().split(' ')) {
    const m = /^\{([A-Z_]+)\}$/.exec(tok);
    if (m) { const v = str(vars[m[1]!]); if (v) out.push(v); }
    else out.push(tok.replace(TOKEN, (_, k: string) => str(vars[k])));
  }
  return out.join(' ');
}

const squash = (s: string): string => s.toLowerCase().replace(/[\s\-_·.]+/g, '');
export function ipHits(texts: Array<[string, string]>, words: string[]): Array<{ at: string; word: string }> {
  const hits: Array<{ at: string; word: string }> = [];
  for (const [at, text] of texts) for (const w of words) if (squash(w) && squash(text).includes(squash(w))) hits.push({ at, word: w });
  return hits;
}

function context(): { input: Obj; outputs: Obj } {
  const path = process.env.ELANOUS_GRAPH_CONTEXT;
  if (!path) {
    // 그래프 밖 단독 시험: 입력 = 예시 파일
    return { input: obj(readJson(join(PLUGIN_ROOT, 'examples', 'input.json'))), outputs: {} };
  }
  const c = obj(readJson(path));
  return { input: obj(c.input), outputs: obj(c.outputs) };
}

function workspace(input: Obj, outputs: Obj): string {
  const fromBrief = str(obj(outputs.brief).workspace);
  if (fromBrief) return fromBrief;
  const ws = str(input.workspace);
  if (!ws || !isAbsolute(ws)) fail('input.workspace 에 «절대 경로» 작업 폴더를 주세요');
  return ws;
}

function budget(input: Obj): { videoCredits: number; elevenChars: number } {
  const b = obj(input.budget);
  return { videoCredits: num(b.video_credits, 120), elevenChars: num(b.eleven_chars, 25000) };
}

function spentCredits(ws: string): number {
  const ledger = join(ws, 'ledger', 'video_credits.jsonl');
  return existsSync(ledger) ? readJsonl(ledger).reduce((s, r) => s + num(r.credits, 0), 0) : 0;
}

// ── 단계 ─────────────────────────────────────────────────────────────
function brief(input: Obj): never {
  const title = str(input.title);
  if (!title) fail('input.title 이 없다');
  const backend = str(input.video_backend) || 'flow-aside';
  if (!BACKENDS.includes(backend as typeof BACKENDS[number])) fail(`input.video_backend 는 ${BACKENDS.join('|')} 중 하나`);
  const words = Array.isArray(input.ip_blocklist) ? input.ip_blocklist.map(str).filter(Boolean) : [];
  if (words.length === 0 && input.ip_blocklist_none !== true) {
    fail('IP 관문: ip_blocklist(금지어 목록)를 주거나, 원작 캐릭터라면 ip_blocklist_none=true 로 «명시»하라');
  }
  const ws = DRY ? mkdtempSync(join(tmpdir(), 'ifs-dry-')) : workspace(input, {});
  for (const d of ['jobs', 'assets/images', 'assets/video', 'assets/matte', 'audio/vo', 'fx', 'out', 'ledger']) mkdirSync(join(ws, d), { recursive: true });
  writeFileSync(join(ws, 'ip_blocklist.txt'), words.join('\n') + '\n');
  writeFileSync(join(ws, 'brief.json'), JSON.stringify({ ...input, workspace: ws, video_backend: backend }, null, 1));
  if (DRY) copyFileSync(join(PLUGIN_ROOT, 'examples', 'storyboard.json'), join(ws, 'storyboard.json'));
  emit({ outcome: 'ok', workspace: ws, video_backend: backend, ip_words: words.length, budget: budget(input), dry: DRY });
}

type Shot = { id: string; kind: 'blue' | 'inworld'; seconds: number; image: Obj; video: Obj; refs: string[] };

function storyboard(input: Obj, outputs: Obj): never {
  const ws = workspace(input, outputs);
  const sbPath = join(ws, 'storyboard.json');
  if (!existsSync(sbPath)) pending(`스토리보드가 없다: ${sbPath}`, 'SKILL.md §S0 — 에이전트가 storyboard.json 을 쓴 뒤 wait_storyboard 승인');
  const sb = obj(readJson(sbPath));
  const fixed = obj(sb.fixed);       // 고정 블록(편 전체 공통): image.{STYLE,BACKGROUND,TAIL} · video.{STYLE,TAIL,...}
  const rawShots = Array.isArray(sb.shots) ? sb.shots : [];
  if (rawShots.length === 0) fail('storyboard.shots 가 비었다');
  const imageTpl = readFileSync(join(TEMPLATES, 'image_template.txt'), 'utf8');
  const videoTpl = readFileSync(join(TEMPLATES, 'video_template.txt'), 'utf8');
  const blocks = obj(readJson(join(TEMPLATES, 'video_blocks.json')));
  const pricing = obj(readJson(join(TEMPLATES, 'pricing.json')));
  const price = obj(pricing.flow_720p_first_frame);
  const problems: string[] = [];
  const imageJobs: Obj[] = []; const videoJobs: Obj[] = [];
  let estimate = 0;
  const seen = new Set<string>();
  for (const [i, raw] of rawShots.entries()) {
    const s = obj(raw);
    const shot: Shot = { id: str(s.id), kind: s.kind === 'inworld' ? 'inworld' : 'blue', seconds: num(s.seconds, 4),
      image: obj(s.image), video: obj(s.video), refs: Array.isArray(s.refs) ? s.refs.map(str).filter(Boolean) : [] };
    if (!/^[A-Za-z0-9_-]+$/.test(shot.id) || seen.has(shot.id)) { problems.push(`shots[${i}].id 가 없거나 중복`); continue; }
    seen.add(shot.id);
    const iv = { ...obj(fixed.image), ...shot.image };
    const vv = { ...obj(fixed.video), ...shot.video };
    // 원칙 ① 텍스트 단독 영상 금지 — 모든 컷은 첫 프레임 이미지가 있다
    if (!str(iv.CHARACTER) && !str(iv.POSE) && !str(s.first_frame)) problems.push(`${shot.id}: 첫 프레임 이미지 묘사가 없다(텍스트 단독 영상 금지)`);
    // 원칙 ② 합성용 컷은 단색 배경 ⊕ 고정 카메라
    if (shot.kind === 'blue') {
      if (!str(iv.BACKGROUND).includes('#1E3CFF')) problems.push(`${shot.id}: blue 컷 이미지 BACKGROUND 에 단색(#1E3CFF) 지시가 없다`);
      if (!str(vv.BACKGROUND)) vv.BACKGROUND = obj(blocks.BACKGROUND).blue;
      if (!str(vv.LOCK)) vv.LOCK = blocks.LOCK;
    }
    // 원칙 ③ 꼬리: 컷 분할·대사·음악 금지
    if (!str(vv.TAIL)) vv.TAIL = blocks.TAIL;
    if (!str(vv.ACTION)) problems.push(`${shot.id}: video.ACTION(움직임)이 없다`);
    if (![4, 6, 8].includes(shot.seconds)) problems.push(`${shot.id}: seconds 는 4·6·8 중 하나`);
    const firstFrame = str(s.first_frame) || `assets/images/${shot.id}.png`;
    imageJobs.push({ id: shot.id, prompt: fillText(imageTpl, iv), size: str(s.size) || '1024x1536', quality: 'high',
      output_path: firstFrame, images: shot.refs });
    const credits = num(price[String(shot.seconds)], 12);
    estimate += credits;
    videoJobs.push({ id: shot.id, kind: shot.kind, mode: 'first_frame', first_frame: firstFrame, seconds: shot.seconds,
      aspect: '9:16', resolution: '720p', prompt: fillText(videoTpl, vv), credits_est: credits,
      result_file: `assets/video/${shot.id}.mp4` });
  }
  if (problems.length) fail(`스토리보드 계약 위반 ${problems.length}건: ${problems.slice(0, 6).join(' · ')}`);
  const words = readFileSync(join(ws, 'ip_blocklist.txt'), 'utf8').split('\n').map(w => w.trim()).filter(Boolean);
  const lyrics = Array.isArray(sb.lyrics) ? sb.lyrics.map(str) : [];
  const hits = ipHits([
    ...imageJobs.map((j): [string, string] => [`image:${j.id}`, str(j.prompt)]),
    ...videoJobs.map((j): [string, string] => [`video:${j.id}`, str(j.prompt)]),
    ...lyrics.map((l, i): [string, string] => [`lyrics:${i}`, l]),
  ], words);
  if (hits.length) fail(`IP 관문: 생성 프롬프트·가사에 금지어 ${hits.length}건 — ${hits.slice(0, 5).map(h => `${h.at}=${h.word}`).join(', ')}`);
  const b = budget(input);
  const regen = num(pricing.regen_per_shot_max, 1);
  const worst = estimate * (1 + regen);
  if (estimate > b.videoCredits) fail(`예산 관문: 영상 크레딧 추정 ${estimate} > 예산 ${b.videoCredits}`);
  writeFileSync(join(ws, 'jobs', 'images.jsonl'), imageJobs.map(j => JSON.stringify(j)).join('\n') + '\n');
  writeFileSync(join(ws, 'jobs', 'video.jsonl'), videoJobs.map(j => JSON.stringify(j)).join('\n') + '\n');
  writeFileSync(join(ws, 'jobs', 'inworld.txt'), videoJobs.filter(j => j.kind === 'inworld').map(j => j.id).join('\n') + '\n');
  emit({ outcome: 'ok', workspace: ws, shots: videoJobs.length, blue: videoJobs.filter(j => j.kind === 'blue').length,
    credits_estimate: estimate, credits_worst_case: worst, budget: b.videoCredits, ip_words_checked: words.length,
    over_budget_if_all_regen: worst > b.videoCredits });
}

function images(input: Obj, outputs: Obj): never {
  const ws = workspace(input, outputs);
  if (DRY) emit({ outcome: 'ok', dry: true, would_check: 'jobs/images.jsonl 의 모든 output_path 존재 ⊕ manifest content_checked=true' });
  const jobs = readJsonl(join(ws, 'jobs', 'images.jsonl'));
  const missing = jobs.filter(j => !existsSync(join(ws, str(j.output_path)))).map(j => str(j.id));
  if (missing.length) pending(`이미지 ${missing.length}/${jobs.length} 없음: ${missing.slice(0, 8).join(',')}`, 'SKILL.md §S1 — tools/imagegen_runner.py 실행 뒤 wait_images 승인');
  const manifestPath = join(ws, 'assets', 'images', 'manifest.jsonl');
  const rows = existsSync(manifestPath) ? readJsonl(manifestPath) : [];
  const checked = new Set(rows.filter(r => r.content_checked === true).map(r => str(r.id)));
  const unchecked = jobs.map(j => str(j.id)).filter(id => !checked.has(id));
  if (unchecked.length) pending(`내용 대조 안 된 이미지 ${unchecked.length}개: ${unchecked.slice(0, 8).join(',')}`, 'SKILL.md §S1-c — 이미지를 «열어 보고» 프롬프트와 대조, 바뀐 이름은 내용 기준으로 재명명한 뒤 manifest 의 content_checked=true · wait_images 승인');
  emit({ outcome: 'ok', images: jobs.length });
}

function video(input: Obj, outputs: Obj): never {
  const ws = workspace(input, outputs);
  const backend = str(obj(outputs.brief).video_backend) || 'flow-aside';
  if (DRY) emit({ outcome: 'ok', dry: true, backend, would_check: 'jobs/video.jsonl 결과 파일 존재 ⊕ 크레딧 원장 합 ≤ 예산' });
  const jobs = readJsonl(join(ws, 'jobs', 'video.jsonl'));
  const noFrame = jobs.filter(j => !existsSync(join(ws, str(j.first_frame)))).map(j => str(j.id));
  if (noFrame.length) fail(`첫 프레임 없는 컷 ${noFrame.join(',')} — 텍스트 단독 생성 금지`);
  const spent = spentCredits(ws);
  const b = budget(input);
  if (spent > b.videoCredits) fail(`예산 초과: 원장 ${spent} > ${b.videoCredits} — 사람 확인 전 추가 생성 금지`);
  const missing = jobs.filter(j => !existsSync(join(ws, str(j.result_file)))).map(j => str(j.id));
  if (missing.length) pending(`영상 ${missing.length}/${jobs.length} 없음: ${missing.slice(0, 8).join(',')}`, `SKILL.md §S2 — 백엔드 ${backend} · 끝나면 wait_video 승인`);
  emit({ outcome: 'ok', clips: jobs.length, credits_spent: spent, budget: b.videoCredits, backend });
}

function matte(input: Obj, outputs: Obj): never {
  const ws = workspace(input, outputs);
  if (DRY) emit({ outcome: 'ok', dry: true, would_check: 'blue 컷마다 assets/matte/<id>.webm ⊕ _qc.jpg' });
  const jobs = readJsonl(join(ws, 'jobs', 'video.jsonl')).filter(j => j.kind === 'blue');
  const missing = jobs.filter(j => !existsSync(join(ws, 'assets', 'matte', `${str(j.id)}.webm`)) || !existsSync(join(ws, 'assets', 'matte', `${str(j.id)}_qc.jpg`))).map(j => str(j.id));
  if (missing.length) pending(`매팅 ${missing.length}/${jobs.length} 없음(webm 또는 QC 시트): ${missing.slice(0, 8).join(',')}`, 'SKILL.md §S3 — tools/matte_queue.sh · 끝나면 wait_post 승인');
  emit({ outcome: 'ok', mattes: jobs.length });
}

function audio(input: Obj, outputs: Obj): never {
  const ws = workspace(input, outputs);
  if (DRY) emit({ outcome: 'ok', dry: true, would_check: 'audio/beats.json(bpm·drop_s·beats_s) ⊕ audio/vo/picks.json(모든 줄 pass|ear_checked)' });
  const beatsPath = join(ws, 'audio', 'beats.json');
  if (!existsSync(beatsPath)) pending('audio/beats.json 없음', 'SKILL.md §S4 — 곡 후보를 tools/analyze_music.py 로 재고 고른 곡을 beats.json 으로 · wait_post 승인');
  const beats = obj(readJson(beatsPath));
  if (typeof beats.bpm !== 'number' || !Array.isArray(beats.beats_s) || beats.beats_s.length < 4) fail('beats.json 에 bpm·beats_s 가 없다');
  const picksPath = join(ws, 'audio', 'vo', 'picks.json');
  const picks = existsSync(picksPath) ? readJson(picksPath) : [];
  const bad = (Array.isArray(picks) ? picks : []).map(obj).filter(p => p.verdict !== 'pass' && p.verdict !== 'ear_checked').map(p => str(p.line_id));
  if (bad.length) pending(`대사 테이크 미통과 ${bad.join(',')}`, 'tools/asr_pick.py 로 다시 고르거나 귀로 확인 후 ear_checked · wait_post 승인');
  emit({ outcome: 'ok', bpm: beats.bpm, drop_s: beats.drop_s ?? null, vo_lines: Array.isArray(picks) ? picks.length : 0 });
}

function fx(input: Obj, outputs: Obj): never {
  const ws = workspace(input, outputs);
  if (DRY) emit({ outcome: 'ok', dry: true, would_check: 'fx/ 에 코드 렌더 레이어(mp4|mov|webm) 1개 이상' });
  const dir = join(ws, 'fx');
  const layers = existsSync(dir) ? readdirSync(dir).filter(f => /\.(mp4|mov|webm)$/i.test(f)) : [];
  if (!layers.length) pending('코드 효과 레이어 없음', 'SKILL.md §S5 — HyperFrames 로 배경·타이포·플래시를 beats.json 시각에 맞춰 렌더 · wait_post 승인');
  emit({ outcome: 'ok', layers });
}

function compose(input: Obj, outputs: Obj): never {
  const ws = workspace(input, outputs);
  if (DRY) emit({ outcome: 'ok', dry: true, would_check: 'out/final.mp4 ⊕ ffprobe 9:16 ⊕ 오디오 스트림' });
  const out = join(ws, 'out', 'final.mp4');
  if (!existsSync(out)) pending('out/final.mp4 없음', 'SKILL.md §S6 — 합성·렌더(heavy.sh 아래) · wait_post 승인');
  const p = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', out], { encoding: 'utf8' });
  if (p.status !== 0) fail(`ffprobe 실패: ${p.stderr.slice(0, 200)}`);
  const info = obj(JSON.parse(p.stdout));
  const streams = (Array.isArray(info.streams) ? info.streams : []).map(obj);
  const v = streams.find(s => s.codec_type === 'video');
  const hasAudio = streams.some(s => s.codec_type === 'audio');
  const w = num(v?.width, 0), h = num(v?.height, 0);
  if (!w || Math.abs(w / h - 9 / 16) > 0.01) fail(`세로 9:16 이 아니다: ${w}x${h}`);
  if (!hasAudio) fail('오디오 스트림이 없다');
  emit({ outcome: 'ok', final: out, width: w, height: h, duration_s: Number(obj(info.format).duration ?? 0) });
}

function done(_input: Obj, outputs: Obj): never {
  emit({ outcome: 'ok', final: obj(outputs.compose).final ?? null, workspace: obj(outputs.brief).workspace ?? null });
}

function failed(_input: Obj, outputs: Obj): never {
  const prev = Object.entries(outputs).map(([k, v]) => [k, obj(v)] as const).reverse().find(([, v]) => v.outcome === 'fail');
  emit({ outcome: 'fail', at: prev?.[0] ?? null, error: str(prev?.[1].error) || '제작 중단', next: str(prev?.[1].next) || null });
}

try {
  const { input, outputs } = context();
  const step = process.argv[2];
  const table: Record<string, (i: Obj, o: Obj) => never> = { brief: i => brief(i), storyboard, images, video, matte, audio, fx, compose, done, failed };
  const fn = step ? table[step] : undefined;
  if (!fn) fail(`알 수 없는 단계: ${step ?? '(없음)'}`);
  fn!(input, outputs);
} catch (error) {
  fail((error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ').slice(0, 300));
}
