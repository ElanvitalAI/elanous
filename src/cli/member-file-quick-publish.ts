// OP #117916 MEMBER-FILE-QUICK-PUBLISH — 생성 파일 하나를 공개 버킷 members/<handle>/public/<YYYYMMDD>/<이름-sha12>.<ext> 로
// 올리고 https 링크를 돌려주는 한 명령. 기존 src/storage/object-store.ts 의 put/publicUrl 을 그대로 재사용한다(새 옵션 0 · 수정 금지).
// 테스트 계정만 게시(fail-closed) · 허용 형식 txt/md/pdf · Content-Type 정확(inline 렌더) · 100MiB 상한 · 원장 1줄.
// JUD-B #39393 mustFix ①②③④(1차): put 전 내용 사전 검사(자격 패턴 스캔 · 매직 바이트 · UTF-8) ·
// 공개 네임스페이스는 members/<handle>/public/<YYYYMMDD>/ 형태만 · 대상 공개 버킷은 허용 목록에 결속(fail-closed).
// JUD-B #39393 hold(11:52) mustFix ①②③(2차): ① 실제로 올라간 바이트에 상한 집행(stat 아님) ·
// ② 내부데이터(elanous 내부 경로·식별자) 사전 검사 완결 + 지원 바이너리(pdf/png/jpg) 검사 방식 정의 —
//    전 바이트를 latin1 로 펴서 자격·내부 마커를 스캔한다(바이너리 예외 없음), 형식 매직 접두가 확장자와 일치해야 한다.
// ③ 실제 업로더 신원을 데모 전용 objectCreator IAM 에 결속 — 대상 버킷 허용 목록만으론 IAM 을 검증하지 못한다.
// JUD-B #39393 hold(12:36) mustFix ①②(3차): ① 실제 업로드 주체·대상 버킷을 '짝으로' 결속 —
//    설정 계정 라벨과 독립 허용 목록(버킷만·신원만)은 실효 업로더와 그 권한을 증명하지 못한다:
//    런타임 실제 주체(활성 gcloud 계정·aws STS ARN·azure 사용자·local)와 대상 공개 버킷이
//    storage.memberFilePublish.objectCreatorGrants 의 { principal, bucket } 짝 중 하나와 모두 일치해야만 올린다
//    (fail-closed · 짝 없음/주체 해석 실패/빈 목록 = 전부 거부).
// ② 발행 형식을 신뢰성 있게 검사 가능한 것으로 제한 — 원바이트 latin1 스캔은 압축 PDF 스트림(FlateDecode)의
//    내용을 볼 수 없다: pdf/png/jpg 발행을 없애고 txt/md(엄격 UTF-8 전체 디코드)만 게시한다(fail-closed).
// OP #118856(4차 · #39393 JUD 필수 2 처방): ① pdf 도 게시한다 — pdf-parse(기존 의존성)로 텍스트를 추출해
//    같은 패턴(자격·내부데이터) 스캔을 통과해야 하고 추출 실패 = 거부(fail-closed). png/jpg 는 여전히 금지.
// ② IAM 결속을 짝 대조에서 런타임 검증으로 완결 — 실제 업로드 principal 이 대상 버킷에서 objectCreator
//    역할만 갖는지 버킷 IAM 정책 조회(gcloud storage buckets get-iam-policy)로 확인하고 그 결과(주체·역할)를
//    업로드 원장 1줄에 기록한다. 조회 실패·주체 부재·역할 과다 = 전부 거부(fail-closed).
// JUD hold(13:06) mustFix ① + OP #119090(5차): 위 런타임 IAM 조회는 objectCreator 전용 업로더가 getIamPolicy 권한이
//    없어 최소권한 게시 경로에서 결코 통과하지 못한다. 대신 권한 있는 주체(RES)가 설치 시 1회 버킷 IAM 정책을 조회해
//    증거 파일(configDir/member-file-iam-evidence.json·0600: principal·bucket·roles·policyHash·at)으로 남기고,
//    런타임은 그 주체·버킷 일치·역할 단독·신선함(7일)을 검증한다(부재·파손·불일치·역할 과다·만료 = 전부 거부).
// JUD hold(14:57) mustFix ①②(⑦차): ① GCS 신원 해석(⑰ print-identity-token)과 업로드(object-store gcloud storage cp)를
//    같은 ADC 자격에 결속 — 업로드는 resolveAccessToken 이 해석한 ADC 파생 접근 토큰(configDir 안 0600 임시 파일 →
//    gcsAccessTokenFile 옵션 → --access-token-file)으로만 서명한다(앰비언트 gcloud 자격 사용 안 함).
// ② 증거 봉인을 대칭 HMAC seal 키에서 RES 전용 Ed25519 서명으로 바꾼다 — 발행자는 검증 공개 키만 읽는다(서명 권한 분리).
// JUD hold(16:0x) mustFix ①②③(⑧차): ① 신원(print-identity-token)과 접근 토큰(print-access-token)을 '같은 ADC 자격
//    인스턴스'에서 도출한다 — 원본 ADC 를 실행별 비공개 스냅샷(mkdtemp 0700 + O_EXCL 0600)으로 딱 한 번 읽어
//    CLOUDSDK_CONFIG+GOOGLE_APPLICATION_CREDENTIALS 로 핀하고 두 gcloud 호출이 그 인스턴스에서만 나오게 한다(앰비언트 재해석 폐지).
// ② 접근 토큰 저장도 실행별 배타 — 고정 경로(configDir) 재사용 금지, mkdtemp(0700)+O_EXCL(0600) 생성·put 성패 무관 finally 정리.
// ③ 증거 검증 공개 키의 원천을 env/config 덮어쓰기에서 폐지하고 RES 운영 고정 경로만 믿는다 — 정규 파일(lstat·심볼릭 링크 금지)·
//    쓰기 비트 전부 0(0444 계열)·열어 쓰기 시도가 EACCES/EPERM 으로 실패하는 것으로 '발행 자리가 못 바꾼다'를 코드 검사로 증명(⑳).
// 이 파일은 순수하게 유지한다: 시계·파일 시스템·저장소·원장·신원 해석은 모두 주입 가능하다(IAM 결속 증거는 파일 검증 — 주입 아님).
import { execFileSync } from 'node:child_process';
import { closeSync, constants, lstatSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { createHash, createPublicKey, timingSafeEqual, verify, type KeyObject } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import type { Command } from 'commander';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { HANDLE_PATTERN } from '../nexus/members/member-handle-suggest.js';
import { createObjectStore, readRawConfig, resolveStorageConfig, type ObjectStore, type StorageConfig } from '../storage/object-store.js';

export const MEMBER_FILE_MAX_BYTES = 104_857_600; // 100 MiB
/** JUD-B #39393 hold(12:36) mustFix ② + OP #118856 ① — 검사 가능한 형식만 게시한다.
 *  txt/md: 전 바이트 latin1 스캔 + 엄격 UTF-8 전체 디코드. pdf: pdf-parse(기존 의존성) 텍스트 추출 → 같은 패턴 스캔
 *  (추출 실패 = 거부). png/jpg 는 압축 스트림을 신뢰성 있게 검사할 방법이 없어 여전히 제외. */
export const MEMBER_FILE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  pdf: 'application/pdf',
};
export const MEMBER_FILE_LEDGER_NAME = 'member-file-publish.jsonl';

