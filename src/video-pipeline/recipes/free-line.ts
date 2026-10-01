/**
 * 🟢 무료 라인 — ***ffmpeg «만»으로 `compose → overlay → render → readback → deliver` 를 돈다.***
 *
 * ⛔⭐⭐ 이것이 이 파이프라인의 «증명»이다:
 *   RFC 가 내건 주장은 ***「유료는 «가능/불가능»이 아니라 «품질·속도»를 산다」*** 였다.
 *   ⇒ 그 문장이 참이려면 ***유료 앱이 0개인 기계에서 이 구간이 끝까지 돌아야 한다.***
 *   ⛔ 안 돌면 그 문장이 틀린 것이고, RFC 의 축(free|owned|metered)이 값을 못 한 것이다.
 *
 * 📌 쓰는 구현은 셋뿐이다 — `ffmpeg-edl`(assemble) · `ffmpeg-ass`(caption) · `ffmpeg-encode`(encode).
 *    셋 다 `tier: free` 다. 📏 확인 = `bun scripts/video-pipeline.ts plan --from compose --to deliver`
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ffmpeg, probeDuration, run } from './ffmpeg.js';
import { inspectDeliverables } from './shipcheck.js';
import type { Recipe, RecipeCtx, RecipeResult } from './types.js';

/** 한 컷. ⛔ `dur` 는 «초»다 — 프레임과 섞으면 zoompan 함정으로 바로 간다. */
export interface Cut { readonly asset: string; readonly dur: number; readonly text?: string }

const FPS = 30;
/**
 * ⛔⭐⭐ 캔버스는 ***납품 규격이 정한다*** — 고정 16:9 로 굽고 9:16 으로 «자르면»
 *   🩸 2026-09-22 실측: 세로 광고의 ***자막이 좌우로 잘려 나갔다***(master 에선 멀쩡했다).
 *   🔑 ***master 가 멀쩡한 것은 납품물이 멀쩡하다는 뜻이 아니다*** — qc 는 master 만 본다.
 *   ⇒ 첫 target_spec 을 캔버스로 삼는다. 그러면 자막이 «처음부터» 그 틀 안에서 그려진다.
 */
function canvasOf(ctx: RecipeCtx): { w: number; h: number } {
  const specs = (ctx.state.target_specs as string[] | undefined) ?? [];
  const m = /^(\d+)x(\d+)$/.exec(specs[0] ?? '');
  if (!m) return { w: 1280, h: 720 };
  // ⛔ 짝수로 맞춘다 — yuv420p 는 홀수 변을 «조용히» 거부한다.
  return { w: Math.round(Number(m[1]) / 2) * 2, h: Math.round(Number(m[2]) / 2) * 2 };
}

function need<T>(ctx: RecipeCtx, key: string): T | null {
  const v = ctx.state[key];
  return v === undefined || v === null ? null : (v as T);
}

/** ⛔ 「없다」를 「실패」로 접지 않는다 — 계약 입력이 비면 그것은 «못 쟀다»다. */
const missing = (key: string): RecipeResult => ({
  outcome: 'unmeasurable',
  note: `계약 입력 '${key}' 가 state 에 없다 — 앞 노드가 안 채웠다(실패가 «아니다»)`,
});

