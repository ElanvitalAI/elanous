/**
 * 🟢 무료 라인 시험 — ⛔ ***「돌았다」를 종료코드만으로 믿지 않는다.***
 *   이 파일은 «산출물»을 직접 잰다(프레임 수 · 규격 · 자막이 픽셀에 있나).
 */
import { setDefaultTimeout, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { koreanCaptionFont } from '../src/video-pipeline/recipes/free-line.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const CLI = join(HERE, 'video-free-line.ts');
const TEST_WALKER = join(HERE, 'video-free-line-test-walker.ts');

function run(args: string[], walker?: string): { status: number; out: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO, encoding: 'utf8', timeout: 600_000,
    env: walker ? { ...process.env, GRAPH_WALKER: walker } : process.env,
  });
  if (r.status === null) throw new Error(`죽었다(signal=${r.signal})`);
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/**
 * ⛔⭐ `-of csv=p=0` 은 ***필드 이름을 버린다*** — 그러면 순서가 «가정»이 된다.
 *   🩸 2026-09-22: `stream=nb_read_frames,avg_frame_rate` 로 물었는데 ffprobe 는 `30/1,225` 로
 *      ***요청과 다른 순서***로 냈다. 내 시험이 거꾸로 읽고 «산출이 틀렸다»고 빨갛게 됐다.
 *      ⇒ 실제 산출은 225프레임 = 7.5초로 «맞았다». ***자가 틀린 것이다.***
 *   ✅ 그래서 «키를 살려» 읽는다. 칸 이름은 «산출»에서 온다(생산자 코드에서 오지 않는다).
 */
function probeField(path: string, entries: string, key: string, stream = 'v:0'): string | undefined {
  // ⛔🪞 2026-09-22: 이 자가 «비디오 스트림 고정»이라 오디오 채널을 물으면 ***undefined*** 였다.
  //   그리고 그것이 「값이 없다」처럼 보였다. ⇒ 스트림 선택을 «인자»로 받는다.
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', stream, '-count_frames',
    '-show_entries', entries, '-of', 'default=noprint_wrappers=1:nokey=0', path],
    { encoding: 'utf8', timeout: 120_000 });
  return (r.stdout ?? '').trim().split('\n').find((l) => l.startsWith(`${key}=`))?.split('=')[1];
}

// ⛔ ffmpeg 가 없는 기계에서는 이 시험이 «못 돈다» — 「실패」로 읽지 않는다.
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0;
const HAS_FFPROBE = spawnSync('ffprobe', ['-version'], { encoding: 'utf8' }).status === 0;
const HAS_WALKER = existsSync(process.env.GRAPH_WALKER ?? `${process.env.HOME}/temp/agentic-consulting/scripts/graph-walk.ts`);
const HAS_KOREAN_FONT = koreanCaptionFont() !== null;
const HAS_ASS_FILTER = HAS_FFMPEG && spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout?.includes(' ass ') === true;
const HAS_TEST_WALKER = existsSync(TEST_WALKER);
const SCENE_READY = HAS_FFMPEG && HAS_FFPROBE && HAS_KOREAN_FONT && HAS_ASS_FILTER && HAS_TEST_WALKER;
const MISSING_SCENE_TOOLS = [
  !HAS_FFMPEG && 'ffmpeg', !HAS_FFPROBE && 'ffprobe', !HAS_ASS_FILTER && 'ffmpeg ass 필터',
  !HAS_KOREAN_FONT && '한글 폰트', !HAS_TEST_WALKER && '시험 graph-walk',
].filter((tool): tool is string => Boolean(tool)).join('·');
const MEDIA = HAS_FFMPEG && HAS_FFPROBE;
const LIVE = MEDIA && HAS_WALKER && HAS_KOREAN_FONT;
const MISSING_LIVE_TOOLS = [
  !HAS_FFMPEG && 'ffmpeg', !HAS_FFPROBE && 'ffprobe', !HAS_WALKER && 'graph-walk',
  !HAS_KOREAN_FONT && '한글 폰트',
].filter((tool): tool is string => Boolean(tool)).join('·');

