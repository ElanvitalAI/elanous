// elanous S3 storage helper — single SoT for S3 paths + transfer.
//
// Design (2026-05-09):
//
// Folder layout under `s3://<bucket>/<root>/`:
//
//   elanous/<elanous_id>/                      — per-machine partition
//   ├── notes-metrics/
//   │   └── day-buckets.json               — Phase A (R6 day-bucket persistence)
//   ├── ocr-prefs/
//   │   └── settings.json                  — Phase B candidate (Settings default)
//   ├── sessions/                          — future (cross-device session sync)
//   └── reflection-history/                — future (durable Hansei archive)
//
// Why elanous_id partition first (not feature first):
//   - Each device (Mac · iPad · iPhone) has its own elanous_id (`~/.elanous/
//     identity.json`). Cross-device merge is intentionally future work —
//     conflict resolution requires a vector-clock or a dedicated sync
//     authority (separate track). Per-machine partition keeps each device's
//     data clean + recoverable independently.
//   - `aws s3 sync s3://bucket/monad/<elanous_id>/` cleanly backs up one
//     machine; `aws s3 rm --recursive` cleanly purges one machine's state.
//
// Buckets (2026-09-26 · 🚨 대화 원문이 공개 버킷에 올라가던 사고의 수리):
//   ⛔ 기본 버킷은 «없다». 설정하지 않으면 올리지 않는다(새 설치·공개 사용자가 남의 버킷을 부르지 않게).
//   - 비공개 버킷 = 기본. 세션·기억 보관·지표 등 «모든» 기능.
//       env `AWS_S3_BUCKET` → config `storage.s3.bucket`
//   - 공개 버킷 = «공개 링크를 만드는» 기능만(`PUBLIC_FEATURE_SEGMENTS`: 게시·아침 보고·디버그 묶음).
//       env `AWS_S3_PUBLIC_BUCKET` → config `storage.s3.publicBucket`
//   어느 버킷으로 갈지는 «키»가 정한다(`bucketForKey`) — 호출자는 키만 넘긴다.
//   AWS_S3_ELANOUS_PREFIX     — top-level prefix. Default 'elanous'.
//   ELANOUS_S3_DISABLED=1     — opt-out (force local-only mode for dev /
//                             airplane / fresh-install).
//
// Transport: shells out to `aws s3 cp` (same pattern as yt-vault) — no
// SDK dep, leverages the user's already-configured credentials. The
// helper times out at 60s for upload, 30s for download · failures are
// surfaced as thrown Errors so callers can degrade to local-only mode.

import { execSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getOrCreateElanousId } from '../mss/identity-store.js';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { debug } from '../debug/log.js';

let _awsBin: string | undefined;
/** aws CLI 실행 경로 — 데몬(launchd)의 제한 PATH 에 homebrew/local bin 이 없어도
 *  찾도록 알려진 설치 경로를 우선 탐색한다(못 찾으면 PATH fallback 'aws'). 1회 캐시.
 *  근본: launchd 는 로그인 셸 PATH(/opt/homebrew/bin 등)를 안 물어 `aws` ENOENT →
 *  isS3Available false → S3 전 기능(게시 공개·백업·크론)이 데몬 경유 시 조용히 죽던 문제. */
export function awsBin(): string {
  if (_awsBin !== undefined) return _awsBin;
  const candidates = ['/opt/homebrew/bin/aws', '/usr/local/bin/aws', '/usr/bin/aws'];
  _awsBin = candidates.find((c) => { try { return existsSync(c); } catch { return false; } }) ?? 'aws';
  return _awsBin;
}

const DEFAULT_PREFIX = 'monad';
const UPLOAD_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;

/** Folder-structure constants — single source of truth for which
 *  feature owns which subprefix. New features should add a constant
 *  here rather than constructing the path inline. */
