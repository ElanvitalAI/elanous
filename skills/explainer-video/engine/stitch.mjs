// Pre-render field cards once; render only the photo composition on subsequent runs.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const W = 1080, H = 1920, FPS = 30, CARD_VERSION = 1;
const cacheRoot = () => process.env.EXPLAINER_CACHE || join(homedir(), '.cache', 'elanous-explainer');
const valid = (path) => { try { const stat = statSync(path); return stat.isFile() && stat.size > 0; } catch { return false; } };
function run(bin, args, cwd) {
  const result = spawnSync(bin, args, { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${bin}: ${result.error?.message ?? result.stderr?.slice(-2000) ?? `exit ${result.status}`}`);
  return result.stdout;
}

async function renderCards({ title, sub, intro, end, cacheDir }) {
  for (const [part, output] of [['intro', intro], ['end', end]]) {
    if (valid(output)) continue;
    const project = join(cacheDir, `project-${part}`);
    mkdirSync(project, { recursive: true });
    run('node', [join(here, 'reel.mjs'), project, '--part', part, '--title', title, '--sub', sub]);
    run('npx', ['-y', `hyperframes@${process.env.HYPERFRAMES_VERSION || '0.8.95'}`, 'render', '--fps', String(FPS), '--workers', '4', '--output', output], join(project, 'reel', 'hf'));
  }
}

export const normalizeCardTitle = (title) => !title || /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(title) ? '현장 스케치' : title;

function ownerGone(lock) {
  let pid;
  try { pid = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).pid; }
  catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    // A new owner may still be writing its identity. Never reclaim that window.
    try { return Date.now() - statSync(lock).mtimeMs > 5_000; } catch { return false; }
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

// A single reaper checks identity again under this claim before moving an orphan.
function recoverLock(lock) {
  const recovery = `${lock}.recovery`;
  try { mkdirSync(recovery); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (ownerGone(recovery)) rmSync(recovery, { recursive: true, force: true });
    return;
  }
  try {
    writeFileSync(join(recovery, 'owner.json'), JSON.stringify({ pid: process.pid }));
    if (!ownerGone(lock)) return;
    const abandoned = `${lock}.abandoned-${randomUUID()}`;
    try { renameSync(lock, abandoned); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return; }
    rmSync(abandoned, { recursive: true, force: true });
  } finally { rmSync(recovery, { recursive: true, force: true }); }
}

export async function ensureCards({ title, sub, cacheDir = join(cacheRoot(), 'cards'), render = renderCards }) {
  title = normalizeCardTitle(title);
  const key = createHash('sha256').update(JSON.stringify([title, sub, W, H, CARD_VERSION])).digest('hex').slice(0, 16);
  const dir = join(cacheDir, key);
  const intro = join(dir, 'intro.mp4'), end = join(dir, 'end.mp4');
  const ready = () => valid(intro) && valid(end);
  if (ready()) return { intro, end, cardsCache: 'hit' };
  mkdirSync(cacheDir, { recursive: true });
  const lock = `${dir}.lock`;
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    try {
      mkdirSync(lock);
      try { writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid })); }
      catch (error) { rmSync(lock, { recursive: true, force: true }); throw error; }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (ready()) return { intro, end, cardsCache: 'hit' };
      recoverLock(lock);
      if (Date.now() >= deadline) throw new Error(`timed out waiting for card render: ${lock}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  let staging;
  try {
    if (ready()) return { intro, end, cardsCache: 'hit' };
    staging = mkdtempSync(join(cacheDir, `.${key}-`));
    await render({ title, sub, intro: join(staging, 'intro.mp4'), end: join(staging, 'end.mp4'), cacheDir: staging });
    if (!valid(join(staging, 'intro.mp4')) || !valid(join(staging, 'end.mp4'))) throw new Error(`card renderer did not produce both cards: ${dir}`);
    rmSync(dir, { recursive: true, force: true });
    renameSync(staging, dir);
    return { intro, end, cardsCache: 'miss' };
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
    rmSync(lock, { recursive: true, force: true });
  }
}

function duration(file) {
  const seconds = Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file]).trim());
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`invalid duration: ${file}`);
  return seconds;
}

export function stitch({ intro, body, end, bgm, out }) {
  const first = duration(intro), middle = duration(body), last = duration(end);
  if (Math.min(first, middle, last) <= 0.3) throw new Error('xfade requires clips longer than 0.3s');
  const total = first + middle + last - 0.6;
  const args = ['-v', 'error', '-y', '-i', intro, '-i', body, '-i', end];
  const music = bgm && existsSync(bgm);
  if (music) args.push('-stream_loop', '-1', '-i', bgm);
  const filters = [
    ...[0, 1, 2].map((i) => `[${i}:v]fps=${FPS},scale=${W}:${H},setsar=1,format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[v${i}]`),
    `[v0][v1]xfade=transition=fade:duration=0.3:offset=${(first - 0.3).toFixed(3)}[v01]`,
    `[v01][v2]xfade=transition=fade:duration=0.3:offset=${(first + middle - 0.6).toFixed(3)}[v]`,
  ];
  if (music) filters.push(`[3:a]atrim=duration=${total.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=0.4,afade=t=out:st=${Math.max(0, total - 1.6).toFixed(3)}:d=1.6,loudnorm=I=-16:TP=-1.5:LRA=9[a]`);
  else filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${total.toFixed(3)}[a]`);
  mkdirSync(dirname(out), { recursive: true });
  run('ffmpeg', [...args, '-filter_complex', filters.join(';'), '-map', '[v]', '-map', '[a]', '-t', total.toFixed(3), '-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', out]);
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const folder = args[1] && resolve(args[1]);
  if (args[0] === '--warm-cards') {
    const title = value('--title'), sub = value('--sub');
    if (title === undefined || sub === undefined) throw new Error('--warm-cards requires --title and --sub');
    const cards = await ensureCards({ title, sub });
    console.log(`reel: cards ${cards.cardsCache} · ${dirname(cards.intro)}`);
  } else if (args[0] === '--instant' && folder) {
    const timelineFile = join(folder, 'reel', 'timeline.json');
    const timeline = JSON.parse(readFileSync(timelineFile, 'utf8'));
    const cards = await ensureCards({ title: timeline.title, sub: timeline.sub });
    const bgm = process.env.FIELD_REEL_BGM || join(cacheRoot(), 'bgm', 'field.wav');
    stitch({ intro: cards.intro, body: join(folder, 'reel', 'body.mp4'), end: cards.end, bgm, out: join(folder, 'reel', 'reel-9x16.mp4') });
    writeFileSync(timelineFile, JSON.stringify({ ...timeline, cardsCache: cards.cardsCache, music: existsSync(bgm) }, null, 2));
    console.log(`reel: cards ${cards.cardsCache}`);
  } else throw new Error('usage: stitch.mjs --warm-cards --title … --sub … | --instant <folder>');
}