it.skipIf(process.platform !== 'linux' || !MEDIA || !HAS_ASS_FILTER || !HAS_KOREAN_FONT)(
  `Linux scene/SRT/음악 시험은 외부 graph-walk·Apple 폰트에 묶이지 않는다 (결손: ${MISSING_SCENE_TOOLS || '없음'})`, () => {
    expect(HAS_TEST_WALKER).toBe(true);
    expect(SCENE_READY).toBe(true);
  });

it.skipIf(process.platform !== 'linux' || !HAS_KOREAN_FONT)('Linux 한글 폰트는 Apple 경로 없이 자막 레시피에 도달한다', async () => {
  const font = koreanCaptionFont();
  expect(font?.path).toBeDefined();
  expect(font?.family).toBeDefined();
  const work = mkdtempSync(join(tmpdir(), 'fl-ko-font-'));
  try {
    const edl = join(work, 'edl.json');
    writeFileSync(edl, JSON.stringify({ cuts: [{ asset: '/unused.png', dur: 2, text: '하나' }], w: 480, h: 480 }));
    const { drawCaptions } = await import('../src/video-pipeline/recipes/free-line.js');
    const result = await drawCaptions({ workdir: work, state: { edl_json: edl }, log: () => {} });
    expect(result.outcome).toBe('ok');
    const ass = readFileSync(join(work, 'overlay.ass'), 'utf8');
    expect(ass).toContain(`Style: Default,${font!.family},`);
    expect(ass).toContain('하나');
  } finally { rmSync(work, { recursive: true, force: true }); }
});

describe.skipIf(!LIVE)(`무료 라인 — 실물 주행 (결손: ${MISSING_LIVE_TOOLS || '없음'})`, () => {
  const out = mkdtempSync(join(tmpdir(), 'fl-test-'));
  const r = run(['--synth', '3', '--out', out, '--captions', '하나|둘|셋', '--specs', '640x640']);

  it('ground → delivered 까지 «걸어서» 간다', () => {
    expect(r.out).toContain('delivered');
    expect(r.status).toBe(0);
  });

  it('master 가 «실물»이다 — 파일이 있고 비어 있지 않다', () => {
    const m = join(out, 'master.mp4');
    expect(existsSync(m)).toBe(true);
    expect(statSync(m).size).toBeGreaterThan(10_000);
  });

  // ⛔⭐ 이 시험이 핵심이다 — ***컨테이너가 말하는 길이가 아니라 «센 프레임»***으로 본다.
  //   🩸 2026-09-16: zoompan 의 d 가 입력 프레임당이라 2.4초가 151.6초로 나왔고,
  //      그때도 컨테이너의 duration 은 「맞는 값」이었다.
  it('길이가 «프레임 수»로 맞는다 — 컨테이너 말을 믿지 않는다', () => {
    const m = join(out, 'master.mp4');
    const frames = Number(probeField(m, 'stream=nb_read_frames', 'nb_read_frames'));
    const [n, d] = (probeField(m, 'stream=avg_frame_rate', 'avg_frame_rate') ?? '0/1').split('/').map(Number);
    expect(frames).toBeGreaterThan(0);
    expect(frames / (n / d)).toBeCloseTo(3 * 2.5, 1);   // 컷 3 × 2.5초
  });

  it('납품물이 «찌그러지지 않았다» — 규격이 정확하다', () => {
    const f = join(out, 'deliverables', '640x640.mp4');
    expect(existsSync(f)).toBe(true);
    expect(probeField(f, 'stream=width', 'width')).toBe('640');
    expect(probeField(f, 'stream=height', 'height')).toBe('640');
  });

  it('자막이 «픽셀에» 있다 — 자막 없는 클립과 다르다', () => {
    const a = join(out, 'shot-master.png'), b = join(out, 'shot-clip.png');
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1', '-i', join(out, 'master.mp4'), '-frames:v', '1', a]);
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1', '-i', join(out, 'clips', 'c00.mp4'), '-frames:v', '1', b]);
    expect(existsSync(a) && existsSync(b)).toBe(true);
    // ⛔ 「크기가 다르다」가 곧 「자막이다」는 아니다 — 그러나 «같으면» 아무것도 안 그려진 것이다.
    expect(statSync(a).size).not.toBe(statSync(b).size);
  });
});

