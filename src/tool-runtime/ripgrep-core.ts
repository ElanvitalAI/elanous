// ── ripgrep-core — 공유 저수준 파일 discovery 프리미티브 (2026-07-17) ──────────
//
// 문제(대표 지적): rg 스폰이 코드베이스 ~10곳에 재발명돼 있었다(skills/tools/{grep,glob}·
// boot/daemon-tools/grep·autopilot/reuse-existence-explorer·tool-runtime/* 등). 각자 다른
// 관례·캡·버그를 가짐 — 특히 결정론 실존 맵이 "내용 검색"만 해서 실재 파일을 [전무] 오판했다.
//
// 해법: discovery 를 티어보다 아래의 "공유 프리미티브"로 추출. Tier-1 네이티브 툴(Glob/Grep 은
// LLM 포맷·페이지네이션을 이 위에 씌우고), 결정론 진단(존재 맵)은 이걸 직접 호출 → 한 곳의 rg
// 관례·gitignore·캡. 미션 루프 에이전트와 진단이 "동일 discovery"를 공유(디스커버리 불일치 종식).
//
// 순수 seam(spawn 주입 가능·테스트). rg 없으면 fail-soft(ok:false·missing-rg).

import { spawn, spawnSync } from 'node:child_process';

const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;   // 8 MB
const DEFAULT_TIMEOUT_MS = 15_000;

export type RgErrorKind = 'missing-rg' | 'invalid' | 'timeout' | 'spawn';

export interface RgResult {
  /** 매칭된 파일 경로(status 1=무매칭이면 빈 배열·ok). */
  paths: string[];
  ok: boolean;
  errorKind?: RgErrorKind;
  stderr?: string;
}

export interface RgSpawnOpts {
  /** 탐색 루트(레포·백업 등). 빈 배열이면 no-op(ok·빈 결과). */
  roots: readonly string[];
  /** ignore 파일을 무시해 숨은 관측 경로도 탐색한다. VCS 메타데이터는 항상 제외한다. */
  noIgnore?: boolean;
  /** 상대경로 해석 기준 cwd(선택). */
  cwd?: string;
  maxBuffer?: number;
  timeoutMs?: number;
  /** 테스트용 spawn 주입(기본=child_process spawnSync). */
  spawn?: (args: string[], opts: { maxBuffer: number; timeoutMs: number; cwd?: string }) => { status: number | null; signal: string | null; stdout: string; stderr: string; enoent?: boolean; threw?: string };
}

export interface RgListFilesOpts extends RgSpawnOpts {
  /** rg --glob 패턴들(gitignore-스타일·경로 필터). 없으면 전체 파일. */
  globs?: readonly string[];
  /** rg --iglob 패턴들 — globs 와 같되 대소문자 무시(Glob 툴 기본 · search-bench 절제 −0.22). */
  iglobs?: readonly string[];
}