// ══ ⑧ compose — 어느 클립이 «몇 초»에 (free: ffmpeg-edl) ══════════════════
export const placeClips: Recipe = async (ctx) => {
  const timeline = need<readonly Cut[]>(ctx, 'timeline');
  const assets = need<readonly string[]>(ctx, 'asset_files');
  if (!timeline) return missing('timeline');
  if (!assets) return missing('asset_files');

  const { w: W, h: H } = canvasOf(ctx);
  const clipDir = join(ctx.workdir, 'clips');
  mkdirSync(clipDir, { recursive: true });
  const clips: string[] = [];

  for (const [i, cut] of timeline.entries()) {
    const src = cut.asset;
    if (!existsSync(src)) {
      return { outcome: 'error', note: `소재가 없다: ${src}` };
    }
    const out = join(clipDir, `c${String(i).padStart(2, '0')}.mp4`);
    // ⛔⭐⭐ zoompan 함정 — `d` 는 ***입력 프레임당 출력 프레임***이다.
    //   🩸 2026-09-16 실측: `-loop 1 -t 2.4` 로 2.4초를 기대했는데 ***151.6초***가 나왔다.
    //   ✅ 길이는 `-frames:v` 로 «못 박고» 입력에 `-t` 를 «주지 않는다».
    const frames = Math.max(1, Math.round(cut.dur * FPS));
    // ⛔⭐ 소재 비율이 캔버스와 다르면 «검은 띠»가 남는다 — 광고에서 그것은 싸구려로 보인다.
    //   ✅ 같은 그림을 «채워서 흐리게» 깔고 그 위에 «온전한» 그림을 얹는다(무료 · ffmpeg 만).
    //   ⛔ 늘리지 않는다 — 앞면은 언제나 `decrease` 다.
    const backdrop = ctx.state.backdrop !== false;
    const fg = `scale=${W}:${H}:force_original_aspect_ratio=decrease`;
    const vf = backdrop
      ? `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},`
        // 🩸 반경을 «필터 안에서» 계산했더니(min(h\,w)/18) 쉼표 이스케이프가 깨져
        //    `No option name near '2'` 로 죽었다. ⇒ ***이스케이프와 싸우지 말고 JS 에서 계산한다.***
        + `boxblur=luma_radius=${Math.max(2, Math.round(Math.min(W, H) / 18))}:luma_power=2,`
        + `eq=brightness=-0.12[bg];`
        + `[0:v]${fg}[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,`
        + `zoompan=z='min(zoom+0.0006,1.10)':d=${frames}:s=${W}x${H}:fps=${FPS},format=yuv420p`
      : `${fg},pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,`
        + `zoompan=z='min(zoom+0.0006,1.10)':d=${frames}:s=${W}x${H}:fps=${FPS},format=yuv420p`;
    const r = ffmpeg([
      '-loop', '1', '-i', src,
      backdrop ? '-filter_complex' : '-vf', vf,
      '-frames:v', String(frames),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-r', String(FPS),
      out,
    ], 300_000);
    if (!r.ok) return { outcome: 'error', note: `컷 ${i} 인코딩 실패: ${r.err.split('\n')[0]}` };
    clips.push(out);
    ctx.log('compose.clip', { i, src, dur: cut.dur, frames, out });
  }

  // concat demuxer 목록 — ⛔ 경로에 작은따옴표가 있으면 깨진다. 여기선 우리가 만든 이름뿐이다.
  const listPath = join(ctx.workdir, 'edl.txt');
  writeFileSync(listPath, clips.map((c) => `file '${c}'`).join('\n') + '\n', 'utf8');
  const edlJson = join(ctx.workdir, 'edl.json');
  writeFileSync(edlJson, JSON.stringify({ fps: FPS, w: W, h: H, cuts: timeline, clips }, null, 2), 'utf8');
  ctx.log('compose.canvas', { w: W, h: H });

  return {
    outcome: 'ok',
    produced: { edl: listPath, edl_json: edlJson },
    // ⛔ comp_project 는 «내지 않는다» — app-control 이 없으면 편집 가능한 프로젝트가 «안 남는다».
    //   그 사실을 note 로 말한다(조용히 빠뜨리지 않는다).
    note: `컷 ${clips.length}개. ⚠️ comp_project 는 없다 — app-control 없이는 edl 뿐이다`,
  };
};

// ══ ⑨ overlay — 그 «위» 자막 층 (free: ffmpeg-ass) ═══════════════════════
/** 설치된 한글 폰트를 실제 언어 지원으로 확인한다. fontconfig 의 기본 폰트 폴백만 믿지 않는다. */
export function koreanCaptionFont(): { path: string; family: string } | null {
  const apple = ['/System/Library/Fonts/AppleSDGothicNeo.ttc',
    '/System/Library/Fonts/Supplemental/AppleGothic.ttf'].find(existsSync);
  if (apple) return { path: apple, family: 'AppleSDGothicNeo' };
  const match = spawnSync('fc-match', ['-f', '%{family}\t%{file}\t%{lang}\n', ':lang=ko'],
    { encoding: 'utf8', timeout: 10_000 });
  if (match.status !== 0) return null;
  const [families, path, langs] = (match.stdout ?? '').trim().split('\t');
  if (!families || !path || !langs?.split('|').includes('ko') || !existsSync(path)) return null;
  return { path, family: families.split(',')[0]!.trim() };
}