describe.skipIf(!MEDIA)(`⛔ 빨간 길 — 되읽기가 «실제로» 무나 (결손: ${[
  !HAS_FFMPEG && 'ffmpeg', !HAS_FFPROBE && 'ffprobe',
].filter(Boolean).join('·') || '없음'})`, () => {
  it('zoompan 함정으로 만든 파일을 wrong-length 로 잡는다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fl-trap-'));
    const plate = join(dir, 'p.png'), bad = join(dir, 'trap.mp4');
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
      '-i', 'color=c=black:s=320x180', '-frames:v', '1', plate]);
    // 🩸 «고치기 전»의 그 명령 그대로 — 입력에 -t 를 주고 d 를 프레임으로 준다
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-loop', '1', '-t', '2.4', '-i', plate,
      '-vf', 'zoompan=d=72:s=320x180:fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', bad],
      { timeout: 300_000 });
    expect(existsSync(bad)).toBe(true);

    const { probeMaster } = await import('../src/video-pipeline/recipes/free-line.js');
    const res = await probeMaster({ workdir: dir, state: { master: bad, target_dur: 2.4 }, log: () => {} });
    expect(res.outcome).toBe('wrong-length');          // ⭐ 이것이 초록이면 그 관문은 아무것도 안 잰다
    expect(res.note ?? '').toContain('프레임');
  });
});

describe('⛔ 빨간 길 — 외부 도구 없이 입력 결손을 진단한다', () => {
  it('없는 파일은 «못 쟀다»다 — 실패가 아니다', async () => {
    const { probeMaster } = await import('../src/video-pipeline/recipes/free-line.js');
    const res = await probeMaster({ workdir: tmpdir(), state: { master: '/nope.mp4', target_dur: 1 }, log: () => {} });
    expect(res.outcome).toBe('unmeasurable');
  });

  it('계약 입력이 없으면 «못 쟀다»다', async () => {
    const { renderMaster } = await import('../src/video-pipeline/recipes/free-line.js');
    expect((await renderMaster({ workdir: tmpdir(), state: {}, log: () => {} })).outcome).toBe('unmeasurable');
  });
});

describe('인자 계약 — 준비 실패는 exit 3 다', () => {
  it('워커가 없을 때 준비 실패를 성공이나 원격 실패로 부르지 않는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fl-no-walker-'));
    try {
      const r = spawnSync(process.execPath, [CLI, '--synth', '3'], {
        cwd: REPO, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, GRAPH_WALKER: join(dir, 'absent-graph-walk.ts') },
      });
      expect(r.status).toBe(3);
      expect(`${r.stdout}${r.stderr}`).toContain('워커를 못 찾았다');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('소재도 --synth 도 없으면 exit 3', () => {
    expect(run([]).status).toBe(3);
  });
  it('--synth 가 2 미만이면 exit 3', () => {
    expect(run(['--synth', '1']).status).toBe(3);
  });
  it('모르는 플래그는 exit 3', () => {
    expect(run(['--bogus', 'v']).status).toBe(3);
  });
});