/** JUD-B #39393 mustFix ① — put 전 내용에서 찾는 자격(credential) 형태. 하나라도_hit 하면 거부(fail-closed). */
const MEMBER_FILE_CREDENTIAL_PATTERN =
  /AKIA[0-9A-Z]{16}|-----BEGIN[A-Z ]*PRIVATE KEY-----|"type"\s*:\s*"service_account"|\bya29\.[0-9A-Za-z_-]{10,}|\bAIza[0-9A-Za-z_-]{30,}/;

/** JUD-B #39393 hold(11:52) mustFix ② — elanous 내부 경로·식별자(내부데이터). 하나라도 있으면 거부(fail-closed).
 *  txt/md 는 물론 지원 바이너리(pdf/png/jpg)도 전 바이트를 latin1 로 펴서 같이 스캔한다(아래 검사 정의 참조). */
const MEMBER_FILE_INTERNAL_PATTERN =
  /elanous-hq|seat-state|\.elanous\b|gs:\/\/elanous|\.monad-agent\b|\/Users\/user|\/home\/user/;

/** 발행 전 내용 검사 방식 정의(JUD-B #39393 1차 ②·hold(12:36) ②·OP #118856 ①):
 *  전 형식 공통 — 전 바이트를 latin1 로 펴서 자격 패턴과 내부 마커를 스캔한다(바이너리 예외 없음).
 *  txt/md 는 엄격 UTF-8 전체 디코드까지 통과해야 한다. pdf 는 원바이트 스캔이 압축 스트림(FlateDecode)을 못 보므로
 *  pdf-parse 로 텍스트를 추출해 같은 패턴을 다시 스캔한다(추출 실패 = 거부). png/jpg 는 발행 자체를 금한다. */

/** 이 명령이 만드는 사용자 대면 오류만 — CLI 는 이 클래스의 메시지만 그대로 보여준다. */
export class MemberFilePublishError extends Error {}

export interface PublishMemberFileResult {
  handle: string;
  key: string;
  url: string;
  bytes: number;
  contentType: string;
}

export interface MemberFilePublishDeps {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  statImpl?: (path: string) => { isFile(): boolean; size: number };
  readFile?: (path: string) => Uint8Array;
  /** 미주입 시 resolveStorageConfig 로 만든 실 저장소(gcloud 부름). */
  store?: ObjectStore;
  appendLedger?: (configDir: string, line: string) => void;
  /** JUD-B hold ③ — 업로더 신원 해석(aws STS ARN·azure 사용자·'local'. gcs 는 ⑧차 ① 자격 결속으로 이관). 미주입 시 원격 CLI 해석, 실패 시 null. */
  resolveIdentity?: (cfg: StorageConfig) => string | null;
  /** JUD hold(16:0x) ⑧차 ① — gcs 업로드가 서명할 '같은 ADC 자격 인스턴스' 해석(신원 principal + 접근 토큰). 미주입 시 defaultResolveUploadCredential, 실패·gcs 외 = null. */
  resolveUploadCredential?: (cfg: StorageConfig) => GcsUploadCredential | null | Promise<GcsUploadCredential | null>;
  /** JUD hold(16:0x) ⑧차 ③ — 증거 검증 공개 키의 RES 운영 고정 경로(기본 defaultMemberFileEvidencePubkeyPath). env/config 원천은 폐지됐다. */
  resEvidencePublicKeyPath?: string;
  /** JUD hold ⑨차(#121287) · OP #121289 — 고정 검증 키: 검증 공개 키 파일 내용(SPKI DER)의 sha256 지문 핀(기본 MEMBER_FILE_EVIDENCE_PUBKEY_SHA256). 시험 주입용 — 프로덕션은 상수 기본값만 쓴다(키 교체 = 코드 변경). */
  resEvidencePubkeySha256?: string;
}

interface ObjectCreatorGrant { principal: string; bucket: string }
interface MemberFilePublishRaw { storage?: { memberFilePublish?: { testHandles?: unknown; objectCreatorGrants?: unknown; evidencePublicKey?: unknown } } }
/** OP #119090(5차) — RES 가 설치 시 1회 조회해 남기는 버킷 IAM 증거 파일 이름(configDir 안·0600).
 *  JUD hold(13:33) mustFix ① — ⑥차: 이 파일은 RES 만 쓸 수 있는 보호 출원이어야 한다(정규 파일·소유자 0600·seal 봉인 검증). */
export const MEMBER_FILE_IAM_EVIDENCE_NAME = 'member-file-iam-evidence.json';
/** OP #119090(5차) — 증거의 신선함 상한. 조회 시각(at)이 이 창(7일)을 벗어나면 만료로 거부한다(fail-closed). */
export const MEMBER_FILE_IAM_EVIDENCE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** JUD hold(16:0x) ⑧차 ② — ⑦차의 고정 경로 토큰 파일(member-file-upload-token.tmp)은 폐지: 접근 토큰 저장은
 *  실행별 비공개 배타 디렉터리(mkdtemp 0700 → 그 안 O_EXCL 0600 토큰 파일)로만 하고 put 성패 무관 finally 정리한다. */