export const drawCaptions: Recipe = async (ctx) => {
  const edlJson = need<string>(ctx, 'edl_json');
  if (!edlJson) return missing('edl_json');
  let cuts: Cut[]; let W = 1280; let H = 720;
  try {
    const j = JSON.parse(readFileSync(edlJson, 'utf8')) as { cuts: Cut[]; w?: number; h?: number };
    cuts = j.cuts; W = j.w ?? W; H = j.h ?? H;   // ⛔ 자막 틀은 «조립이 쓴 캔버스»를 따라간다
  } catch (e) { return { outcome: 'error', note: `edl 을 못 읽었다: ${(e as Error).message}` }; }

  const font = koreanCaptionFont();
  if (!font) {
    // ⛔ 폰트가 없으면 drawtext/ass 가 «조용히» 빈 층을 만든다 — 그것을 성공으로 내지 않는다.
    return { outcome: 'unmeasurable', note: '한글 폰트를 못 찾았다 — 자막을 «그릴 수 없다»(실패가 아니라 못 함)' };
  }

  const ts = (s: number): string => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
  };
  let t = 0;
  const lines: string[] = [];
  for (const c of cuts) {
    if (c.text) lines.push(`Dialogue: 0,${ts(t)},${ts(t + c.dur)},Default,,0,0,0,,${c.text.replace(/\n/g, '\\N')}`);
    t += c.dur;
  }
  if (lines.length === 0) {
    return { outcome: 'ok', produced: { overlay_layers: null }, note: '자막이 «없다» — 그릴 것이 없었다(빈 층을 만들지 않는다)' };
  }

  const ass = join(ctx.workdir, 'overlay.ass');
  writeFileSync(ass, [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 2', '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,OutlineColour,BackColour,Bold,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    // ⛔ 크기·여백을 «캔버스에 비례»로 — 고정값이면 세로 영상에서 글자가 작아지고 여백이 어긋난다.
    `Style: Default,${font.family},${Math.round(H * 0.045)},&H00FFFFFF,&H00000000,&H80000000,1,1,3,1,2,`
      + `${Math.round(W * 0.07)},${Math.round(W * 0.07)},${Math.round(H * 0.08)},1`, '',
    '[Events]',
    'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
    ...lines,
  ].join('\n') + '\n', 'utf8');

  ctx.log('overlay.ass', { lines: lines.length, font, ass });
  return { outcome: 'ok', produced: { overlay_layers: ass }, note: `자막 ${lines.length}줄` };
};