// ⛔⭐⭐ ***되돌아가는 간선이 «실물 주행»에서 도는가*** — 이 PR 이 파는 값의 마지막 칸.
//   🩸 여기 오기 전까지는 걸음 시나리오(목)에서만 증명돼 있었다 —
//      실물 주행은 «곧은 길»로만 갔고 방문 #2 가 0건이었다. 그것이 정직한 미결이었다.
//   🔑 그리고 이것이 이 그래프의 교리다: ***게이트는 «찾기만» 하고 고치는 것은 그 일을 하는 노드다.***
describe.skipIf(!LIVE)(`♻️ 자기 수복 — 게이트가 찾고 상류가 고친다 (결손: ${MISSING_LIVE_TOOLS || '없음'})`, () => {
  const src = mkdtempSync(join(tmpdir(), 'heal-src-'));
  const out = mkdtempSync(join(tmpdir(), 'heal-out-'));
  const lavfi = (spec: string, to: string): void => {
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', spec, '-frames:v', '1', to],
      { timeout: 120_000 });
  };
  // 셋은 16:9 · 하나는 «어긋난» 비율
  // ⛔🪞 2026-09-22: 처음엔 `color=c=black` 을 썼다가 ***새 qc 가 blackframe 으로 잡아 예산까지 돌았다.***
  //   ⇒ 자가 옳고 «내 픽스처»가 틀렸다(검정 판은 «진짜로» 검정 프레임이다). 색을 준다.
  lavfi('color=c=#22303a:s=1280x720', join(src, 'a.png'));
  lavfi('color=c=gray:s=1280x720', join(src, 'b.png'));
  lavfi('color=c=white:s=1280x720', join(src, 'c.png'));
  lavfi('color=c=red:s=600x900', join(src, 'd-odd.png'));
  const r = run(['--source', src, '--out', out, '--specs', '480x480']);

  it('게이트가 비율 이탈을 «찾아» 되돌린다', () => {
    expect(r.out).toContain('ratio');
    expect(r.out).toContain('되돌린다');
  });

  it('⭐ 되돌아간 자리가 «경로»에 찍힌다 — assets#2 · assetgate#2', () => {
    expect(r.out).toContain('assets#2');
    expect(r.out).toContain('assetgate#2');
  });

  it('2회차에 «통과»하고 끝까지 간다 — 예산 소진이 아니다', () => {
    expect(r.out).toContain('delivered');
    expect(r.out).not.toContain('budget-exceeded');
    expect(r.status).toBe(0);
  });

  it('고친 소재가 «찌그러지지 않았다» — 목표 비율로 «넣었다»', () => {
    const fixed = join(out, 'normalized', 'n-d-odd.png');
    expect(existsSync(fixed)).toBe(true);
    expect(probeField(fixed, 'stream=width', 'width')).toBe('1280');
    expect(probeField(fixed, 'stream=height', 'height')).toBe('720');
  });

  // ⛔ 남의 소재를 «제자리에서» 고치지 않는다 — 원본은 그대로여야 한다.
  it('원본 소재는 «안 건드린다»', () => {
    expect(probeField(join(src, 'd-odd.png'), 'stream=width', 'width')).toBe('600');
    expect(probeField(join(src, 'd-odd.png'), 'stream=height', 'height')).toBe('900');
  });

  // ⛔ 빨간 길의 반대쪽 — 전부 같은 비율이면 «되돌아가지 않는다»(늘 되돌리는 자는 자가 아니다).
  it('비율이 다 같으면 되돌아가지 «않는다»', () => {
    const s2 = mkdtempSync(join(tmpdir(), 'heal-ok-'));
    const o2 = mkdtempSync(join(tmpdir(), 'heal-ok-out-'));
    for (const n of ['a', 'b', 'c']) lavfi('color=c=#22303a:s=1280x720', join(s2, `${n}.png`));
    const r2 = run(['--source', s2, '--out', o2, '--specs', '480x480']);
    expect(r2.out).not.toContain('assets#2');
    expect(r2.status).toBe(0);
  });
});