/** rg 저수준 실행 — 인자 조립·에러 분류. 내부 공용. */
function runRg(args: string[], opts: RgSpawnOpts): RgResult {
  const roots = opts.roots.filter(Boolean);
  if (!roots.length) return { paths: [], ok: true };
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const run = opts.spawn ?? defaultSpawn;
  const r = run([...args, ...roots], { maxBuffer, timeoutMs, ...(opts.cwd ? { cwd: opts.cwd } : {}) });
  if (r.enoent) return { paths: [], ok: false, errorKind: 'missing-rg' };
  if (r.threw) return { paths: [], ok: false, errorKind: 'spawn', stderr: r.threw };
  if (r.signal) return { paths: [], ok: false, errorKind: 'timeout' };
  if (r.status === 2) return { paths: [], ok: false, errorKind: 'invalid', stderr: (r.stderr ?? '').trim() };
  // status 1 = 무매칭(정상·빈 결과) · status 0 = 매칭.
  const paths = (r.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  return { paths, ok: true };
}

function defaultSpawn(args: string[], o: { maxBuffer: number; timeoutMs: number; cwd?: string }) {
  try {
    const r = spawnSync('rg', args, { encoding: 'utf8', maxBuffer: o.maxBuffer, timeout: o.timeoutMs, ...(o.cwd ? { cwd: o.cwd } : {}) });
    return {
      status: r.status,
      signal: r.signal,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      enoent: !!(r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT'),
    };
  } catch (err) {
    return { status: null, signal: null, stdout: '', stderr: '', threw: err instanceof Error ? err.message : String(err) };
  }
}

/** ★ 파일 경로 discovery — `rg --files [--glob ...]`. gitignore 존중. Glob 툴·존재 맵 공유 프리미티브. */
export function rgListFiles(opts: RgListFilesOpts): RgResult {
  const args = ['--files'];
  appendIgnoreArgs(args, opts.noIgnore);
  for (const g of opts.globs ?? []) { args.push('--glob', g); }
  for (const g of opts.iglobs ?? []) { args.push('--iglob', g); }
  return runRg(args, opts);
}

export interface FilesWithMatchesOpts extends RgSpawnOpts {
  wholeWord?: boolean; ignoreCase?: boolean; fixed?: boolean; globs?: readonly string[];
}

/** `rg -l [-w|-i|-F] [--glob …] -- pattern` 인자 조립(sync/async 공용). */
function filesWithMatchesArgs(pattern: string, opts: FilesWithMatchesOpts): string[] {
  const args = ['-l'];
  appendIgnoreArgs(args, opts.noIgnore);
  if (opts.wholeWord) args.push('-w');
  if (opts.ignoreCase) args.push('-i');
  if (opts.fixed) args.push('-F');
  for (const g of opts.globs ?? []) { args.push('--glob', g); }
  args.push('--', pattern);
  return args;
}

/** ★ 내용 매칭 파일 목록(동기) — 심볼 실존 판정·파일 pre-filter 공유 프리미티브. */
export function rgFilesWithMatches(pattern: string, opts: FilesWithMatchesOpts): RgResult {
  if (!pattern) return { paths: [], ok: true };
  return runRg(filesWithMatchesArgs(pattern, opts), opts);
}

/** ★ 내용 매칭 파일 목록(비동기·spawn 스트리밍) — 데몬 블로킹 회피용(세션검색 등). */
export function rgFilesWithMatchesAsync(pattern: string, opts: FilesWithMatchesOpts): Promise<RgResult> {
  if (!pattern) return Promise.resolve({ paths: [], ok: true });
  const roots = opts.roots.filter(Boolean);
  if (!roots.length) return Promise.resolve({ paths: [], ok: true });
  const argv = [...filesWithMatchesArgs(pattern, opts), ...roots];
  return new Promise((resolve) => {
    let child;
    try { child = spawn('rg', argv, opts.cwd ? { cwd: opts.cwd } : {}); }
    catch (err) { return resolve({ paths: [], ok: false, errorKind: 'spawn', stderr: err instanceof Error ? err.message : String(err) }); }
    const out: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.on('error', (err: NodeJS.ErrnoException) => resolve({ paths: [], ok: false, errorKind: err.code === 'ENOENT' ? 'missing-rg' : 'spawn', stderr: err.message }));
    child.on('close', (code) => {
      if (code !== 0 && code !== 1) return resolve({ paths: [], ok: false, errorKind: 'invalid' }); // 2+ = error
      const paths = Buffer.concat(out).toString('utf8').split('\n').map((s) => s.trim()).filter(Boolean);
      resolve({ paths, ok: true });
    });
  });
}

// ── rg --json 내용 매칭(라인단위) 공유 프리미티브 (obsidian·vault·acp 3벌 복붙 수렴) ──

export interface RgJsonMatch { path: string; line: number; text: string }

export interface RgJsonParseOpts {
  limit?: number;         // 총 match 상한(도달 시 중단)
  snippetMax?: number;    // text slice 상한(없으면 무제한)
  relTo?: string;         // path 접두(`<relTo>/`) 제거 → 상대경로
  pathFallback?: string;  // path.text 없을 때(기본 '')
}

/** ★ rg --json 1줄 → match 이벤트면 {path,line,text}, 아니면 null. 순수 per-line 투영(공유 파서).
 *  buffered(parseRgJsonMatches)·streaming(daemon-grep) 양쪽이 이 한 함수를 쓴다. */
export function parseRgJsonMatchLine(line: string, opts: RgJsonParseOpts = {}): RgJsonMatch | null {
  if (!line.trim()) return null;
  let evt: unknown;
  try { evt = JSON.parse(line); } catch { return null; }
  if (!evt || typeof evt !== 'object') return null;
  const obj = evt as { type?: unknown; data?: unknown };
  if (obj.type !== 'match') return null;
  const data = (obj.data ?? {}) as { path?: { text?: unknown }; line_number?: unknown; lines?: { text?: unknown } };
  let path = typeof data.path?.text === 'string' ? data.path.text : (opts.pathFallback ?? '');
  const ln = typeof data.line_number === 'number' ? data.line_number : 0;
  let text = typeof data.lines?.text === 'string' ? data.lines.text : '';
  text = text.replace(/\r?\n+$/, '');
  if (opts.snippetMax != null) text = text.slice(0, opts.snippetMax);
  if (opts.relTo && path.startsWith(opts.relTo + '/')) path = path.slice(opts.relTo.length + 1);
  return { path, line: ln, text };
}

/** ★ rg --json stdout → match 이벤트만 {path,line,text} 로 투영(buffered). 순수(공유 파서·복붙 수렴). */
export function parseRgJsonMatches(stdout: string, opts: RgJsonParseOpts = {}): RgJsonMatch[] {
  const out: RgJsonMatch[] = [];
  for (const line of stdout.split('\n')) {
    const m = parseRgJsonMatchLine(line, opts);
    if (!m) continue;
    out.push(m);
    if (opts.limit != null && out.length >= opts.limit) break;
  }
  return out;
}

export interface RgJsonSearchOpts extends RgJsonParseOpts {
  roots: readonly string[];
  /** ignore 파일을 무시해 숨은 관측 경로도 탐색한다. VCS 메타데이터는 항상 제외한다. */
  noIgnore?: boolean;
  cwd?: string;
  ignoreCase?: boolean;
  smartCase?: boolean;              // -S (ignoreCase 미설정 시)
  lineNumber?: boolean;             // --line-number
  perFileMaxCount?: number;         // --max-count (파일당)
  maxCount?: number;                // -m (총)
  maxFilesize?: string;             // --max-filesize (예 '5M')
  types?: readonly string[];        // --type
  typeAdd?: readonly string[];      // --type-add
  noConfig?: boolean;               // --no-config
  /** 테스트/커스텀 spawn(기본=async buffered). */
  spawn?: (rgArgs: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;
}

export interface RgJsonResult { matches: RgJsonMatch[]; ok: boolean; code: number | null; stderr: string }

function appendIgnoreArgs(args: string[], noIgnore?: boolean): void {
  if (noIgnore) args.push('--no-ignore', '--hidden', '--glob', '!**/.git/**');
}

/** rg --json 인자 조립(pattern·roots 제외). */
function rgJsonArgs(opts: RgJsonSearchOpts): string[] {
  const args = ['--json'];
  appendIgnoreArgs(args, opts.noIgnore);
  if (opts.noConfig) args.push('--no-config');
  if (opts.lineNumber) args.push('--line-number');
  if (opts.ignoreCase) args.push('--ignore-case');
  else if (opts.smartCase) args.push('-S');
  if (opts.perFileMaxCount != null) args.push('--max-count', String(opts.perFileMaxCount));
  if (opts.maxCount != null) args.push('-m', String(opts.maxCount));
  if (opts.maxFilesize) args.push('--max-filesize', opts.maxFilesize);
  for (const t of opts.typeAdd ?? []) args.push('--type-add', t);
  for (const t of opts.types ?? []) args.push('--type', t);
  return args;
}

function defaultJsonSpawn(cwd?: string): (rgArgs: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }> {
  return (rgArgs) => new Promise((resolve) => {
    let child;
    try { child = spawn('rg', rgArgs, cwd ? { cwd } : {}); }
    catch (err) { return resolve({ code: -1, stdout: '', stderr: `rg-spawn: ${err instanceof Error ? err.message : String(err)}` }); }
    const chunks: Buffer[] = []; let stderr = '';
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err: Error) => resolve({ code: -1, stdout: '', stderr: `rg-spawn: ${err.message}` }));
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(chunks).toString('utf8'), stderr }));
  });
}

/** ★ rg --json 내용 검색(비동기 buffered) — {path,line,text} 매치 반환. obsidian·vault·acp 공유.
 *  code 0=매치·1=무매치(둘 다 ok) · 2+/-1=에러(ok:false·code/stderr 로 consumer 가 포맷). */
export async function rgJsonMatchesAsync(pattern: string, opts: RgJsonSearchOpts): Promise<RgJsonResult> {
  const roots = opts.roots.filter(Boolean);
  if (!pattern || !roots.length) return { matches: [], ok: true, code: 1, stderr: '' };
  const argv = [...rgJsonArgs(opts), '--', pattern, ...roots];
  const runner = opts.spawn ?? defaultJsonSpawn(opts.cwd);
  const { code, stdout, stderr } = await runner(argv);
  if (code !== 0 && code !== 1) return { matches: [], ok: false, code, stderr };
  return { matches: parseRgJsonMatches(stdout, opts), ok: true, code, stderr };
}