export const S3_FEATURE_PREFIXES = {
  /** Phase A · day-bucket counts (R6 reflection durability). */
  notesMetrics: 'notes-metrics',
  /** Phase B candidate · OCR provider Settings prefs. */
  ocrPrefs: 'ocr-prefs',
  /** Future · cross-device session metadata sync. */
  sessions: 'sessions',
  /** Future · Hansei reflection archive (durable beyond bucket trim). */
  reflectionHistory: 'reflection-history',
  /** RFC #2161 FU A7 · latest discovery snapshot (overwrites `latest.json` on every run). */
  discoveryCache: 'discovery-cache',
  /** RFC #2161 FU A7 · append-only per-run snapshots keyed by ISO timestamp · audit trail. */
  discoveryHistory: 'discovery-history',
  /** Stage B debug bundle (2026-05-18) · symptom + iOS DebugLogger buffer + daemon log
   *  trail uploaded for cross-LLM analysis. Public-read · no TTL. */
  debugBundle: 'debug-bundle',
  /** M2 memory Glacier(2026-07-08) · cold(흐려진) 기억을 아카이브. 로컬 events 에서
   *  빠지고 여기 영속 → 회상 시 on-demand 느린 복원(삭제 아님). */
  memoryArchive: 'memory-archive',
  /** 롱콘텐츠 spill(2026-07-10) · 메신저/챗에 너무 긴 메시지·자료를 업로드하고 링크로
   *  대체(전 surface 공용). public-read·content-hash 키(동일 내용 dedupe). */
  spill: 'spill',
  /** 종합 아침 브리핑 상세 리포트(2026-07-10) · 에센셜은 텔레그램, 풀 디테일(md+html)은
   *  여기 date-키(`<date>.md`·`<date>.html`)로 적재하고 링크만 브리핑에 첨부. */
  morning: 'morning',
  /** Retained advertising assets. */
  adAssets: 'ad-assets',
} as const;

export type S3FeatureKey = keyof typeof S3_FEATURE_PREFIXES;

export interface S3Config {
  /** 비공개 버킷(기본 목적지) — 비어 있으면 비공개 기능은 올리지 않는다. */
  bucket: string;
  /** 공개 링크용 버킷 — 비어 있으면 공개 게시는 링크 없이 로컬로만. */
  publicBucket: string;
  prefix: string;
  disabled: boolean;
}

/** 공개 링크를 «의도적으로» 만드는 기능의 키 조각 — 이 조각이 든 키만 공개 버킷으로 간다. 나머지는 전부 비공개. */
export const PUBLIC_FEATURE_SEGMENTS = ['publish', 'publish-cold', 'morning', 'debug-bundle'] as const;

function configuredBuckets(): { bucket?: string; publicBucket?: string } {
  try {
    const raw = JSON.parse(readFileSync(join(getElanousConfigDir(), 'config.json'), 'utf8')) as { storage?: { s3?: { bucket?: unknown; publicBucket?: unknown } } };
    const s3 = raw?.storage?.s3;
    return {
      ...(typeof s3?.bucket === 'string' && s3.bucket.trim() ? { bucket: s3.bucket.trim() } : {}),
      ...(typeof s3?.publicBucket === 'string' && s3.publicBucket.trim() ? { publicBucket: s3.publicBucket.trim() } : {}),
    };
  } catch { return {}; }
}

export function s3Config(): S3Config {
  const cfg = configuredBuckets();
  return {
    bucket: process.env.AWS_S3_BUCKET?.trim() || cfg.bucket || '',
    publicBucket: process.env.AWS_S3_PUBLIC_BUCKET?.trim() || cfg.publicBucket || '',
    prefix: process.env.AWS_S3_ELANOUS_PREFIX?.trim() || DEFAULT_PREFIX,
    disabled: process.env.ELANOUS_S3_DISABLED === '1',
  };
}

/** 키가 공개 기능의 것인가 — 접두 다음 조각들 중 하나가 `PUBLIC_FEATURE_SEGMENTS` 면 공개. */
export function isPublicKey(key: string): boolean {
  return key.split('/').some((seg) => (PUBLIC_FEATURE_SEGMENTS as readonly string[]).includes(seg));
}

/** 이 키가 갈 버킷. 없으면 던진다 — 호출자는 이미 실패를 받아 로컬로 물러난다(«조용히 공개 버킷으로» 가지 않는다). */
export function bucketForKey(key: string): string {
  const cfg = s3Config();
  const bucket = isPublicKey(key) ? cfg.publicBucket : cfg.bucket;
  if (!bucket) {
    const which = isPublicKey(key) ? 'storage.s3.publicBucket(AWS_S3_PUBLIC_BUCKET)' : 'storage.s3.bucket(AWS_S3_BUCKET)';
    try { debug.log('s3.bucket', 'not-configured', { which, publicKey: isPublicKey(key) }); } catch { /* 관측 실패가 흐름을 막지 않는다 */ }
    throw new Error(`S3 버킷이 설정되지 않았다: ${which}`);
  }
  return bucket;
}

/** Build the canonical S3 key for a per-machine artifact. */
export function s3ElanousKey(feature: S3FeatureKey, ...subpath: string[]): string {
  const cfg = s3Config();
  const elanousId = getOrCreateElanousId();
  const featurePrefix = S3_FEATURE_PREFIXES[feature];
  const parts = [cfg.prefix, elanousId, featurePrefix, ...subpath].filter(Boolean);
  return parts.join('/');
}

/** Build the s3:// URI from a key. */
export function s3Uri(key: string): string {
  return `s3://${bucketForKey(key)}/${key}`;
}