// ⛔⭐⭐ qc — ***「가장 조용한 거짓말」을 픽셀로 잡는가.***
//   🩸 직전까지 qc 는 «파일 크기»만 봤고, 스스로 「검정프레임·자막누락은 안 봤다」고 적고 있었다.
//   🔑 자막 누락은 ***종료코드로 원리상 못 잡는다*** — 폰트를 못 찾아도 ffmpeg 는 exit 0 이다.
describe.skipIf(!LIVE)(`👁️ qc — 픽셀로 본다 (결손: ${MISSING_LIVE_TOOLS || '없음'})`, () => {
  const out = mkdtempSync(join(tmpdir(), 'qc-'));
  const r = run(['--synth', '3', '--out', out, '--captions', '하나|둘|셋', '--specs', '480x480']);

  it('자막이 «있으면» 통과한다', () => {
    expect(r.out).toContain('inspect-master');
    expect(r.status).toBe(0);
    expect(r.out).toContain('자막 층 확인');
  });

  // ⭐ 이 시험이 핵심이다 — ***ffmpeg 가 「성공」이라 말한 산출물***을 qc 가 거부해야 한다.
  it('자막을 «안 그린» master 를 layer-missing 으로 잡는다', async () => {
    const { ffmpeg } = await import('../src/video-pipeline/recipes/ffmpeg.js');
    const { inspectMaster } = await import('../src/video-pipeline/recipes/qc.js');
    const noass = join(out, 'master-noass.mp4');
    // 같은 edl 로 «자막 없이» 다시 굽는다
    const enc = ffmpeg(['-f', 'concat', '-safe', '0', '-i', join(out, 'edl.txt'),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30', noass], 300_000);
    expect(enc.ok).toBe(true);                        // ⛔ ffmpeg 는 «성공»이라 말한다
    const res = await inspectMaster({ workdir: out, state: { master: noass, edl_json: join(out, 'edl.json') }, log: () => {} });
    expect(res.outcome).toBe('layer-missing');        // ⭐ 그런데 qc 는 거부해야 한다
    expect(res.note ?? '').toContain('안 그려졌다');
  });

  // 🩸 2026-09-22 정정 — 이 시험은 «바이트 문턱»(10KB)을 누르고 있었고, ***그 문턱을 걷었다.***
  //   📏 이유: 정상 320×180×2s+자막 = 3,466 B 라 ***멀쩡한 판이 「빈 렌더」로 막혔다.***
  //     ⊕ 문턱 위로 새어도 픽셀 검사가 잡는다(확인함) ⇒ 잡는 쪽은 «중복», 막는 쪽은 «해롭다».
  //   ⇒ 그래서 이 시험이 묻는 것을 바꾼다: 「너무 작다고 말하나」가 «아니라»
  //     ***「작아도 «픽셀로» 잡나」***. ⛔ 판정(blackframe)은 그대로여야 한다.
  it('작은 빈 렌더도 «픽셀로» blackframe 으로 잡는다 — 바이트 문턱 없이', async () => {
    const { ffmpeg } = await import('../src/video-pipeline/recipes/ffmpeg.js');
    const { inspectMaster } = await import('../src/video-pipeline/recipes/qc.js');
    const dir = mkdtempSync(join(tmpdir(), 'qc-tiny-'));
    const tiny = join(dir, 'tiny.mp4');
    expect(ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=1', '-c:v', 'libx264',
      '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-r', '10', tiny], 180_000).ok).toBe(true);
    const res = await inspectMaster({ workdir: dir, state: { master: tiny, edl_json: join(out, 'edl.json') }, log: () => {} });
    expect(res.outcome).toBe('blackframe');
    // ⛔ 이유가 «바이트»가 아니라 «픽셀»이어야 한다 — 그것이 이 정정의 요지다.
    expect(res.note ?? '').toContain('빈 렌더');
    expect(res.note ?? '').not.toContain('너무 작다');
  });

  it('«큰» 검정 영상도 blackdetect 로 잡는다 — 크기 관문을 지나서', async () => {
    const { ffmpeg } = await import('../src/video-pipeline/recipes/ffmpeg.js');
    const { inspectMaster } = await import('../src/video-pipeline/recipes/qc.js');
    const dir = mkdtempSync(join(tmpdir(), 'qc-black-'));
    const black = join(dir, 'black.mp4');
    // ⭐ 크기 관문(10KB)을 «넘기려고» 노이즈를 섞되 아주 어둡게 — 그래야 blackdetect 가 판정한다
    expect(ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=1280x720:d=4', '-c:v', 'libx264',
      '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv420p', '-r', '30', black], 300_000).ok).toBe(true);
    const size = statSync(black).size;
    const res = await inspectMaster({ workdir: dir, state: { master: black, edl_json: join(out, 'edl.json') }, log: () => {} });
    expect(res.outcome).toBe('blackframe');
    // ⛔ «어느 신호»가 잡았는지까지 본다 — 크기로 잡혔으면 blackdetect 는 «안 눌린» 것이다
    if (size >= 10_000) expect(res.note ?? '').toContain('검정 구간');
  });

  // ⛔ 「못 쟀다」를 「통과」로 읽지 않는다 — 대조할 원본이 없으면 판정하지 «않는다».
  it('edl 이 없으면 «못 쟀다»다 — 통과가 아니다', async () => {
    const { inspectMaster } = await import('../src/video-pipeline/recipes/qc.js');
    const res = await inspectMaster({ workdir: out, state: { master: join(out, 'master.mp4') }, log: () => {} });
    expect(res.outcome).toBe('unmeasurable');
  });
});