// ══ ⑩ render — 픽셀을 굽는다 (free: ffmpeg-encode) ════════════════════════
export const renderMaster: Recipe = async (ctx) => {
  const edl = need<string>(ctx, 'edl');
  if (!edl) return missing('edl');
  const ass = need<string>(ctx, 'overlay_layers');

  const vo = need<string>(ctx, 'vo');
  const music = need<string>(ctx, 'music');
  const total = Number(ctx.state.target_dur ?? 0);

  const master = join(ctx.workdir, 'master.mp4');
  const args = ['-f', 'concat', '-safe', '0', '-i', edl];
  if (vo) args.push('-i', vo);
  // ⛔⭐ 음악은 «나레이션 아래»로 깔린다 — 같은 크기로 섞으면 말이 안 들린다.
  //   🩸 2026-09-22: scene.json 에 music 칸을 만들고 ***render 가 안 읽고 있었다***(또 그 자리다).
  if (music) args.push('-i', music);

  // ⭐ 페이드 — 광고·짧은 영상은 «시작과 끝»이 잘리면 싸구려로 보인다. 0.4초씩.
  const fade = total > 1.2 ? `,fade=t=in:st=0:d=0.4,fade=t=out:st=${(total - 0.4).toFixed(2)}:d=0.4` : '';
  const vf = [ass ? `ass=${ass}` : '', fade].filter(Boolean).join('').replace(/^,/, '');
  if (vf) args.push('-vf', vf);

  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
            '-r', String(FPS), '-movflags', '+faststart');
  // ⛔⭐⭐ ***산출이 말하는 수와 코드가 쓰는 수가 «갈려 있었다».***
  //   🩸 2026-09-22: note 가 «−16dB» 라고 찍는데 코드는 −14dB(더킹)·−8dB(음악만)을 썼다.
  //      ⇒ 셋 다 다른 수였고, ***읽는 사람은 note 를 믿는다.***
  //   🔑 ***수를 문장에 손으로 적지 않는다*** — 쓰는 값을 «그대로» 찍는다.
  const DUCK_DB = -14;               // 나레이션 «밑»에 깔 때
  const MUSIC_ONLY_LUFS = -18;       // 음악만일 때 — ⛔ 아래 이유로 감쇠가 아니라 «정규화»다
  let mixNote = '';

  if (vo && music) {
    // 🎚️ 더킹 — ***음악을 나레이션 «밑»으로 낮춘다.***
    //   ⛔🔁 2026-09-22 정정: 종전 문면은 «나레이션 길이에 맞춘다» 였고 ***그것이 결함이었다***.
    //      길이의 권위는 `align` 이다 — 그 노드가 스스로 적는다:
    //      「목표 길이를 여기서 다시 못 박는다 … 안 고치면 readback 이 옛 목표와 비교해 무한히 되돌린다」
    //      ⇒ 렌더는 «그림(= align 의 타임라인)» 길이를 따른다. 나레이션 뒤는 음악만 남는다.
    //   ⛔ `amix` 는 기본이 «평균»이라 둘 다 작아진다 ⇒ 음악만 낮추고 더한다.
    // ⛔⭐⭐ `amix` 는 ***기본이 «평균»(normalize=1)*** 이다 — 입력 수로 나눈다.
    //   🩸 2026-09-22 실측: 그대로 썼더니 ***음악 있는 판이 더 «조용»했다***
    //      (mean −27.4dB ↔ 음악 없는 판 −21.4dB) 그리고 무음 구간 수가 «똑같았다».
    //      ⇒ 로그는 「음악 넣었다」인데 소리는 «안 들어간» 것이다. ***로그가 아니라 음량이 판정한다.***
    //   ✅ `normalize=0` 으로 «더한다». ⊕ 둘 다 스테레오 48k 로 맞춰 채널이 안 줄게 한다.
      // ⛔⭐⭐ 🩸 2026-09-22 실측 — ***나레이션이 영상을 «잘랐다»***.
      //   타임라인 15.17s 인데 완성본이 11.04s 였고, 그 11.04 는 ***vo.wav 의 길이***였다.
      //   기전: [vo] 에 apad 가 «없고» amix 가 duration=first(=vo) 였다
      //         ⇒ 믹스가 나레이션 끝에서 멎고 -shortest 가 그림을 거기서 잘랐다.
      //   ⚠️ 그러면 readback 이 wrong-length 를 내고 plan 으로 되돌아가는데,
      //      되돌아간 plan 은 «측정값을 못 받아» 원래 target 을 다시 쓴다 ⇒ ***영영 수렴 못 한다***
      //      (실물: plan#2→#3→#4 로 네 바퀴 돌고 budget-exceeded · 종단 «없음»).
      //   ✅ 둘 다 apad 로 연장하고 duration=longest 로 두면 길이는 «그림»이 정한다.
    args.push('-filter_complex',
      '[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,apad[vo];'
      + `[2:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${DUCK_DB}dB,apad[bg];`
      + '[vo][bg]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[aout]',
      '-map', '0:v', '-map', '[aout]');
    args.push('-c:a', 'aac', '-b:a', '160k', '-shortest');
  } else if (vo) {
    // ⛔🔁 2026-09-22 정정 — 종전 문면 «짧은 쪽에 맞춘다» 는 ***스스로 모순이었다***:
    //   `-shortest` 는 나레이션이 «길면» 나레이션을 자른다 ⇒ 「잘린 나레이션을 안 남긴다」가 거짓이다.
    //   ⊕ 더 중요한 것 — `readback` 은 `align` 의 target_dur(= 타임라인)과 비교한다.
    //      그림이 잘리면 wrong-length 가 나고 루프가 «영영» 못 닫는다(vo+music 갈래에서 실측).
    //   ✅ 같은 규율 — 나레이션을 apad 로 연장하고 길이는 «그림»이 정한다.
    args.push('-filter_complex',
      '[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,apad[aout]',
      '-map', '0:v', '-map', '[aout]');
    args.push('-c:a', 'aac', '-b:a', '160k', '-shortest');
  } else if (music) {
    // 나레이션이 «없어도» 음악만으로 깐다 — 영상 길이에 맞춘다.
    //
    // ⛔⭐⭐ 종전엔 여기도 «고정 감쇠»(−8dB)였다. ***그것이 실물에서 못 쓸 만큼 조용했다.***
    //   🩸 실측: 원본 −19.5dB 인 곡을 깔았더니 완성본이 ***mean −32.4dB*** — 광고로 못 쓴다.
    //   🔑 문제는 «감쇠량»이 아니라 ***「감쇠」가 틀린 연산이라는 것***이다:
    //      고정 dB 를 빼면 ***들어오는 곡이 얼마나 큰지에 따라 결과가 매번 달라진다.***
    //      (엔진마다 −17.8 ~ −24.2dB 로 갈렸다 — 같은 −8dB 를 빼도 결과가 6dB 벌어진다)
    //   ⇒ ***목표를 정하고 «맞춘다»***(loudnorm) — 그래야 어느 엔진이 만들든 같은 크기로 나온다.
    //   ⚠️ 1패스 loudnorm 은 «근사»다 — 그래서 아래 readback 이 «다시 잰다».
    args.push('-filter_complex',
      '[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,'
      + `loudnorm=I=${MUSIC_ONLY_LUFS}:TP=-1.5:LRA=11,apad[aout]`,
      '-map', '0:v', '-map', '[aout]');
    args.push('-c:a', 'aac', '-b:a', '160k', '-shortest');
    mixNote = ` ⊕ 🎵음악(${MUSIC_ONLY_LUFS} LUFS 로 «맞춤»)`;
  }
  args.push(master);

  const r = ffmpeg(args, 300_000);
  if (!r.ok) return { outcome: 'error', note: `렌더 실패(code=${r.code} signal=${r.signal}): ${r.err.split('\n')[0]}` };
  ctx.log('render.master', { master, withOverlay: Boolean(ass), withVoice: Boolean(vo), withMusic: Boolean(music) });
  return {
    outcome: 'ok', produced: { master },
    note: `${ass ? '자막' : '자막 없이'}${vo ? ' ⊕ 나레이션' : ''}${mixNote} 구웠다${fade ? ' · 페이드 0.4s' : ''}`,
  };
};