/** OP #119090(5차) — 버킷 IAM 증거: 권한 있는 주체(RES)가 gcloud storage buckets get-iam-policy 로 이 업로더
 *  주체가 이 버킷에서 가진 역할 전부를 조회해 남긴 것(원본 정책은 sha256 policyHash 로 대조). */
export interface MemberFileIamEvidence {
  /** JUD hold(14:57) ⑦차 ② — 본문 정규 직렬을 RES 전용 Ed25519 개인 키로 서명한 base64. 검증은 공개 키만(서명 권한 분리) —
   *  위조·평문·대칭(HMAC hex) 봉인 증거는 전부 거부(⑯ ⑷⑸⑸b). */
  seal: string;
  /** 업로더 주체(ADC 실증명 주체·aws STS ARN·azure 사용자·'local'). */
  principal: string;
  /** 결속 대상 공개 버킷. */
  bucket: string;
  /** 이 주체가 이 버킷에서 가진 역할 전부 — objectCreator 단독이어야만 게시된다. */
  roles: string[];
  /** 조회한 정책 원문의 sha256(감사 대조용). */
  policyHash: string;
  /** 조회 시각(ISO 8601) — 신선성 검사 대상. */
  at: string;
}


/** configDir/config.json 의 storage.memberFilePublish.testHandles ⊕ env ELANOUS_MEMBER_FILE_TEST_HANDLES(쉼표 구분) — 합집합, 비면 전부 거부. */
export function allowedTestHandles(configDir: string, env: NodeJS.ProcessEnv): Set<string> {
  const out = new Set<string>();
  const raw = readRawConfig(join(configDir, 'config.json')) as MemberFilePublishRaw | null;
  const list = raw?.storage?.memberFilePublish?.testHandles;
  if (Array.isArray(list)) {
    for (const handle of list) if (typeof handle === 'string' && handle.trim()) out.add(handle.trim());
  }
  const fromEnv = typeof env.ELANOUS_MEMBER_FILE_TEST_HANDLES === 'string' ? env.ELANOUS_MEMBER_FILE_TEST_HANDLES : '';
  for (const handle of fromEnv.split(',')) if (handle.trim()) out.add(handle.trim());
  return out;
}

/** JUD-B #39393 hold(12:36) mustFix ① — 데모 전용 objectCreator 결속: config storage.memberFilePublish.objectCreatorGrants
 *  [{ principal, bucket }] ⊕ env ELANOUS_MEMBER_FILE_PUBLISH_OBJECT_CREATOR_GRANTS('principal,bucket;principal,bucket').
 *  런타임 실제 업로드 주체와 대상 공개 버킷이 짝으로 여기 결속돼 있어야만 올릴 수 있다(fail-closed · 빈 목록 = 전부 거부).
 *  주체만·버킷만의 독립 허용 목록으로는 실효 업로더와 그 권한을 증명하지 못한다(3차 hold ①). */
export function objectCreatorGrants(configDir: string, env: NodeJS.ProcessEnv): ObjectCreatorGrant[] {
  const grants: ObjectCreatorGrant[] = [];
  const raw = readRawConfig(join(configDir, 'config.json')) as MemberFilePublishRaw | null;
  const list = raw?.storage?.memberFilePublish?.objectCreatorGrants;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (typeof entry !== 'object' || entry === null) continue;
      const principal = (entry as Record<string, unknown>).principal;
      const bucket = (entry as Record<string, unknown>).bucket;
      if (typeof principal === 'string' && principal.trim() && typeof bucket === 'string' && bucket.trim()) {
        grants.push({ principal: principal.trim(), bucket: bucket.trim() });
      }
    }
  }
  const fromEnv = typeof env.ELANOUS_MEMBER_FILE_PUBLISH_OBJECT_CREATOR_GRANTS === 'string'
    ? env.ELANOUS_MEMBER_FILE_PUBLISH_OBJECT_CREATOR_GRANTS : '';
  for (const pair of fromEnv.split(';')) {
    const [principal, bucket] = pair.split(',');
    if (typeof principal === 'string' && principal.trim() && typeof bucket === 'string' && bucket.trim()) {
      grants.push({ principal: principal.trim(), bucket: bucket.trim() });
    }
  }
  return grants;
}

/** JUD-B #39393 hold(11:52) mustFix ③ — 런타임 실제 업로더 신원 해석.
 *  local → 'local'(파일 시스템 — IAM 없음·명시적 허용 필요) · s3/r2 → aws STS caller ARN · azure → az 사용자.
 *  gcs → ⑧차 ① 폐지(null): gcs 신원은 업로드 자격과 '같은 ADC 인스턴스'에서 defaultResolveUploadCredential 이 도출한다.
 *  해석 실패·빈 값 → null(=거부, fail-closed). */
export type SyncExec = (file: string, args: readonly string[]) => string;

/** JUD hold(13:33) mustFix ① — ⑰: gcloud identity token(JWT) 에서 이 업로드가 실제로 서명할 ADC 자격의
 *  주체(email)를 뽑는다. 서명·발급 경로는 gcloud→Google TLS 가 담당하고 여기선 payload 의 email/email_verified
 *  만 본다(파손·email 부재·미검증 = null → 게시 경로에서 거부). */
export function gcsAdcPrincipalFromIdentityToken(token: string): string | null {
  const parts = token.trim().split('.');
  if (parts.length < 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as Record<string, unknown>;
    if (payload.email_verified === false) return null;
    const email = typeof payload.email === 'string' ? payload.email.trim() : '';
    return email || null;
  } catch { return null; }
}

const defaultSyncExec: SyncExec = (file, args) => execFileSync(file, [...args], { encoding: 'utf8', timeout: 15_000 });