describe('qc — 입력 결손은 외부 도구 없이 못 쟀다로 끝난다', () => {
  it('master 가 없으면 «못 쟀다»다 — 통과가 아니다', async () => {
    const { inspectMaster } = await import('../src/video-pipeline/recipes/qc.js');
    const res = await inspectMaster({ workdir: tmpdir(), state: { master: '/nope.mp4' }, log: () => {} });
    expect(res.outcome).toBe('unmeasurable');
    expect(res.note).toContain('master 가 없다');
  });
});

// ⛔⭐ `--scene` — ***종합 러너와 무료 라인 사이의 «손»을 없앤 자리.***
//   🔑 파이프라인이 「다음에 이걸 치세요」라고 말하면 그 자리는 아직 «안 이어진» 것이다.
describe.skipIf(!SCENE_READY)(`--scene — 미리 만든 소재·나레이션을 «그대로» 받는다 (결손: ${MISSING_SCENE_TOOLS || '없음'})`, () => {
  const src = mkdtempSync(join(tmpdir(), 'scene-src-'));
  const work = mkdtempSync(join(tmpdir(), 'scene-work-'));
  const imgs: string[] = [];
  for (const n of ['a', 'b', 'c']) {
    const p = join(src, `${n}.png`);
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
      '-i', 'color=c=#22303a:s=1280x720', '-frames:v', '1', p], { timeout: 120_000 });
    imgs.push(p);
  }
  // 나레이션 자리에 «진짜 소리»를 하나 만든다
  const vo = join(work, 'pre.wav');
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'sine=frequency=220:duration=6', '-ar', '24000', vo], { timeout: 120_000 });
  const scenePath = join(work, 'scene.json');
  writeFileSync(scenePath, JSON.stringify({
    images: imgs, vo, music: null, captions: ['하나', '둘', '셋'], specs: ['480x480'],
  }), 'utf8');
  const r = run(['--scene', scenePath, '--out', join(work, 'out')], TEST_WALKER);

  it('scene.json «하나»로 끝까지 간다 — 손이 없다', () => {
    expect(r.out).toContain('delivered');
    expect(r.status).toBe(0);
  });

  it('미리 만든 나레이션을 «다시 만들지 않는다»', () => {
    expect(r.out).toContain('미리 만든 나레이션');
  });

  // ⛔ 그리고 그 소리가 «실제로» 영상에 들어갔나 — 로그가 아니라 스트림을 본다.
  it('master 에 오디오 스트림이 있다', () => {
    expect(probeField(join(work, 'out', 'master.mp4'), 'stream=codec_type', 'codec_type')).toBeDefined();
    const r2 = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_name', '-of', 'default=noprint_wrappers=1:nokey=1',
      join(work, 'out', 'master.mp4')], { encoding: 'utf8', timeout: 60_000 });
    expect((r2.stdout ?? '').trim()).toBe('aac');
  });

  it('없는 scene 파일은 exit 3 이다', () => {
    expect(run(['--scene', join(tmpdir(), 'no-such-scene.json')]).status).toBe(3);
  });
});

