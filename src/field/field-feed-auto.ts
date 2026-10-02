// EV10e — 현장 영상 렌더가 끝나면 같은 폴더로 인스타 피드 초안 런(graphs/field/field-feed.yaml)을 떼어 띄운다.
// 사람 손 없이 «사진 한 번 → 영상 ⊕ 피드 초안이 게시 대기에». 승인 전엔 아무것도 밖으로 안 나간다(그래프의 post 노드).
// 이미 «아직 안 끝난» 초안이 있으면 띄우지 않는다 — 같은 폴더에 게시 대기 카드가 둘 생기지 않게.
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { debug } from '../debug/log.js';

export interface FieldFeedStart { started: boolean; reason?: 'disabled' | 'pending-draft' | 'no-script' | 'spawn-failed'; pid?: number }

export interface FieldFeedAutoDeps {
  spawn?: typeof nodeSpawn;
  /** 기본 = 이 파일 기준 `scripts/field-feed/start.ts`(설치본·작업 트리 둘 다 같은 상대 위치). */
  script?: string;
  /** 기본 = 지금 런타임(bun). */
  runtime?: string;
}

/** 초안이 있고 아직 deliver 되지 않았으면(게시 대기 · 사람이 고치는 중) 새 런을 띄우지 않는다. */
export function hasPendingFeedDraft(dir: string): boolean {
  const path = join(dir, 'feed', 'feed-draft.json');
  if (!existsSync(path)) return false;
  try { return !(JSON.parse(readFileSync(path, 'utf8')) as { delivered?: unknown }).delivered; }
  catch { return true; } // 못 읽으면 «있다»로 — 덮어쓰지 않는 쪽
}

export function startFieldFeed(dir: string, opts: { enabled?: boolean } = {}, deps: FieldFeedAutoDeps = {}): FieldFeedStart {
  const event = dir.split(/[\\/]/).at(-1)!;
  const done = (r: FieldFeedStart): FieldFeedStart => {
    debug.log('field.feed', r.started ? 'auto-start' : 'auto-skip', { event, ...(r.reason ? { reason: r.reason } : {}), ...(r.pid ? { pid: r.pid } : {}) });
    return r;
  };
  // `bun test` 안에서는 명시적으로 켜지 않는 한 끈다 — 렌더 흐름 시험이 진짜 피드 런(그래프)을 띄우지 않게.
  const testRun = process.env.NODE_ENV === 'test' && opts.enabled !== true;
  if (opts.enabled === false || testRun || process.env.ELANOUS_FIELD_FEED_AUTO === '0') return done({ started: false, reason: 'disabled' });
  if (hasPendingFeedDraft(dir)) return done({ started: false, reason: 'pending-draft' });
  const script = deps.script ?? resolve(import.meta.dir, '../../scripts/field-feed/start.ts');
  if (!existsSync(script)) return done({ started: false, reason: 'no-script' });
  try {
    mkdirSync(join(dir, 'feed'), { recursive: true });
    const log = openSync(join(dir, 'feed', 'auto.log'), 'a');
    const child = (deps.spawn ?? nodeSpawn)(deps.runtime ?? process.execPath, [script, dir], { detached: true, stdio: ['ignore', log, log] });
    child.unref();
    return done({ started: true, ...(child.pid ? { pid: child.pid } : {}) });
  } catch {
    return done({ started: false, reason: 'spawn-failed' });
  }
}
