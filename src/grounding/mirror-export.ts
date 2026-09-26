/** 레지스트리의 local-repo 출처를 거울 목록으로 결정적으로 만든다.
 *
 *  upstream 은 `readOrigin(path)`(기본 `git -C <path> remote get-url origin`).
 *  자격·사설·금지 경로는 `validateMirrorManifest` 가 거절한다.
 *  upstream 없는 로컬 전용은 출처에 `mirror: true` 가 있을 때만 넣는다.
 */
import { spawnSync } from 'node:child_process';
import { debug } from '../debug/log.js';
import {
  renderMirrorList,
  validateMirrorManifest,
  type MirrorAccepted,
  type MirrorManifestEntry,
  type MirrorRefused,
} from './mirror-manifest.js';
import type { GroundingSource } from './sources.js';

export interface MirrorExportResult {
  readonly list: string;
  readonly accepted: MirrorAccepted[];
  readonly refused: MirrorRefused[];
}

export interface ExportMirrorManifestOptions {
  /** 실패(비-0·타임아웃·경로 없음)는 `undefined`. 생략하면 실제 git origin. */
  readOrigin?: (path: string) => string | undefined;
}

const LOCAL_ONLY_NOT_OPTED_IN = 'local-only-not-opted-in';
const ID_COLLISION = 'id-collision-after-lowercase';

/** 거울 id 는 소문자만 받는다(`mirror-manifest` ID_RE) — 디렉터리 이름(`AppCUI-rs`·`crewAI`)을 소문자로 맞춘다.
 *  2026-09-27 실배치: 대문자 이름 12개가 `bad-id` 로 빠졌다. 소문자로 겹치면 둘 다 싣지 않고 거부한다(어느 쪽이 맞는지 모른다). */
function mirrorId(id: string): string {
  return id.toLowerCase();
}

export function exportMirrorManifest(
  sources: readonly GroundingSource[],
  options: ExportMirrorManifestOptions = {},
): MirrorExportResult {
  const readOrigin = options.readOrigin ?? gitOrigin;
  const entries: MirrorManifestEntry[] = [];
  const refused: MirrorRefused[] = [];
  const lowered = new Map<string, number>();
  for (const source of sources) {
    if (source.kind === 'local-repo') lowered.set(mirrorId(source.id), (lowered.get(mirrorId(source.id)) ?? 0) + 1);
  }
  for (const source of sources) {
    if (source.kind !== 'local-repo') continue;
    const id = mirrorId(source.id);
    if ((lowered.get(id) ?? 0) > 1) {
      refused.push({ id: source.id, reason: ID_COLLISION });
      continue;
    }
    const path = source.path;
    const upstream = path ? readOrigin(path) : undefined;
    if (upstream) {
      entries.push({ id, upstream, ...(path ? { path } : {}) });
      continue;
    }
    if (source.mirror !== true) {
      refused.push({ id: source.id, reason: LOCAL_ONLY_NOT_OPTED_IN });
      continue;
    }
    entries.push({ id, ...(path ? { path } : {}), localOnly: true });
  }
  const validated = validateMirrorManifest(entries);
  const result: MirrorExportResult = {
    list: renderMirrorList(validated.accepted),
    accepted: validated.accepted,
    refused: [...refused, ...validated.refused],
  };
  debug.log('grounding.mirror', 'exported', {
    accepted: result.accepted,
    refused: result.refused,
  });
  return result;
}

function gitOrigin(repoPath: string): string | undefined {
  const result = spawnSync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.status !== 0) return undefined;
  const url = (result.stdout ?? '').trim();
  return url.length > 0 ? url : undefined;
}