// ⛔⭐⭐ 받아쓰기 정렬 — ***이 파이프라인의 마지막 「균등분할」을 없앤 자리.***
//   🩸 그전까지 `align` 은 언제나 계획 길이(또는 총 길이 ÷ 컷 수)를 썼고 note 가 그 한계를 말했다.
//   🔑 ***그 note 가 「없어지는 것」이 이 축이 닫혔다는 신호다.***
describe.skipIf(!SCENE_READY)(`📝 받아쓰기(SRT)로 정렬한다 — 균등분할이 아니다 (결손: ${MISSING_SCENE_TOOLS || '없음'})`, () => {
  const work = mkdtempSync(join(tmpdir(), 'srt-'));
  const src = mkdtempSync(join(tmpdir(), 'srt-src-'));
  const imgs: string[] = [];
  for (const [i, c] of ['0x22303a', '0x3a2230', '0x30223a'].entries()) {
    const p = join(src, `p${i}.png`);
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
      '-i', `color=c=${c}:s=1280x720`, '-frames:v', '1', p], { timeout: 120_000 });
    imgs.push(p);
  }
  const vo = join(work, 'vo.wav');
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'sine=frequency=220:duration=12', '-ar', '24000', vo], { timeout: 120_000 });
  // ⭐ 「고르지 않은」 구간을 일부러 준다 — 균등분할이면 이 시험이 빨개진다.
  const srt = join(work, 'vo.srt');
  writeFileSync(srt, [
    '1', '00:00:00,000 --> 00:00:02,760', ' 첫 줄', '',
    '2', '00:00:03,800 --> 00:00:09,800', ' 둘째 줄', '',
    '3', '00:00:10,800 --> 00:00:12,860', ' 셋째 줄', '',
  ].join('\n'), 'utf8');
  const scene = join(work, 'scene.json');
  writeFileSync(scene, JSON.stringify({
    images: imgs, vo, vo_srt: srt, music: null,
    captions: ['첫 줄', '둘째 줄', '셋째 줄'], specs: ['480x480'],
  }), 'utf8');
  const r = run(['--scene', scene, '--out', join(work, 'out')], TEST_WALKER);

  it('끝까지 가고 «받아쓰기로 정렬»했다고 말한다', () => {
    expect(r.status).toBe(0);
    expect(r.out).toContain('받아쓰기로 정렬');
    expect(r.out).not.toContain('균등분할');       // ⭐ 이 낱말이 다시 나오면 축이 열린 것이다
  });

  it('⭐ 컷 길이가 «SRT 대로»다 — 균등이 아니다', () => {
    const edl = JSON.parse(readFileSync(join(work, 'out', 'edl.json'), 'utf8')) as
      { cuts: { dur: number }[] };
    const ds = edl.cuts.map((c) => Number(c.dur.toFixed(2)));
    expect(new Set(ds).size).toBeGreaterThan(1);   // ⛔ 전부 같으면 균등분할이다
    expect(ds[0]).toBeCloseTo(2.76, 1);
    expect(ds[1]).toBeCloseTo(6.00, 1);
  });

  // ⛔ 「구간 0개」를 「타이밍 0」으로 읽지 않는다 — 받아쓰기가 «실패한» 것이다.
  it('SRT 에서 구간을 «하나도» 못 읽으면 못 쟀다다', async () => {
    const bad = join(work, 'bad.srt');
    writeFileSync(bad, '쓰레기\n아무것도 아님\n', 'utf8');
    const { voiceAndMusic } = await import('../src/video-pipeline/recipes/upstream.js');
    const res = await voiceAndMusic({
      workdir: work, log: () => {},
      state: { shot_plan: [{ asset: imgs[0]!, dur: 2, text: 'a' }], pregenerated_vo: vo, vo_srt: bad },
    });
    expect(res.outcome).toBe('unmeasurable');
  });
});