export function defaultResolveUploadIdentity(cfg: StorageConfig, exec: SyncExec = defaultSyncExec): string | null {
  if (cfg.provider === 'local') return 'local';
  try {
    // JUD hold(16:0x) ⑧차 ① — gcs 분기 폐지(null): gcs 신원은 업로드 자격과 '같은 ADC 자격 인스턴스'에서
    // defaultResolveUploadCredential(아래)이 신원·접근 토큰과 함께 도출한다. 여기서 gcs 를 따로 해석하지 않는다.
    if (cfg.provider === 's3' || cfg.provider === 'r2') {
      const args = ['sts', 'get-caller-identity', '--query', 'Arn', '--output', 'text'];
      if (cfg.s3?.profile) args.push('--profile', cfg.s3.profile);
      const out = exec('aws', args);
      return typeof out === 'string' && out.trim() ? out.trim() : null;
    }
    if (cfg.provider === 'azure') {
      const out = exec('az', ['account', 'show', '--query', 'user.name', '--output', 'tsv']);
      return typeof out === 'string' && out.trim() ? out.trim() : null;
    }
  } catch { /* 해석 실패 = fail-closed */ }
  return null;
}

/** JUD hold(16:0x) ⑧차 ① — gcs 업로드가 실제로 서명할 '같은 ADC 자격 인스턴스'에서 신원(principal)과 접근 토큰을
 *  함께 도출한다. 앰비언트 ADC 를 gcloud 호출마다 따로 재해석하지 않는다: 원본 ADC 파일(GOOGLE_APPLICATION_CREDENTIALS
 *  우선·없으면 CLOUDSDK_CONFIG|~/.config/gcloud 의 application_default_credentials.json)을 실행별 비공개 스냅샷
 *  (mkdtemp 0700 → 그 안 O_EXCL 0600)으로 딱 한 번 읽어 복사하고, 그 스냅샷 경로를 CLOUDSDK_CONFIG+
 *  GOOGLE_APPLICATION_CREDENTIALS 로 핀해 print-identity-token(⑰ 판정)과 print-access-token 이
 *  모두 그 인스턴스에서만 나오게 한다. 신원 판정 실패 = 접근 토큰을 해석하지 않고 null(fail-closed) ·
 *  해석 실패·빈 토큰 = null · gcs 외 = null(결속 대상 아님) · 스냅샷은 finally 정리(⑲a). */
export interface GcsUploadCredential { principal: string; accessToken: string }
/** ⑧차 ① — 핀 경로가 담긴 env 로 CLI 를 부르는 동반자(주입 가능). */
export type EnvSyncExec = (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => string;

const defaultEnvSyncExec: EnvSyncExec = (file, args, env) => execFileSync(file, [...args], { encoding: 'utf8', timeout: 15_000, env });

export function defaultAdcCredentialPath(env: NodeJS.ProcessEnv): string {
  const gac = typeof env.GOOGLE_APPLICATION_CREDENTIALS === 'string' ? env.GOOGLE_APPLICATION_CREDENTIALS.trim() : '';
  if (gac) return gac;
  const configRoot = typeof env.CLOUDSDK_CONFIG === 'string' && env.CLOUDSDK_CONFIG.trim() ? env.CLOUDSDK_CONFIG.trim() : join(homedir(), '.config', 'gcloud');
  return join(configRoot, 'application_default_credentials.json');
}

export function defaultResolveUploadCredential(
  cfg: StorageConfig,
  opts: { env?: NodeJS.ProcessEnv; adcCredentialPath?: () => string; exec?: EnvSyncExec } = {},
): GcsUploadCredential | null {
  if (cfg.provider !== 'gcs') return null;
  const env = opts.env ?? process.env;
  const exec = opts.exec ?? defaultEnvSyncExec;
  const snapshotDir = mkdtempSync(join(tmpdir(), 'mf-adc-')); // 실행별 비공개(0700)
  try {
    const source = (opts.adcCredentialPath ?? (() => defaultAdcCredentialPath(env)))();
    const instance = readFileSync(source); // 자격 인스턴스를 한 번 읽는다 — 이후 해석은 전부 이 복제본에서만.
    const snapshotPath = join(snapshotDir, 'application_default_credentials.json');
    writeFileSync(snapshotPath, instance, { flag: 'wx', mode: 0o600 }); // 배타 생성(O_EXCL — 있으면 실패)
    const pinned: NodeJS.ProcessEnv = { ...env, CLOUDSDK_CONFIG: snapshotDir, GOOGLE_APPLICATION_CREDENTIALS: snapshotPath };
    const principal = gcsAdcPrincipalFromIdentityToken(exec('gcloud', ['auth', 'application-default', 'print-identity-token'], pinned));
    if (!principal) return null; // 신원 판정 실패 = 접근 토큰 해석 없이 거부(fail-closed)
    const accessToken = exec('gcloud', ['auth', 'application-default', 'print-access-token'], pinned).trim();
    if (!accessToken) return null;
    return { principal, accessToken };
  } catch { return null; } finally { rmSync(snapshotDir, { recursive: true, force: true }); }
}

/** OP #118856 ② — 업로더 principal 이 대상 버킷에서 가져도 되는 유일한 역할. 이 외 역할이 하나라도 함께 있으면 거부. */
export const MEMBER_FILE_OBJECT_CREATOR_ROLE = 'roles/storage.objectCreator';

/** JUD hold ⑨차(#121287) · OP #121289 — 고정 검증 키(fixed verification key): RES 발행 공개 키(SPKI DER base64 파일)의
 *  sha256 지문(RES 우편 #121293 — sha256(SPKI DER 원바이트) hex). 공개 키 파일은 이 상수와 일치할 때만 검증에 쓴다:
 *  키 교체 = 이 상수 변경 = PR 리뷰 필요. 불일치·부재 = 그 파일은 RES 발행 키가 아니므로 거부(fail-closed).
 *  ⑧차 ③의 파일 권한 경계(정규 파일·쓰기 비트 0·쓰기 시도 EACCES)는 참고 경계로 유지되지만, 신뢰 기점은 이 지문 핀이다
 *  (JUD 9차 — leaf 권한 검사만으론 '운영자가 교체 불가'임이 성립하지 않는다). 지문은 공개 키 파생값이라 출력 안전(비밀 아님). */
export const MEMBER_FILE_EVIDENCE_PUBKEY_SHA256 = '51286c51c2f9cbfe30fe8e38f03ea2349b947c76dc14bd5e2990083423ee0882';

/** JUD hold(16:0x) ⑧차 ③ — 증거 검증 공개 키(RES 전용 Ed25519 개인 키의 공개 반쪽·SPKI DER base64)의 신뢰 기점은
 *  RES 운영 고정 경로뿐이다. ⑦차의 env(ELANOUS_MEMBER_FILE_EVIDENCE_PUBKEY)·config(evidencePublicKey) 덮어쓰기 원천은
 *  폐지했다 — 발행자(이 코드)가 닿아 바꿀 수 있는 곳에 두면 '서명 권한 분리'가 무의미해진다. 경계는 코드 검사로 증명한다:
 *  lstat 정규 파일(심볼릭 링크 금지) · 쓰기 권한 비트 전부 0(0444/0400 계열 — 0644/0600 도 거부: 소유자 쓰기 = 교체 가능) ·
 *  열어 쓰기 시도가 EACCES/EPERM 으로 실패해야 한다(열리면 ACL 등 우회 경로 = 신뢰 기점 아님 → 사용 거부).
 *  키 부재·빈 값·해석 실패 = 검증 자체가 불가능 → null(fail-closed). */
export function defaultMemberFileEvidencePubkeyPath(): string {
  return join(homedir(), 'elanous-hq', 'seat-state', 'RES', 'keys', 'member-file-evidence-pubkey.spki.b64');
}

/** ⑧차 ③ + ⑨차 — RES 운영 경로의 검증 공개 키 해석 + 경계 증명(mode·sha256 반환은 원장 기록용). 어느 하나라도 어긋나면 null(fail-closed).
 *  ⑨차(OP #121289) 고정 검증 키: 파일 내용(SPKI DER)의 sha256 지문이 핀(expectedSha256)과 timing-safe 일치해야만 사용 —
 *  권한 경계는 통과해도 내용이 RES 발행 키가 아니면(교체·몽키 패치) 거부. 키 부재·빈 값·해석 실패·지문 불일치 = null. */
function memberFileEvidencePublicKey(resPublicKeyPath: string, expectedSha256: string): { key: KeyObject; mode: number; sha256: string } | null {
  let info: ReturnType<typeof lstatSync>;
  try { info = lstatSync(resPublicKeyPath); } catch { return null; }
  if (!info.isFile()) return null;
  if ((info.mode & 0o222) !== 0) return null; // 쓰기 비트 전부 0 — 소유자든 아니든 이 실행이 교체할 수 있으면 신뢰 기점이 못 된다
  let writeProbe: number | undefined;
  try { writeProbe = openSync(resPublicKeyPath, constants.O_WRONLY); } catch { /* EACCES/EPERM = 쓰기 불가 증명 */ }
  if (writeProbe !== undefined) {
    try { closeSync(writeProbe); } catch { /* 닫기 실패는 무시 */ }
    return null; // 열린다 = 이 실행 사용자가 내용을 바꿀 수 있다 → 신뢰 기점 성립 안 함
  }
  let encoded = '';
  try { encoded = readFileSync(resPublicKeyPath, 'utf8').trim(); } catch { return null; }
  if (!encoded) return null;
  // ⑨차 — 파일 내용의 sha256 지문이 코드 상수 핀과 일치하는가(PEM 등 다른 인코딩은 지문이 절대 일치하지 않으므로 폐기).
  let der: Buffer;
  let actual = '';
  try {
    der = Buffer.from(encoded, 'base64');
    if (der.length === 0) return null;
    actual = createHash('sha256').update(der).digest('hex');
    const expectedBuf = Buffer.from(expectedSha256, 'utf8');
    const actualBuf = Buffer.from(actual, 'utf8');
    if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) return null; // 교체된 키 = 거부
  } catch { return null; }
  try { return { key: createPublicKey({ key: der, format: 'der', type: 'spki' }) as KeyObject, mode: info.mode & 0o777, sha256: actual }; }
  catch { return null; }
}