// ══ ⑪ readback — ⛔ 만든 것을 «다시 잰다» ════════════════════════════════
export const probeMaster: Recipe = async (ctx) => {
  const master = need<string>(ctx, 'master');
  const target = need<number>(ctx, 'target_dur');
  if (!master) return missing('master');
  if (target === null) return missing('target_dur');

  const p = probeDuration(master);
  // ⛔ 「못 쟀다」를 「길이 0」으로 읽지 않는다.
  if (p.dur === null) return { outcome: 'unmeasurable', note: p.why ?? '길이를 못 쟀다' };

  const delta = p.dur - target;
  ctx.log('readback.measured', { dur: p.dur, frames: p.frames, fps: p.fps, target, delta });
  // ⭐ 이 관문이 이 파이프라인의 «존재 이유» 중 하나다 — 렌더가 exit 0 이라고 길이가 맞는 게 아니다.
  if (Math.abs(delta) > 0.5) {
    return {
      outcome: 'wrong-length',
      produced: { dur: p.dur, gaps: [] },
      note: `길이가 어긋났다 — 실측 ${p.dur.toFixed(2)}s · 목표 ${target.toFixed(2)}s · 차이 ${delta.toFixed(2)}s`
           + ` (프레임 ${p.frames} ÷ fps ${p.fps})`,
    };
  }
  return {
    outcome: 'pass',
    produced: { dur: p.dur, gaps: [] },
    note: `길이 맞음 — ${p.dur.toFixed(2)}s (프레임 ${p.frames} ÷ fps ${p.fps}) · 목표와 ${delta.toFixed(2)}s 차`,
  };
};