// ⛔⭐⭐ 음악 믹스 — ***로그가 아니라 «음량과 무음 구간»이 판정한다.***
//   🩸 2026-09-22: `amix` 의 기본이 «평균»(normalize=1)이라, 로그는 「음악 넣었다」인데
//      ***음악 있는 판이 더 조용했고 무음 구간 수가 똑같았다***(= 안 들어간 것).
//   🔑 ***「섞었다」는 스트림이 아니라 «귀에 닿는 값»으로 확인해야 한다.***
describe.skipIf(!SCENE_READY)(`🎵 음악 믹스 — 「넣었다」를 음량으로 확인한다 (결손: ${MISSING_SCENE_TOOLS || '없음'})`, () => {
  const work = mkdtempSync(join(tmpdir(), 'mix-'));
  const src = mkdtempSync(join(tmpdir(), 'mix-src-'));
  const imgs: string[] = [];
  for (const [i, c] of ['0x22303a', '0x3a2230'].entries()) {
    const p = join(src, `p${i}.png`);
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
      '-i', `color=c=${c}:s=1280x720`, '-frames:v', '1', p], { timeout: 120_000 });
    imgs.push(p);
  }
  // 나레이션: 말 사이에 «조용한» 구간이 있게 만든다 — 그래야 음악이 채우는지 보인다
  const vo = join(work, 'vo.wav');
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'sine=frequency=330:duration=2,apad=pad_dur=2', '-ar', '24000', vo], { timeout: 120_000 });
  const bgm = join(work, 'bgm.wav');
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'anoisesrc=d=8:c=pink:a=0.25', '-ac', '2', '-ar', '44100', bgm], { timeout: 120_000 });

  function build(music: string | null, out: string): void {
    const sc = join(work, `scene-${music ? 'm' : 'n'}.json`);
    writeFileSync(sc, JSON.stringify({ images: imgs, vo, music, captions: ['하나', '둘'], specs: ['480x480'] }), 'utf8');
    const result = run(['--scene', sc, '--out', out], TEST_WALKER);
    expect(result.status, result.out).toBe(0);
    expect(existsSync(join(out, 'master.mp4'))).toBe(true);
  }
  function silences(f: string): number {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-i', f, '-af', 'silencedetect=n=-40dB:d=0.4', '-f', 'null', '-'],
      { encoding: 'utf8', timeout: 120_000 });
    return (`${r.stdout}${r.stderr}`.match(/silence_start/g) ?? []).length;
  }
  const withM = join(work, 'out-m'), withoutM = join(work, 'out-n');
  build(bgm, withM); build(null, withoutM);

  it('음악을 넣으면 «무음 구간이 줄어든다» — 말 사이를 채웠다는 뜻', () => {
    const a = silences(join(withM, 'master.mp4'));
    const b = silences(join(withoutM, 'master.mp4'));
    expect(b).toBeGreaterThan(0);        // ⛔ 원래 조용한 구간이 «있어야» 이 시험이 뜻을 갖는다
    expect(a).toBeLessThan(b);           // ⭐ 채워졌다
  });

  it('스테레오 48kHz 로 맞춘다 — 모노로 줄지 않는다', () => {
    expect(probeField(join(withM, 'master.mp4'), 'stream=channels', 'channels', 'a:0')).toBe('2');
    expect(probeField(join(withM, 'master.mp4'), 'stream=sample_rate', 'sample_rate', 'a:0')).toBe('48000');
  });
});