/** JUD hold(13:33) ① — 증거 본문의 정규 직렬. seal 계산(RES)과 검증(이 코드)이 같은 식으로 쓴다. */
export function memberFileIamEvidenceCanonical(ev: Omit<MemberFileIamEvidence, 'seal'>): string {
  return JSON.stringify({ principal: ev.principal, bucket: ev.bucket, roles: [...ev.roles].sort(), policyHash: ev.policyHash, at: ev.at });
}



/** ⑧차 ③ — readIamEvidence 결과: 검증 통과 증거 + 검증에 쓴 RES 공개 키 경로·mode(원장 기록 — 감사 대조용). */
export interface ReadIamEvidenceResult {
  evidence: MemberFileIamEvidence;
  pubkeyPath: string;
  pubkeyMode: string;
  /** ⑨차 — 검증에 실제로 쓴 공개 키 파일 내용의 sha256 지문(원장 감사 대조용 — 코드 상수 핀과 대사(對査) 가능). */
  pubkeySha256: string;
}

/** OP #119090(5차) + JUD hold(13:33) ① — 증거 파일(configDir/member-file-iam-evidence.json)을 읽어 이 업로드에 쓸 수
 *  있는지 검증한다. ⑥차 보호 출원 검증: lstat 정규 파일(심볼릭 링크 아님) + mode 0600(소유자만 rw) + 소유자가 현재
 *  실행 사용자 + 본문이 RES 전용 Ed25519 개인 키로 서명(seal 필드·base64·검증은 ⑧차 ③ RES 운영 경로의 공개 키만)돼야 통과.
 *  모양(주체·버킷·역할·policyHash·조회 시각) 갖춤 + 역할 objectCreator 단독 + 신선함(7일·1분 시계 오차)은 종전대로.
 *  어느 하나라도 어긋나면 null(=거부, fail-closed). */
