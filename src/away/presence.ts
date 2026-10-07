import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { effectiveInstanceRoot } from '../instance/resolve.js';

/** AWAY-MODE-1 — 대표가 자리를 비웠나. 한 파일(`<instance>/presence.json`)이 정본이고 CLI·텔레그램 /away 가 같이 쓴다. */
export interface Presence {
  away: boolean;
  /** 마지막으로 바꾼 시각(ISO). 한 번도 안 바꿨으면 없음. */
  since?: string;
  /** 누가 바꿨나 — cli · telegram · pwa. */
  by?: string;
}

export function presencePath(root: string = effectiveInstanceRoot()): string {
  return join(root, 'presence.json');
}

/** 못 읽으면 «자리에 있음»으로 읽는다 — 외출 알림은 켠 사람만 받는다. */
export function readPresence(path: string = presencePath()): Presence {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object') return { away: false };
    const rec = value as Partial<Presence>;
    return {
      away: rec.away === true,
      ...(typeof rec.since === 'string' ? { since: rec.since } : {}),
      ...(typeof rec.by === 'string' ? { by: rec.by } : {}),
    };
  } catch { return { away: false }; }
}

export function writePresence(away: boolean, by: string, opts: { path?: string; now?: Date } = {}): Presence {
  const path = opts.path ?? presencePath();
  const presence: Presence = { away, since: (opts.now ?? new Date()).toISOString(), by };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(presence)}\n`);
  renameSync(tmp, path);
  return presence;
}
