#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { debug } from '../src/debug/log.js';
import { registerStandaloneLogSink } from '../src/domains/standalone-log-sink.js';
import { effectiveInstanceRoot } from '../src/instance/resolve.js';
import trackData from './coord-tracks.json';

type Comment = { id: number; body: string; created_at: string; html_url: string };
type Options = { seat: string; channel: string; since?: string; dryRun: boolean; json: boolean };
const seatIds = new Set(trackData.tracks.map((track) => track.id));

function options(args: string[]): Options {
  let seat = '';
  let channel = '23032';
  let since: string | undefined;
  let dryRun = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--seat' && args[i + 1]) seat = args[++i]!;
    else if (arg === '--channel' && args[i + 1]) channel = args[++i]!;
    else if (arg === '--since' && args[i + 1]) since = args[++i]!;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--json') json = true;
    else throw new Error(`모르는 인자 또는 값 없음: ${arg}`);
  }
  if (!seatIds.has(seat)) throw new Error('--seat <ID> 는 자리 정본의 ID 여야 한다');
  if (!/^[1-9]\d*$/.test(channel)) throw new Error('--channel 은 양의 정수여야 한다');
  if (since && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(since) || !Number.isFinite(Date.parse(since)))) {
    throw new Error('--since 는 ISO 시각이어야 한다');
  }
  return { seat, channel, ...(since ? { since } : {}), dryRun, json };
}

function envelope(body: string, seat: string): { cell?: string; dueAt?: string; text: string } | null {
  const [header = '', ...lines] = body.split(/\r?\n/);
  const match = /^\s*(?:#+\s*)?\*\*\[([^\]]+)\]\*\*[^\n]*?→\s*(.+)$/.exec(header);
  if (!match || match[1] === seat) return null;
  const fields = match[2]!.split('·').map((part) => part.trim());
  const recipients: string[] = [];
  let i = 0;
  while (i < fields.length) {
    const names = fields[i]!.split(/[\s,]+/).filter(Boolean);
    if (!names.length || names.some((name) => !seatIds.has(name) && name !== '전원')) break;
    recipients.push(...names);
    i++;
  }
  if (!recipients.includes(seat) || recipients.includes('전원') || (fields[i] !== '요청' && fields[i] !== '결정')) return null;
  const tail = fields.slice(i + 1);
  const inline: string[] = [];
  let cell: string | undefined;
  let dueAt: string | undefined;
  for (let j = 0; j < tail.length; j++) {
    const field = tail[j]!;
    const suffix = /(?:\s+—\s*|\s+-\s+|:\s+)(\S.*)$/.exec(field);
    const bare = /^(?:—|-|:)\s*(\S.*)$/.exec(field);
    const value = suffix ? field.slice(0, suffix.index).trim() : bare ? '' : field;
    if (/^기한\s+\S/.test(value)) dueAt = value.replace(/^기한\s+/, '');
    else if (j === 0) cell = value;
    else if (value && value !== '-') inline.push(value);
    if (suffix || bare) inline.push((suffix ?? bare)![1]!);
  }
  const text = [...inline, lines.join('\n').trim()].filter(Boolean).join('\n') || '(본문 없음 — 채널 글 링크 참조)';
  return { text: Array.from(text).slice(0, 200).join(''),
    ...(cell && cell !== '-' && !cell.startsWith('기한 ') ? { cell } : {}), ...(dueAt ? { dueAt } : {}) };
}

/** 이미 넣은 요청 — `<seat>|<commentId>` 로 센다. 새 꼴 키 `coord:<id>:<SEAT>` 와 옛 꼴 키 `coord:<id>`(그 줄의 `seat` 로 자리를 판별)를 둘 다 읽어,
 *  한 글이 여러 자리에게 왔을 때 한 자리의 줄이 다른 자리의 요청을 막지 않게 한다. */
function existingSeatComments(path: string): Set<string> {
  let contents: string;
  try { contents = readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw error;
  }
  const seen = new Set<string>();
  for (const line of contents.split('\n')) {
    if (!line) continue;
    const row = JSON.parse(line) as { key?: unknown; seat?: unknown };
    if (typeof row.key !== 'string') continue;
    const current = /^coord:(\d+):([^:]+)$/.exec(row.key);
    if (current) { seen.add(`${current[2]}|${current[1]}`); continue; }
    const legacy = /^coord:(\d+)$/.exec(row.key);
    if (legacy && typeof row.seat === 'string') seen.add(`${row.seat}|${legacy[1]}`);
  }
  return seen;
}

async function run(args: string[]): Promise<void> {
  await registerStandaloneLogSink('coord-requests-bridge');
  let seat = '';
  let reason = 'input';
  try {
    const selected = options(args);
    seat = selected.seat;
    const { channel, since, dryRun, json } = selected;
    reason = 'gh';
    const endpoint = `repos/{owner}/{repo}/issues/${channel}/comments${since ? `?since=${encodeURIComponent(since)}` : ''}`;
    const output = execFileSync('gh', ['api', endpoint, '--paginate', '--jq', '.[]'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const comments = output.split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown);
    reason = 'ledger';
    const path = join(effectiveInstanceRoot(), 'seat-requests', 'requests.jsonl');
    const seen = existingSeatComments(path);
    let picked = 0, added = 0, existing = 0;
    for (const item of comments) {
      const comment = item as Partial<Comment>;
      if (typeof comment.id !== 'number' || !Number.isSafeInteger(comment.id) || typeof comment.body !== 'string'
        || typeof comment.created_at !== 'string' || typeof comment.html_url !== 'string') throw new Error('gh api 댓글 필드가 잘못됐다');
      if (since && Date.parse(comment.created_at) < Date.parse(since)) continue;
      const request = envelope(comment.body, seat);
      if (!request) continue;
      picked++;
      const key = `coord:${comment.id}:${seat}`;
      const marker = `${seat}|${comment.id}`;
      if (seen.has(marker)) { existing++; continue; }
      if (!dryRun) {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, `${JSON.stringify({ key, seat, text: request.text, status: 'queued', queuedAt: comment.created_at,
          source: 'coord', ...('cell' in request ? { cell: request.cell } : {}),
          ...('dueAt' in request ? { dueAt: request.dueAt } : {}), url: comment.html_url })}\n`, { mode: 0o600 });
      }
      seen.add(marker);
      added++;
    }
    const counts = { seat, read: comments.length, picked, added, existing };
    debug.log('coord.requests-bridge', 'run', counts);
    console.log(json ? JSON.stringify(counts) : `읽은 글 ${counts.read} · 고른 수 ${picked} · 새로 넣은 수 ${added} · 이미 있던 수 ${existing}`);
  } catch (error) {
    debug.log('coord.requests-bridge', 'failed', { seat, reason });
    throw error;
  }
}

if (import.meta.main) {
  try { await run(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