export function readIamEvidence(configDir: string, now: Date, resPublicKeyPath: string, resPubkeySha256: string): ReadIamEvidenceResult | null {
  const publicKey = memberFileEvidencePublicKey(resPublicKeyPath, resPubkeySha256);
  if (!publicKey) return null;
  const evidencePath = join(configDir, MEMBER_FILE_IAM_EVIDENCE_NAME);
  let info: ReturnType<typeof lstatSync>;
  try { info = lstatSync(evidencePath); } catch { return null; }
  if (!info.isFile() || (info.mode & 0o777) !== 0o600) return null;
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid !== undefined && info.uid !== uid) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(evidencePath, 'utf8'));
  } catch { return null; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;
  const principal = typeof raw.principal === 'string' ? raw.principal.trim() : '';
  const bucket = typeof raw.bucket === 'string' ? raw.bucket.trim() : '';
  const roles = Array.isArray(raw.roles)
    ? raw.roles.filter((role): role is string => typeof role === 'string' && !!role.trim()).map(role => role.trim())
    : null;
  const policyHash = typeof raw.policyHash === 'string' ? raw.policyHash.trim() : '';
  const at = typeof raw.at === 'string' ? raw.at.trim() : '';
  const seal = typeof raw.seal === 'string' ? raw.seal.trim() : '';
  if (!principal || !bucket || roles === null || !policyHash || !at || !seal) return null;
  const atMs = Date.parse(at);
  const ageMs = now.getTime() - atMs; // 양수 = 과거에 조회(신선 창 안) · 음수 = 미래 시각(1분까지만 허용)
  if (Number.isNaN(atMs) || ageMs < -60_000 || ageMs > MEMBER_FILE_IAM_EVIDENCE_MAX_AGE_MS) return null;
  if (roles.length !== 1 || roles[0] !== MEMBER_FILE_OBJECT_CREATOR_ROLE) return null;
  // JUD hold(14:57) ⑦차 ② 서명 검증: 본문 정규 직렬을 RES 전용 Ed25519 개인 키로 서명한 값(base64)을 공개 키로 대조한다.
  // 발행자는 검증 공개 키만 읽으므로 서명 권한은 RES 에 분리돼 있다 — 위조·평문·대칭(HMAC hex) 봉인은 전부 대조 실패로 거부.
  const canonical = Buffer.from(memberFileIamEvidenceCanonical({ principal, bucket, roles, policyHash, at }), 'utf8');
  const signature = Buffer.from(seal, 'base64');
  let signed = false;
  try { signed = verify(null, canonical, publicKey, signature); } catch { signed = false; }
  if (!signed) return null;
  return {
    evidence: { seal, principal, bucket, roles, policyHash, at },
    // ⑧차 ③ — 검증에 쓴 RES 공개 키 경로·mode(octal)도 함께 돌려 원장에 남긴다(신뢰 기점 감사 대조).
    pubkeyPath: resPublicKeyPath,
    pubkeyMode: publicKey.mode.toString(8).padStart(4, '0'),
    // ⑨차 — 실제 검증에 쓴 파일 내용의 지문도 돌려 원장에 남긴다(코드 핀 상수와 대조하면 '같은 키로 검증했는지' 증명).
    pubkeySha256: publicKey.sha256,
  };
}

/** 파일 base명(확장자 뺀) → 소문자 [a-z0-9-] slug. [a-z0-9]+ 밖을 '-' 로 치환·연속 '-' 축약·앞뒤 '-' 제거, 빈 문자열이면 'file'. */
function slugifyBase(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'file';
}

/** now() 의 로컬 연월일 8자리. */
function localDateStamp(at: Date): string {
  return `${at.getFullYear()}${String(at.getMonth() + 1).padStart(2, '0')}${String(at.getDate()).padStart(2, '0')}`;
}

/** 원장 1줄 append(append-only · 0600). 기존 파일의 권한은 건드리지 않는다. */
function appendLedgerLine(configDir: string, line: string): void {
  const fd = openSync(join(configDir, MEMBER_FILE_LEDGER_NAME),
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600);
  try { writeSync(fd, `${line}\n`); } finally { closeSync(fd); }
}