// ══ ⑬ deliver — 비율 변형 · 납품 ═════════════════════════════════════════
export const deriveAndShip: Recipe = async (ctx) => {
  const master = need<string>(ctx, 'master');
  const specs = need<readonly string[]>(ctx, 'target_specs');
  if (!master) return missing('master');
  if (!specs || specs.length === 0) return missing('target_specs');

  const outDir = join(ctx.workdir, 'deliverables');
  mkdirSync(outDir, { recursive: true });
  const made: string[] = [];
  // ⛔ 「잘랐다」를 «세어» 산출이 말하게 한다.
  const cropped: string[] = [];
  // ⛔⭐ 이 값은 «스펙마다»가 아니라 «런 단위» 결정이다 — 루프 안에 두면 밖에서 못 읽는다.
  //   🩸 1판이 루프 안에 뒀고, 그래서 `deliver_mode` 를 산출에 실을 때 «이름이 안 보였다».
  const cropMode = ctx.state.deliver_crop === true;

  for (const spec of specs) {
    const m = /^(\d+)x(\d+)$/.exec(spec);
    if (!m) return { outcome: 'error', note: `target_specs '${spec}' 이 <가로>x<세로> 꼴이 아니다` };
    const [tw, th] = [Number(m[1]), Number(m[2])];
    const out = join(outDir, `${tw}x${th}.mp4`);
    const cur = canvasOf(ctx);
    if (cur.w === tw && cur.h === th) {
      // ⛔ 이미 그 규격으로 구웠다 — 다시 굽으면 «한 세대» 더 잃는다. 복사한다.
      const cp = ffmpeg(['-i', master, '-c', 'copy', out], 180_000);
      if (!cp.ok) return { outcome: 'error', note: `${spec} 복사 실패: ${cp.err.split('\n')[0]}` };
      made.push(out); ctx.log('deliver.copy', { spec, out });
      continue;
    }
    // ⛔⭐⭐ ***종전엔 여기서 «잘랐다»(crop). 그리고 그것이 자막을 통째로 지웠다.***
    //
    // 🩸 실측 2026-09-22 — 1080×1920 마스터에서 1920×1080 을 뽑아 «프레임을 봤다»:
    // ```
    //   마스터   아래쪽에 «그래서 먼저 «봅니다»» 가 구워져 있다
    //   납품물   ***자막이 «통째로» 없다*** — 크롭이 아래 띠를 다 잘랐다
    // ```
    //   ⛔ 그런데 종단은 delivered 였고 qc 도 pass 였다 — ***qc 는 «마스터»만 본다.***
    //   ⇒ 이 결함은 ***구조적으로 «보이지 않았다».*** 사람이 파일을 열어야만 보인다.
    //   ⚠️ 매뉴얼 §15-7 이 «이미» 경고하고 있었다(*"비율 변환에서 «자르면» 글자가 사라진다"*).
    //      ***문서가 아는 것을 코드가 몰랐다.***
    //
    // 🔑 자막이 «픽셀에 구워져» 있으면 ***크롭은 원리상 안전할 수 없다.***
    //   ⇒ 기본을 «맞춰 넣기 ⊕ 흐린 배경»으로 바꾼다 — ***한 픽셀도 안 잃는다.***
    //   ⛔ 잘라 채우기가 필요한 판(자막 없는 순수 그림)은 `--deliver-crop` 으로 «명시»한다.
    const radius = Math.max(2, Math.round(Math.min(tw, th) / 18));
    const vf = cropMode
      ? `scale=${tw}:${th}:force_original_aspect_ratio=increase,crop=${tw}:${th}`
      : `[0:v]scale=${tw}:${th}:force_original_aspect_ratio=increase,crop=${tw}:${th},`
        + `boxblur=luma_radius=${radius}:luma_power=2[bg];`
        + `[0:v]scale=${tw}:${th}:force_original_aspect_ratio=decrease[fg];`
        + `[bg][fg]overlay=(W-w)/2:(H-h)/2`;
    const r = ffmpeg([
      '-i', master,
      ...(cropMode ? ['-vf', vf] : ['-filter_complex', vf, '-map', '0:a?']),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',   // ⛔ 소리를 «다시 굽지» 않는다 — 변형은 «그림»의 일이다
      out,
    ], 300_000);
    if (!r.ok) return { outcome: 'error', note: `${spec} 변형 실패: ${r.err.split('\n')[0]}` };
    // ⛔⭐ ***ffmpeg 가 exit 0 이라고 「그 규격이 됐다」가 아니다*** — 재서 확인한다.
    //   🩸 이 축에서 종전에 「납품물 2종」이라고만 말하고 ***그 안을 아무도 안 봤다.***
    const got = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out]).out.trim();
    if (got !== `${tw},${th}`) {
      return { outcome: 'error', note: `${spec} 를 만들었는데 «규격이 다르다»: ${got || '(못 쟀다)'}` };
    }
    made.push(out);
    if (cropMode) cropped.push(spec);
    ctx.log('deliver.variant', { spec, out, mode: cropMode ? 'crop' : 'fit', measured: got });
  }
  return {
    // ⛔ shipcheck 가 「자막이 어디에 왔나」를 «기하로 계산»하려면 «어느 모드였나»를 알아야 한다.
    outcome: 'ok', produced: { deliverables: made, deliver_mode: cropMode ? 'crop' : 'fit' },
    note: `납품물 ${made.length}종`
        + (cropped.length > 0
          // ⛔ 잘랐으면 «반드시» 말한다 — 자막이 구워져 있으면 그것이 사라진다.
          ? ` · ⛔ ***잘라 채운 것 ${cropped.length}종***(${cropped.join(', ')}) — 자막이 있으면 «잘렸다»`
          : ' · 전부 «맞춰 넣기» — 한 픽셀도 안 잃었다')
        // ⛔⭐ 이 노드가 재는 것은 «자기 산출»이다 — 독립 관문이 «아니다».
        //   ✅ 2026-09-22 후속: 그래서 `shipcheck` 노드를 세웠다(이 노드의 «다음»).
        //     ⇒ 만드는 노드와 «보는 노드»가 갈렸다. 여기 수는 «만든 쪽의 자기 보고»다.
        + ' · 검수는 shipcheck 가 «따로» 본다',
  };
};

