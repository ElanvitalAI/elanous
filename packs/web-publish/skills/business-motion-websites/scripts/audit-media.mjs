#!/usr/bin/env node
// Source: passeth/business-motion-websites @ fe5e8b0ae3a208efba751d3dd13aa168afd4fa74 (MIT, Copyright (c) 2026 passeth) — https://github.com/passeth/business-motion-websites — vendored unchanged except this line. See SOURCE.md.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const usage = `Usage: node audit-media.mjs <manifest.json> [--out <report.json>] [--ffprobe <executable>]

Read-only local media audit. Requires ffprobe on PATH or --ffprobe.
Manifest: {"assets":[{"id":"hero","kind":"video","file":"media/hero.mp4",
"poster":"media/hero.webp","expectedAudio":false,"maxBytes":12000000}]}
Paths are relative to the manifest directory. kind: image | video.
expectedAudio and maxBytes are optional. Video posters are required by this audit.
No network access, uploads, generation, or media modification.
Exit 0: metadata checks pass. Exit 1: asset problems. Exit 2: invalid input/tool.
Does not prove visual quality, motion, audible speech, rights, or device playback.`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** target 이 dir 안(링크를 풀어도 안)에 있는가 — '..' 탈출과 절대경로 탈출을 모두 잡는다. */
function insideWork(dir, target) {
  const rel = path.relative(dir, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
function probe(file, binary) {
  return JSON.parse(execFileSync(binary, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
  }));
}
function requireFile(file) {
  if (!fs.statSync(file).isFile()) throw new Error(`Not a regular file: ${file}`);
}
function run() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return; }
  if (!args.length || args[0].startsWith('--')) throw new Error(usage);
  const manifestPath = path.resolve(args[0]);
  let out = null;
  let binary = 'ffprobe';
  const flags = new Set();
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (!['--out', '--ffprobe'].includes(flag) || !value || value.startsWith('--') || flags.has(flag)) throw new Error(`Invalid option: ${flag}\n${usage}`);
    flags.add(flag);
    if (flag === '--out') out = path.resolve(value); else binary = value;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!isRecord(manifest) || !Array.isArray(manifest.assets) || !manifest.assets.length) throw new Error('Manifest must contain a nonempty assets array.');
  const ids = new Set();
  for (const a of manifest.assets) {
    if (!isRecord(a) || typeof a.id !== 'string' || !a.id.trim() || ids.has(a.id)) throw new Error('Asset IDs must be nonempty and unique.');
    ids.add(a.id);
    if (!['image', 'video'].includes(a.kind) || typeof a.file !== 'string' || !a.file.trim()) throw new Error(`Invalid kind/file for ${a.id}.`);
    if (a.poster !== undefined && (typeof a.poster !== 'string' || !a.poster.trim())) throw new Error(`Invalid poster for ${a.id}.`);
    if (a.expectedAudio !== undefined && typeof a.expectedAudio !== 'boolean') throw new Error(`expectedAudio must be boolean for ${a.id}.`);
    if (a.maxBytes !== undefined && (!Number.isSafeInteger(a.maxBytes) || a.maxBytes <= 0)) throw new Error(`maxBytes must be a positive integer for ${a.id}.`);
  }
  const directory = path.dirname(manifestPath);
  // 작업 폴더(manifest 디렉터리) 경계: 입력·출력·ffprobe 실행 파일이 폴더 밖(심볼릭 링크를 타서라도)으로 나가면 거부한다.
  // realDir 를 기준으로 resolve 하고 realpath 로 편 뒤 비교한다 — 링크 경로와 실제 경로를 섞지 않는다.
  const realDir = fs.existsSync(directory) ? fs.realpathSync(directory) : directory;
  /** p 를 실제 파일시스템 경로로 완전히 편다. 존재하지 않는 끝 칸은 «존재하는 가장 가까운 조상»의 realpath 뒤에 tail 로 붙인다.
   * 각 칸을 lstatSync 로 링크 자체로 본다 — existsSync 는 끊긴 symlink 를 «없음»으로 보지만 lstatSync 는 링크로 잡아
   * readlink 로 재귀적으로 풀므로, «문자열상으로는 폴더 안이지만 중간 symlink 디렉터리를 타서 실제로는 밖»인 경로도
   * 밖 실제 경로로 펼쳐 경계 검사에 걸린다. 존재하지 않는 tail 칸은 엔트리가 없으므로 링크를 탈 수 없다. */
  const resolveReal = (p, depth = 0) => {
    if (depth > 16) throw new Error('심볼릭 링크가 너무 깊다.');
    let cur = p;
    let tail = '';
    for (;;) {
      let stat = null;
      try { stat = fs.lstatSync(cur); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const parent = path.dirname(cur);
        if (parent === cur) return cur + tail;
        tail = cur.slice(parent.length) + tail;
        cur = parent;
        continue;
      }
      if (stat.isSymbolicLink()) {
        const target = path.resolve(path.dirname(cur), fs.readlinkSync(cur));
        return resolveReal(target, depth + 1) + tail;
      }
      return fs.realpathSync(cur) + tail;
    }
  };
  /** value 를 realDir 기준으로 resolve 하고 실제 경로로 편다. realDir 안이 아니면 거부한다.
   * write=true(쓰기 대상)면 폴더 안으로 풀린 경로라도 inode 를 밖 이름과 공유하는 하드 링크를 거부한다 —
   * realpath 는 하드 링크를 «안»으로 보지만 O_TRUNC 는 같은 inode 인 폴더 밖 파일을 덮어쓴다. */
  const guardInside = (label, value, write = false) => {
    const real = resolveReal(path.resolve(realDir, value));
    if (!insideWork(realDir, real)) throw new Error(`작업 폴더 밖 ${label} 은 거부한다: ${value}`);
    if (write) {
      let stat = null;
      try { stat = fs.lstatSync(real); } catch {}
      if (stat && !stat.isSymbolicLink() && stat.nlink > 1)
        throw new Error(`작업 폴더 밖 ${label} 은 거부한다(하드 링크가 폴더 밖 이름과 inode 를 공유한다): ${value}`);
    }
    return real;
  };
  for (const a of manifest.assets) {
    for (const entry of [a.file, a.poster]) {
      if (typeof entry !== 'string' || !entry.trim()) continue;
      guardInside('경로', entry);
    }
  }
  if (out) out = guardInside('--out', out, true);
  // «--ffprobe 를 줬는가»로 가른다 — 값이 우연히 'ffprobe' 인지로 가르면 `--ffprobe ffprobe` 가
  // 경계 검사를 통째로 건너뛰고 PATH 조회로 폴더 밖 바이너리를 실행한다.
  if (flags.has('--ffprobe')) {
    if (!binary.includes('/') && !binary.includes('\\'))
      throw new Error(`작업 폴더 밖 --ffprobe 실행 파일은 거부한다(PATH 조회는 허용하지 않는다): ${binary}`);
    // execFileSync 는 상대 경로를 CWD 기준으로 푼다 — 가드도 CWD 기준으로 확정한 그 경로를 검사하고,
    // 확정된 실경로를 그대로 실행한다(검사 경로 = 실행 경로). realDir 기준으로만 검사하면
    // `--ffprobe ./ffprobe` 같은 상대 경로가 폴더 안으로 공허하게 통과한 뒤 CWD 의 밖 바이너리가 실행된다.
    binary = guardInside('--ffprobe 실행 파일', path.resolve(binary));
  }
  const localFiles = manifest.assets.flatMap(a => [a.file, ...(a.poster ? [a.poster] : [])]).map(f => path.resolve(directory, f));
  const resolvedOut = out && fs.existsSync(out) ? fs.realpathSync(out) : out;
  const inputPaths = [manifestPath, ...localFiles].map(f => fs.existsSync(f) ? fs.realpathSync(f) : f);
  if (resolvedOut && inputPaths.includes(resolvedOut)) throw new Error('Report path must not overwrite the manifest or a media asset.');
  try { execFileSync(binary, ['-version'], {stdio: 'ignore', timeout: 10000}); }
  catch { throw new Error('ffprobe is unavailable. Install it in your environment or pass --ffprobe.'); }
  const assets = manifest.assets.map(a => {
    const file = path.resolve(directory, a.file);
    const result = {id: a.id, kind: a.kind, file, issues: []};
    try {
      requireFile(file);
      const data = probe(file, binary);
      const visual = data.streams?.find(s => s.codec_type === 'video');
      result.bytes = fs.statSync(file).size;
      result.codec = visual?.codec_name ?? null;
      result.width = visual?.width ?? null;
      result.height = visual?.height ?? null;
      result.hasAudio = Boolean(data.streams?.some(s => s.codec_type === 'audio'));
      const duration = Number(data.format?.duration ?? visual?.duration);
      result.durationSeconds = Number.isFinite(duration) ? duration : null;
      if (!visual || !result.width || !result.height) result.issues.push('No visual stream dimensions.');
      if (a.kind === 'video' && !(result.durationSeconds > 0)) result.issues.push('Video duration is missing or zero.');
      if (a.expectedAudio !== undefined && a.expectedAudio !== result.hasAudio) result.issues.push(`Expected audio=${a.expectedAudio}; found=${result.hasAudio}.`);
      if (a.maxBytes !== undefined && result.bytes > a.maxBytes) result.issues.push(`Size ${result.bytes} exceeds configured ${a.maxBytes} bytes.`);
    } catch (error) {
      result.issues.push(`Asset probe failed: ${error.code ?? error.message}`);
    }
    if (a.kind === 'video' && !a.poster) result.issues.push('Video poster is not declared.');
    if (a.poster) {
      const poster = path.resolve(directory, a.poster);
      try {
        requireFile(poster);
        const data = probe(poster, binary);
        const visual = data.streams?.find(s => s.codec_type === 'video');
        if (!visual?.width || !visual?.height) throw new Error('No visual dimensions.');
        result.poster = {file: poster, width: visual.width, height: visual.height};
      } catch (error) { result.issues.push(`Poster probe failed: ${error.code ?? error.message}`); }
    }
    return result;
  });
  const report = {
    checkedAt: new Date().toISOString(), manifest: manifestPath,
    status: assets.some(a => a.issues.length) ? 'FAIL' : 'PASS', assets,
    limits: 'Metadata checks only; visual motion, audible content, rights and device playback require separate verification.'
  };
  if (out) {
    // O_NOFOLLOW 로 마지막 칸이 symlink 면 링크를 따라가지 않고 실패한다(경계 우회 2중 방지).
    const text = `${JSON.stringify(report, null, 2)}\n`;
    let linked = null;
    try { linked = fs.lstatSync(out); } catch {}
    if (linked?.isSymbolicLink()) throw new Error(`--out 대상이 링크면 거부한다: ${out}`);
    const fd = fs.openSync(out, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW ?? 0));
    try { fs.writeFileSync(fd, text); } finally { fs.closeSync(fd); }
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.status === 'FAIL') process.exitCode = 1;
}
try { run(); } catch (error) { fail(error.message); }