export async function publishMemberFile(input: {
  configDir: string;
  filePath: string;
  handle: string;
  deps?: MemberFilePublishDeps;
}): Promise<PublishMemberFileResult> {
  const deps = input.deps ?? {};
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const statImpl = deps.statImpl ?? statSync;
  const readFile = deps.readFile ?? ((path: string) => new Uint8Array(readFileSync(path)));

  // 검증 순서(설계 확정): 핸들 모양 → 허용 핸들(fail-closed) → 파일 존재·regular → 크기 → 확장자
  //   → 자격·내부 스캔(mustFix ①·전 바이트 latin1) → 실제 바이트·형식(mustFix ②·UTF-8 / OP #118856 ① PDF 텍스트 추출 스캔)
  //   → 짝 결속(r3 ①) → 런타임 버킷 IAM objectCreator 검증·원장 기록(OP #118856 ②) → put → 원장 1줄.
  const handle = input.handle;
  if (!HANDLE_PATTERN.test(handle)) {
    throw new MemberFilePublishError('핸들이 올바르지 않습니다. 소문자 a-z 로 시작하는 3-20자(소문자·숫자)여야 합니다.');
  }
  if (!allowedTestHandles(input.configDir, env).has(handle)) {
    throw new MemberFilePublishError('이 핸들로는 게시할 수 없습니다. 테스트 계정 핸들만 게시할 수 있습니다.');
  }
  let stat: { isFile(): boolean; size: number };
  try {
    stat = statImpl(input.filePath);
  } catch {
    throw new MemberFilePublishError('파일을 찾을 수 없습니다.');
  }
  if (!stat.isFile()) throw new MemberFilePublishError('일반 파일만 게시할 수 있습니다.');
  if (stat.size > MEMBER_FILE_MAX_BYTES) throw new MemberFilePublishError('파일이 100MiB를 초과해 게시할 수 없습니다.');
  const ext = extname(input.filePath).slice(1).toLowerCase();
  const contentType = MEMBER_FILE_CONTENT_TYPES[ext];
  // JUD-B hold(12:36) ② + OP #118856 ① — 발행 형식: txt/md/pdf. pdf 는 아래 텍스트 추출 게이트를 통과해야 하고,
  // png/jpg 는 원바이트 스캔·추출 어느 쪽으로도 신뢰성 있게 검사할 수 없어 여전히 받지 않는다.
  if (!contentType) throw new MemberFilePublishError('지원하지 않는 형식입니다. txt, md, pdf 만 게시할 수 있습니다(내용을 신뢰성 있게 검사할 수 있는 형식만).');

  const bytes = readFile(input.filePath);

  // JUD-B #39393 hold(11:52) mustFix ① — 실제로 올라가는 바이트의 상한: stat 이 작아도 readFile 이 돌려준
  // 실제 바이트가 100MiB 를 넘으면 올리기 전에 거부한다(fail-closed · stat·read 사이 성장 포착).
  if (bytes.byteLength > MEMBER_FILE_MAX_BYTES) {
    throw new MemberFilePublishError('실제 파일 바이트가 100MiB를 초과해 게시할 수 없습니다.');
  }

  // JUD-B #39393 mustFix ① — 누출 스캔: put 전 실제 바이트에서 자격 형태를 찾는다.
  // ASCII 패턴이라 latin1 로 펴서 잡는다(바이너리도 예외 없이 — 인코딩 추정에 의존하지 않는다).
  const scanText = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
  if (MEMBER_FILE_CREDENTIAL_PATTERN.test(scanText)) {
    throw new MemberFilePublishError('파일 내용에서 자격(credential) 형태를 발견해 게시할 수 없습니다. 비밀이 아닌 값만 게시해 주세요.');
  }
  // JUD-B #39393 hold(11:52) mustFix ② — 내부데이터 스캔: elanous 내부 경로·식별자가 있으면 거부.
  // txt/md 는 물론 지원 바이너리(pdf/png/jpg)도 같은 전 바이트 latin1 스캔을 받는다(위 검사 방식 정의 참조).
  if (MEMBER_FILE_INTERNAL_PATTERN.test(scanText)) {
    throw new MemberFilePublishError('파일 내용에서 내부 데이터(elanous 내부 경로·식별자)를 발견해 게시할 수 없습니다.');
  }

  // JUD-B #39393 mustFix ② — 실제 바이트·형식 검증. txt/md 는 엄격 UTF-8 전체 디코드가 필수다.
  if (ext !== 'pdf') {
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch {
      throw new MemberFilePublishError('텍스트 파일이 UTF-8 이 아니어서 게시할 수 없습니다.');
    }
  } else {
    // OP #118856 ① — PDF 는 압축 스트림이므로 pdf-parse(기존 의존성)로 텍스트를 추출해 같은 패턴을 스캔한다.
    // 위 원바이트 latin1 스캔은 압축되지 않은 부분만 볼 수 있으므로 이 추출 스캔이 필수고, 추출 실패 = 거부(fail-closed).
    let pdfText: string | null = null;
    try {
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: new Uint8Array(bytes) });
      try {
        const result = await parser.getText();
        pdfText = result !== null && typeof result === 'object' && typeof result.text === 'string'
          && typeof result.total === 'number' && result.total > 0 ? result.text : null;
      } finally {
        await parser.destroy().catch(() => { /* best-effort cleanup */ });
      }
    } catch {
      pdfText = null;
    }
    if (pdfText === null) {
      throw new MemberFilePublishError('PDF 내용을 텍스트로 풀어 검사하지 못해 게시할 수 없습니다(fail-closed).');
    }
    if (MEMBER_FILE_CREDENTIAL_PATTERN.test(pdfText)) {
      throw new MemberFilePublishError('PDF 텍스트에서 자격(credential) 형태를 발견해 게시할 수 없습니다. 비밀이 아닌 값만 게시해 주세요.');
    }
    if (MEMBER_FILE_INTERNAL_PATTERN.test(pdfText)) {
      throw new MemberFilePublishError('PDF 텍스트에서 내부 데이터(elanous 내부 경로·식별자)를 발견해 게시할 수 없습니다.');
    }
  }

  const sha12 = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  const slug = slugifyBase(basename(input.filePath, extname(input.filePath)));
  const key = `members/${handle}/public/${localDateStamp(now())}/${slug}-${sha12}.${ext}`;

  const cfg = resolveStorageConfig(readRawConfig(join(input.configDir, 'config.json')), env);

  // JUD-B #39393 hold(12:36) mustFix ① — 실제 업로드 주체와 대상 버킷을 '짝으로' 데모 전용 objectCreator 결속에 결속한다.
  // 주체 해석(aws STS ARN·azure 사용자·local)과 objectCreatorGrants 짝 대조가 모두 통과해야 올린다
  // (fail-closed · 해석 실패·결속 없음·짝 불일치 = 전부 거부 — 3차 hold ①: 독립 허용 목록은 실효 업로더를 증명하지 못한다).
  // JUD hold(16:0x) ⑧차 ① — gcs 주체는 따로 해석하지 않는다: 업로드가 실제로 서명할 '같은 ADC 자격 인스턴스'에서
  // 신원(principal)과 접근 토큰을 함께 도출한다(앰비언트 ADC 재해석 금지 — defaultResolveUploadCredential·⑲a).
  const resolveIdentity = deps.resolveIdentity ?? defaultResolveUploadIdentity;
  let uploaderIdentity: string | null;
  let gcsAccessToken: string | null = null;
  if (cfg.provider === 'gcs') {
    const resolveUploadCredential = deps.resolveUploadCredential ?? defaultResolveUploadCredential;
    let credential: GcsUploadCredential | null = null;
    try { credential = await Promise.resolve(resolveUploadCredential(cfg)); } catch { credential = null; }
    if (credential === null || !credential.principal || !credential.accessToken) {
      throw new MemberFilePublishError('GCS 업로드 자격(신원·접근 토큰을 같은 ADC 자격 인스턴스에서 도출)을 해석하지 못해 게시할 수 없습니다(fail-closed).');
    }
    uploaderIdentity = credential.principal;
    gcsAccessToken = credential.accessToken;
  } else {
    uploaderIdentity = resolveIdentity(cfg);
  }
  const grants = objectCreatorGrants(input.configDir, env);
  const targetBucket = cfg.publicBucket;
  const bound = uploaderIdentity !== null && !!targetBucket
    && grants.some(grant => grant.principal === uploaderIdentity && grant.bucket === targetBucket);
  if (uploaderIdentity === null || !targetBucket || !bound) {
    throw new MemberFilePublishError('실제 업로더 신원과 대상 공개 버킷이 데모 전용 objectCreator 결속(storage.memberFilePublish.objectCreatorGrants)에 짝으로 결속되지 않아 게시할 수 없습니다.');
  }

  // OP #119090(5차) — IAM 결속 증거 파일 검증: 짝 대조(위)는 설정 선언, 증거 파일이 실효 권한 증명이다.
  // objectCreator 전용 업로더는 getIamPolicy 권한이 없어 런타임 버킷 IAM 조회는 최소권한 게시 경로에서 결코
  // 통과하지 못한다. 권한 있는 주체(RES)가 설치 시 1회 조회해 남긴 증거(configDir/member-file-iam-evidence.json·0600)의
  // 주체·버킷 일치·역할 단독·신선함(7일)을 검증하고 결과(주체·역할·증거)를 원장 1줄에 기록한다.
  // 증거 부재·파손·주체/버킷 불일치·역할 과다·만료 = 전부 거부(fail-closed).
  const evidenceResult = readIamEvidence(input.configDir, now(), deps.resEvidencePublicKeyPath ?? defaultMemberFileEvidencePubkeyPath(), deps.resEvidencePubkeySha256 ?? MEMBER_FILE_EVIDENCE_PUBKEY_SHA256);
  if (evidenceResult === null || evidenceResult.evidence.principal !== uploaderIdentity || evidenceResult.evidence.bucket !== targetBucket) {
    throw new MemberFilePublishError('실제 업로더 계정이 대상 버킷에서 objectCreator 역할만 갖는지 버킷 IAM 증거 파일(member-file-iam-evidence.json)로 확인하지 못해 게시할 수 없습니다(fail-closed).');
  }
  const evidence = evidenceResult.evidence;
  const iamRoles = new Set(evidence.roles);

  const store = deps.store ?? createObjectStore(cfg);
  // JUD hold(16:0x) ⑧차 ② — 접근 토큰 저장은 실행별 비공개·배타: 고정 경로(configDir) 재사용 금지, mkdtemp(0700) 안에
  // O_EXCL(0600) 토큰 파일을 만들어 object-store 가 --access-token-file 로 싣는다. put 성공·실패 무관 finally 정리 —
  // 동시 게시가 같은 파일을 공유하는 혼선도 구조적으로 없다(⑲b). 앰비언트 gcloud 자격으로는 올리지 않는다.
  if (cfg.provider === 'gcs') {
    const tokenDir = mkdtempSync(join(tmpdir(), 'member-file-upload-')); // 실행별 비공개(0700)
    try {
      const gcsAccessTokenFile = join(tokenDir, 'token');
      writeFileSync(gcsAccessTokenFile, `${gcsAccessToken}\n`, { flag: 'wx', mode: 0o600 }); // 배타 생성(O_EXCL)
      await store.put(key, bytes, { contentType, public: true, gcsAccessTokenFile });
    } finally {
      rmSync(tokenDir, { recursive: true, force: true }); // 토큰은 이 게시에만 쓰인다 — 남기지 않는다.
    }
  } else {
    await store.put(key, bytes, { contentType, public: true });
  }
  const url = store.publicUrl(key);
  if (!url) throw new MemberFilePublishError('공개 링크를 만들지 못했습니다. 저장소 공개 버킷 설정을 확인해 주세요.');

  const append = deps.appendLedger ?? appendLedgerLine;
  // OP #118856 ② + OP #119090(5차) — 업로드 원장 1줄에 IAM 결속 검증 결과(주체·버킷·역할·objectCreator 단독·증거 원문 지시)를 함께 기록한다.
  append(input.configDir, JSON.stringify({ at: now().toISOString(), handle, key, url, bytes: stat.size, contentType,
    iam: { principal: uploaderIdentity, bucket: targetBucket, roles: [...iamRoles].sort(), objectCreatorOnly: true,
      policyHash: evidence.policyHash, evidenceAt: evidence.at,
      // JUD hold(16:0x) ⑧차 ③ — 검증에 쓴 RES 공개 키 경로·mode(octal)도 원장에 남긴다(신뢰 기점 감사 대조).
      evidencePubkeyPath: evidenceResult.pubkeyPath, evidencePubkeyMode: evidenceResult.pubkeyMode,
      // JUD hold ⑨차 — 검증에 실제로 쓴 공개 키 내용의 sha256 지문(코드 상수 핀과 대조 = 같은 RES 발행 키로 검증했는지 증명).
      evidencePubkeySha256: evidenceResult.pubkeySha256 } }));
  return { handle, key, url, bytes: stat.size, contentType };
}

