// 흡수 노트를 등록 가능한 local-docs 폴더 하나로 모은다 — 레지스트리엔 그 폴더를 한 번만(RFC-regular-external-intake O5 · P5).
// ⛔ 글만 있는 개인 메모(user-private · url 없음)는 복사하지 않는다. 자기가 복사한 파일만 매니페스트로 소유하고 지운다.
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { debug } from '../debug/log.js';
import { intakeLedgerDir, loadIntakeLedger } from './items.js';
import { intakeOutboxDir } from './route.js';

export interface SyncIntakeGroundingDocsOptions {
  dryRun?: boolean;
  /** Destination for the local-docs copy. Defaults to <root>/intake/grounding-docs. */
  destinationDir?: string;
}

export interface SyncIntakeGroundingDocsResult {
  /** 등록할 local-docs 폴더(레지스트리에 한 번 `grounding sources add`). */
  dir: string;
  copied: number;
  unchanged: number;
  removed: number;
  skipped: number;
  dryRun: boolean;
}

interface GroundingCandidate { id: string; path: string }

/** 실경로 — 아직 없으면 가장 가까운 있는 조상을 풀고 나머지를 붙인다(macOS 의 `/var` → `/private/var` 같은 링크 조상 때문에 비교가 어긋나지 않게). */
function realish(path: string): string {
  try { return realpathSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    return parent === path ? path : join(realish(parent), basename(path));
  }
}