/** Build the public HTTPS URL for an object. Virtual-hosted style
 *  (`https://<bucket>.s3.amazonaws.com/<key>`) — AWS DNS-redirects to
 *  the bucket's home region, so no region lookup needed. The caller
 *  is responsible for ensuring the bucket's policy (or per-object ACL)
 *  makes the key actually publicly readable; for `elanvital-public`
 *  the bucket-wide public-read policy handles this. */
/** S3 공개 버킷 base URL(https) — 외부 공개 게시의 canonical origin 용
 *  (렌더러가 canonical URL 을 HTTPS 로 요구하므로 localhost origin 은 못 씀). */
export function s3PublicBase(): string {
  const bucket = s3Config().publicBucket;
  if (!bucket) throw new Error('S3 공개 버킷이 설정되지 않았다: storage.s3.publicBucket(AWS_S3_PUBLIC_BUCKET)');
  return `https://${bucket}.s3.amazonaws.com`;
}

export function s3PublicUrl(key: string): string {
  return `${s3PublicBase()}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/** Synchronous CLI check — does the user actually have `aws` on PATH
 *  and credentials wired? Cached after first call so the boot path
 *  doesn't pay the cost N times. Returns false when:
 *   - aws CLI missing
 *   - AWS_S3_DISABLED=1
 *   - `aws sts get-caller-identity` fails (no credentials)
 *
 *  Callers gate every S3 op on this and degrade to local-only on
 *  false. The check itself swallows errors. */
let cliAvailable: boolean | null = null;
export function isS3Available(): boolean {
  if (cliAvailable !== null) return cliAvailable;
  const cfg = s3Config();
  if (cfg.disabled || (!cfg.bucket && !cfg.publicBucket)) {
    // 버킷이 하나도 없으면 S3 를 안 쓴다(기본 버킷 없음 · 2026-09-26).
    cliAvailable = false;
    return false;
  }
  try {
    execFileSync(awsBin(), ['sts', 'get-caller-identity', '--output', 'text'], {
      timeout: 5_000,
      stdio: 'pipe',
    });
    cliAvailable = true;
  } catch (e) {
    cliAvailable = false;
    // ★ 관측(제1원칙) — 조용히 false 로 죽던 근본 진단 가능하게. aws 미탐/크레덴셜 실패 구분.
    debug.log('s3.cli', 'unavailable', { bin: awsBin(), error: (e as Error).message?.slice(0, 160) });
  }
  return cliAvailable;
}

/** Test-only — reset the cached availability flag. Production code
 *  never calls this. */
export function __resetS3AvailabilityCache(): void {
  cliAvailable = null;
}

/** Upload a local file to S3. Throws on failure. Caller catches +
 *  degrades. */
export function uploadFile(localPath: string, key: string): void {
  if (!existsSync(localPath)) {
    throw new Error(`upload: local file missing: ${localPath}`);
  }
  const uri = s3Uri(key);
  // execSync (not execFile) so the shell quoting matches yt-vault's
  // proven pattern.
  execSync(`${awsBin()} s3 cp "${localPath}" "${uri}" --quiet`, {
    timeout: UPLOAD_TIMEOUT_MS,
    stdio: 'pipe',
  });
}

/** Upload in-memory text to S3 (no temp file — stdin via `aws s3 cp -`).
 *  Sets Content-Type so browsers render inline. Throws on failure. */
export function uploadText(text: string, key: string, contentType = 'text/plain; charset=utf-8'): void {
  execSync(`${awsBin()} s3 cp - "${s3Uri(key)}" --content-type "${contentType}" --quiet`, {
    timeout: UPLOAD_TIMEOUT_MS,
    input: text,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Download an S3 object to a local file. Throws on failure. Caller
 *  is expected to catch + degrade (for cold-start: "no remote yet"
 *  is not an error condition). */
export function downloadFile(key: string, localPath: string): void {
  const uri = s3Uri(key);
  execSync(`${awsBin()} s3 cp "${uri}" "${localPath}" --quiet`, {
    timeout: DOWNLOAD_TIMEOUT_MS,
    stdio: 'pipe',
  });
}

/** Returns true when the object exists. False on any error (incl.
 *  not-found, network, no creds). Cheap probe — `aws s3 ls` returns
 *  exit 1 + empty stderr for missing keys. */
export function objectExists(key: string): boolean {
  if (!isS3Available()) return false;
  try {
    const out = execSync(`${awsBin()} s3 ls "${s3Uri(key)}"`, {
      timeout: 10_000,
      stdio: 'pipe',
    }).toString();
    return out.trim().length > 0;
  } catch {
    return false;
  }
}