/** `elanous member file publish <path> --as-handle <handle>` — 성공 출력은 업로드된 https URL 한 줄. */
export function registerMemberFilePublishCommands(program: Command, deps: {
  configDir?: () => string;
  output?: { log(message: string): void; error(message: string): void };
  exit?: (code: number) => void;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  store?: ObjectStore;
} = {}): void {
  const io = deps.output ?? console;
  const exit = deps.exit ?? (code => { process.exitCode = code; });
  const member = program.commands.find(command => command.name() === 'member')
    ?? program.command('member').description('Manage member credentials and approved app-session handoffs.');
  const file = member.commands.find(command => command.name() === 'file')
    ?? member.command('file').description('회원 생성 파일 공개 게시.');
  const publish = file.commands.find(command => command.name() === 'publish')
    ?? file.command('publish');
  publish.description('생성 파일 하나를 공개 버킷 members/<handle>/public/ 에 올리고 https 링크를 돌려줍니다.')
    .argument('<path>', '게시할 파일 경로')
    .requiredOption('--as-handle <handle>', '게시할 회원 핸들(테스트 계정만 허용)')
    .allowExcessArguments(false);
  publish.error = (_message, options) => program.error('회원 파일 게시 명령이 올바르지 않습니다.', options);
  publish.action(async (filePath: string, options: { asHandle: string }) => {
    try {
      const result = await publishMemberFile({
        configDir: (deps.configDir ?? getElanousConfigDir)(),
        filePath,
        handle: options.asHandle,
        deps: {
          ...(deps.env ? { env: deps.env } : {}),
          ...(deps.now ? { now: deps.now } : {}),
          ...(deps.store ? { store: deps.store } : {}),
        },
      });
      io.log(result.url);
      exit(0);
    } catch (error) {
      io.error(error instanceof MemberFilePublishError
        ? error.message
        : '회원 파일 게시를 완료하지 못했습니다. 파일·핸들·저장소 설정을 확인해 주세요.');
      exit(1);
    }
  });
}