function pathState(path: string): Stats | null {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Copy routed grounding notes without ever exporting the ledger's private text. */
export function syncIntakeGroundingDocs(root: string, opts: SyncIntakeGroundingDocsOptions = {}): SyncIntakeGroundingDocsResult {
  const requested = resolve(opts.destinationDir ?? join(intakeLedgerDir(root), 'grounding-docs'));
  const dryRun = !!opts.dryRun;
  const result: SyncIntakeGroundingDocsResult = { dir: requested, copied: 0, unchanged: 0, removed: 0, skipped: 0, dryRun };
  // 폴더 «자신»이 링크이면 거부한다(lstat) · 조상의 링크(macOS /var)는 실경로로 풀어 비교를 맞춘다.
  const requestedState = pathState(requested);
  if (requestedState && !requestedState.isDirectory()) throw new Error(`Not a grounding docs directory: ${requested}`);
  const directory = realish(requested);
  result.dir = directory;
  const manifest = join(directory, '.intake-copies.json');
  let owned: string[] = [];
  const manifestState = pathState(manifest);
  if (manifestState) {
    if (!manifestState.isFile()) throw new Error(`Invalid intake grounding manifest: ${manifest}`);
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
    if (!Array.isArray(parsed) || !parsed.every((name) => typeof name === 'string' && /^[a-f0-9]{16}-[^/]+\.md$/.test(name))) {
      throw new Error(`Invalid intake grounding manifest: ${manifest}`);
    }
    owned = parsed;
  }
  const queue = join(intakeOutboxDir(root), 'grounding.jsonl');
  const queueExists = !!pathState(queue);
  // A damaged or missing queue/ledger cannot prove that an omitted row is no longer wanted.
  let queueText: string;
  let ledger: ReturnType<typeof loadIntakeLedger>;
  try {
    queueText = queueExists ? readFileSync(queue, 'utf8') : '';
    ledger = loadIntakeLedger(root);
  } catch {
    result.skipped++;
    debug.log('intake.grounding-docs', 'synced', { copied: 0, skipped: result.skipped, removed: 0, unchanged: 0, dryRun, unreadable: true });
    return result;
  }
  const { items, badLines } = ledger;
  let canPrune = queueExists && badLines === 0;
  const confirmedPrivate = new Set(owned.filter((name) => {
    const item = items.get(name.slice(0, 16));
    return item?.privacy === 'user-private' && !item.url;
  }));
  const wanted = new Map<string, string>();
  const confirmedMissing = new Set<string>();
  for (const line of queueText.split('\n')) {
    if (!line.trim()) continue;
    let candidate: GroundingCandidate;
    try { candidate = JSON.parse(line) as GroundingCandidate; }
    catch { result.skipped++; canPrune = false; continue; }
    if (!candidate || typeof candidate.id !== 'string' || !/^[a-f0-9]{16}$/.test(candidate.id) || typeof candidate.path !== 'string') {
      result.skipped++; canPrune = false; continue;
    }
    const item = items.get(candidate.id);
    if (!item) { result.skipped++; canPrune = false; continue; }
    if ((item.privacy === 'user-private' && !item.url) || item.status === 'discarded') { result.skipped++; continue; }
    if (candidate.path.trim() !== candidate.path || !candidate.path.startsWith('/')) { result.skipped++; canPrune = false; continue; }
    const source = resolve(candidate.path);
    // Queue rows must name a note output of the matching ledger item.
    const latestNote = [...item.outputs].reverse().find((output) => output.kind === 'note');
    if (!latestNote || resolve(latestNote.ref) !== source || !source.endsWith('.md') || source.startsWith(`${directory}/`)) {
      result.skipped++; continue;
    }
    const name = `${candidate.id}-${basename(source)}`;
    try {
      if (!statSync(source).isFile() || realpathSync(source).startsWith(`${directory}/`)) {
        result.skipped++; canPrune = false; continue;
      }
      wanted.set(name, source);
    } catch (error) {
      result.skipped++;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // A dangling symlink (or a race between stat and realpath) is not confirmed absence.
        try { lstatSync(source); canPrune = false; }
        catch (probeError) {
          if ((probeError as NodeJS.ErrnoException).code === 'ENOENT') confirmedMissing.add(name);
          else canPrune = false;
        }
      } else canPrune = false;
    }
  }
  const nextOwned = new Set<string>();
  const unsafe = new Set<string>();
  for (const [name, source] of wanted) {
    const destination = join(directory, name);
    let body: Buffer;
    try { body = readFileSync(source); }
    catch {
      result.skipped++;
      // A read failure does not prove that the source is gone, but a non-file destination is not ours.
      if (owned.includes(name)) {
        try {
          const state = pathState(destination);
          if (!state || state.isFile()) nextOwned.add(name);
        } catch { nextOwned.add(name); }
      }
      continue;
    }
    try {
      const destinationState = pathState(destination);
      if (destinationState && !destinationState.isFile()) { result.skipped++; unsafe.add(name); continue; }
      if (destinationState && !owned.includes(name)) { result.skipped++; unsafe.add(name); continue; }
      if (destinationState && readFileSync(destination).equals(body)) {
        result.unchanged++;
      } else {
        if (!dryRun) {
          mkdirSync(directory, { recursive: true });
          const fd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o666);
          try { writeFileSync(fd, body); } finally { closeSync(fd); }
        }
        result.copied++;
      }
      nextOwned.add(name);
    } catch {
      result.skipped++;
      unsafe.add(name);
    }
  }
  for (const name of owned) {
    if (unsafe.has(name)) continue;
    if (nextOwned.has(name)) continue;
    const file = join(directory, name);
    try {
      const state = pathState(file);
      if (state && !state.isFile()) continue;
      if (!canPrune && !confirmedMissing.has(name) && !confirmedPrivate.has(name)) { nextOwned.add(name); continue; }
      if (state) {
        if (!dryRun) unlinkSync(file);
        result.removed++;
      }
    } catch {
      result.skipped++;
      nextOwned.add(name);
    }
  }
  const nextNames = [...nextOwned].sort();
  if (!dryRun && (owned.length || nextNames.length) && (!manifestState || JSON.stringify([...owned].sort()) !== JSON.stringify(nextNames))) {
    mkdirSync(directory, { recursive: true });
    const fd = openSync(manifest, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o666);
    try { writeFileSync(fd, `${JSON.stringify(nextNames)}\n`); } finally { closeSync(fd); }
  }
  debug.log('intake.grounding-docs', 'synced', { copied: result.copied, skipped: result.skipped, removed: result.removed, unchanged: result.unchanged, dryRun });
  return result;
}