/** ⛔ 레시피 이름은 «선언의 recipe 칸»과 같아야 한다 — 다르면 워커가 못 찾는다. */
export const FREE_LINE: Readonly<Record<string, Recipe>> = {
  'place-clips': placeClips,
  'draw-captions': drawCaptions,
  'render-master': renderMaster,
  'probe-master': probeMaster,
  'derive-and-ship': deriveAndShip,
  'inspect-deliverables': inspectDeliverables,
};

/**
 * 소재가 없을 때 «만들어» 준다. ⛔ 그 사실은 출처(provenance)로 «반드시» 말한다.
 * 🩸 2026-09-22: 캔버스를 «납품 규격»에서 정하도록 고치며 모듈 상수 W/H 를 지웠는데
 *   ***이 함수가 그것을 계속 참조***하고 있었다. ⛔ `tsc` 가 «안 잡았다» — 실행에서만 죽었다.
 *   ⇒ 크기를 «인자»로 받는다(기본 16:9). 지워진 전역에 기대지 않는다.
 */
export function synthesizePlates(
  dir: string, n: number, w = 1280, h = 720,
): { paths: string[]; why: string } | { paths: null; why: string } {
  mkdirSync(dir, { recursive: true });
  const paths: string[] = [];
  const colors = ['#1f2933', '#2b3a42', '#3e4c59', '#52606d'];
  for (let i = 0; i < n; i++) {
    const p = join(dir, `plate${i}.png`);
    const r = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=${colors[i % colors.length]}:s=${w}x${h}`, '-frames:v', '1', p]);
    if (!r.ok) return { paths: null, why: `판 생성 실패: ${r.err.split('\n')[0]}` };
    paths.push(p);
  }
  return { paths, why: '소재를 «만들었다»(lavfi) — 실제 촬영물이 아니다' };
}
