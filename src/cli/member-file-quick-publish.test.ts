// OP #117916 MEMBER-FILE-QUICK-PUBLISH — 생성 파일 하나를 회원 공개 폴더에 올리고 https 링크를 돌려주는 한 명령의 시험.
// 실제 gcloud 를 부르지 않는다: 저장소는 가짜 store 를 주입해 put 원문(key·bytes·contentType·public:true)과 publicUrl 반환을 잰다.
// OP #118856(4차): publishMemberFile 는 async — PDF 텍스트 추출(pdf-parse) 때문.
// JUD hold(13:06) mustFix + OP #119090(5차): objectCreator 전용 업로더는 getIamPolicy 권한이 없어 런타임 버킷 IAM
// 조회는 최소권한 게시 경로에서 결코 통과하지 못한다. 대신 권한 있는 주체(RES)가 설치 시 1회 버킷 IAM 정책을 조회해
// 남긴 증거 파일(configDir/member-file-iam-evidence.json·600)으로 결속을 증명한다 — tempConfigDir 이 기본 증거
// (principal local·버킷 pub-bucket·지금 시각 = 신선)를 만들고 ⑮ 가 부재·만료·principal/버킷 불일치·시각 파손을 잡는다.
// JUD hold(14:57) ⑦차 mustFix ①②: ① 신원 해석(print-identity-token)과 gcloud storage 업로드를 같은 ADC 자격에
//    결속 — ADC 파생 접근 토큰을 0600 임시 파일로 내려 --access-token-file 로 전달(해석 실패 = 거부) ② 증거 봉인을
//    대칭 HMAC 에서 RES 전용 Ed25519 서명(발행자는 검증 공개 키만 읽는다 — 서명 권한 분리)으로 바꾼다(⑯⑱).
// JUD hold(16:0x) ⑧차 mustFix ①②③: ① 신원·업로드 토큰을 '같은 ADC 자격 인스턴스'에서 도출 — 앰비언트 ADC 를 두 번
//    따로 해석하지 않는다. 원본 ADC 를 실행별 비공개 스냅샷(mkdtemp 0700 + O_EXCL 0600)으로 한 번 읽어
//    CLOUDSDK_CONFIG+GOOGLE_APPLICATION_CREDENTIALS 로 핀하고 두 gcloud 호출이 그 인스턴스에서만 나오게 한다(⑲a).
// ② 접근 토큰 저장은 실행별 배타 — 고정 경로 재사용 금지, put 성패 무관 finally 정리(⑲b). ③ 검증 공개 키의 원천을
//    env/config 덮어쓰기에서 폐지하고 RES 운영 고정 경로(정규 파일·쓰기 비트 0·쓰기 시도 EACCES 증명)만 믿는다(⑳).
import { describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash, createHmac, createPublicKey, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { ObjectStore } from '../storage/object-store.js';
import {
  defaultResolveUploadCredential, defaultResolveUploadIdentity,
  MEMBER_FILE_EVIDENCE_PUBKEY_SHA256, MEMBER_FILE_IAM_EVIDENCE_MAX_AGE_MS, MEMBER_FILE_IAM_EVIDENCE_NAME, memberFileIamEvidenceCanonical,
  MEMBER_FILE_MAX_BYTES, MemberFilePublishError, publishMemberFile, type MemberFileIamEvidence,
} from './member-file-quick-publish.js';

// r10 changed-tsc RED — 두째 인자는 ⑮처럼 봉인된 전체 증거도, 그 밖 본문만(principal·bucket·roles·policyHash·at)도 받는다(tempConfigDir 이 항상 sealEvidence 로 새로 봉인).
/** ⑦차(JUD hold 14:57 mustFix ②) — 증거는 RES 전용 비대칭 키로 서명한다: 시험용 RES 키쌍(개인 키는 RES 몫 가정)과
 *  위조 시도용 공격자 개인 키. 발행자(피시험 코드)는 공개 키만 config/env 로 받는다. */
const RES_TEST_KEYPAIR = generateKeyPairSync('ed25519');
const ATTACKER_PRIVATE_KEY = generateKeyPairSync('ed25519').privateKey;
const resPubB64 = Buffer.from(RES_TEST_KEYPAIR.publicKey.export({ format: 'der', type: 'spki' })).toString('base64');
/** ⑨차(OP #121289 · RES #121293) — RES 발행 지문 픽스처: PUBKEY 파일 내용(base64 SPKI+개행)을 decode 한 DER 원바이트의 sha256.
 *  impl memberFileEvidencePublicKey 의 파생(decode → sha256(DER))과 동일하게 계산한다. */
const RES_PUBKEY_SHA256 = createHash('sha256').update(RES_TEST_KEYPAIR.publicKey.export({ format: 'der', type: 'spki' })).digest('hex');

/** ⑧차 ③ — 검증 공개 키 신뢰 기점 픽스처: RES 운영 고정 경로의 시험 대역(0444 — 쓰기 비트 전부 0).
 *  env/config 로는 공개 키를 넘길 수 없다(덮어쓰기 폐지) — publishMemberFile deps.resEvidencePublicKeyPath 로 경로만 주입한다. */
const PUBKEY = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'mfq-res-'));
  const path = join(dir, 'member-file-evidence-pubkey.spki.b64');
  writeFileSync(path, `${resPubB64}\n`, { mode: 0o444 });
  return path;
})();
/** ⑧차 ③ — 발행자가 공개 키를 바꿔치려 하는 대역: config evidencePublicKey 자리에 공격자 키를 심어도 무시되어야 한다. */
const ATTACKER_PUB_B64 = Buffer.from(createPublicKey(ATTACKER_PRIVATE_KEY).export({ format: 'der', type: 'spki' })).toString('base64');

function tempConfigDir(
  storage: Record<string, unknown> = {},
  iamEvidence?: MemberFileIamEvidence | Omit<MemberFileIamEvidence, 'seal'> | null,
): string {
  const dir = mkdtempSync(join(tmpdir(), 'mfp-'));
  // 기본: 공개 버킷 pub-bucket + 데모 전용 objectCreator 결속(r3 hold ① — local provider 신원 해석값 'local' 과 버킷 'pub-bucket' 이 짝으로 결속됨).
  // 호출자가 memberFilePublish 를 넘기면 그 키가 우선한다(빈 목록 포함 — ⑩-2·⑬-3 fail-closed 케이스).
  const callerMember = storage.memberFilePublish as Record<string, unknown> | undefined;
  const memberFilePublish = {
    testHandles: [] as string[],
    objectCreatorGrants: [{ principal: 'local', bucket: 'pub-bucket' }],
    // ⑧차 ③ — evidencePublicKey 자리는 폐지됐다: 검증 공개 키의 원천은 config/env 가 아니라 RES 운영 고정 경로다.
    // (호출자가 넘겨도 무시된다 — ⑳⑹. 실제 검증은 deps.resEvidencePublicKeyPath 경로의 파일로만 한다.)
    ...(callerMember ?? {}),
  };
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    storage: { localDir: join(dir, 'local'), publicBucket: 'pub-bucket', ...storage, memberFilePublish },
  }));
  // OP #119090 — RES 가 설치 시 남기는 증거 파일(기본: local·pub-bucket·지금 시각 = 신선). 두째 인자 null = 부재 케이스.
  if (iamEvidence !== null) {
    const base = iamEntityBase(iamEvidence);
    writeFileSync(join(dir, MEMBER_FILE_IAM_EVIDENCE_NAME), JSON.stringify(
      { ...base, seal: sealEvidence(base) }), { mode: 0o600 });
  }
  return dir;
}

/** ⑮/⑯ 공용 — 증거 본문(principal·bucket·roles·policyHash·at). seal 은 sealEvidence 로 붙인다. */
function iamEntityBase(
  ev?: MemberFileIamEvidence | Omit<MemberFileIamEvidence, 'seal'> | null,
): Omit<MemberFileIamEvidence, 'seal'> {
  if (!ev) {
    return { principal: 'local', bucket: 'pub-bucket', roles: [CREATOR_ROLE], policyHash: 'policy-hash-1', at: new Date().toISOString() };
  }
  // 봉인된 전체 증거가 넘어오면 seal 을 덜어내 본문만 돌려준다 — tempConfigDir 이 sealEvidence 로 항상 새로 봉인하므로
  // 원 봉인은 폐기된다. 본문만 넘어온 경우 seal 은 undefined 로 읽혀 버려진다(r10 changed-tsc TS2339 수리).
  const { seal: _sealed, ...base } = ev as MemberFileIamEvidence;
  return base;
}

/** JUD hold(14:57) ⑦차 mustFix ② — 증거 본문을 RES 전용 Ed25519 개인 키로 서명한 base64(대칭 HMAC 봉인은 폐지). */
function sealEvidence(base: Omit<MemberFileIamEvidence, 'seal'>, privateKey: KeyObject = RES_TEST_KEYPAIR.privateKey): string {
  return Buffer.from(cryptoSign(null, Buffer.from(memberFileIamEvidenceCanonical(base), 'utf8'), privateKey)).toString('base64');
}

interface PutCall { key: string; body: Uint8Array; opts?: { contentType?: string; public?: boolean; gcsAccessTokenFile?: string } }

function fakeStore(urlForKey?: (key: string) => string | null): { store: ObjectStore; puts: PutCall[] } {
  const puts: PutCall[] = [];
  const store: ObjectStore = {
    provider: 'gcs',
    put(key, body, opts) { puts.push({ key, body: body as Uint8Array, opts }); },
    delete() {},
    get() {},
    head() { return { exists: false }; },
    list() { return []; },
    publicUrl(key) { return urlForKey ? urlForKey(key) : `https://storage.googleapis.com/pub-bucket/${key}`; },
  };
  return { store, puts };
}

function writeSample(dir: string, name: string, content: string): { path: string; bytes: Uint8Array } {
  const bytes = new TextEncoder().encode(content);
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return { path, bytes };
}

const CREATOR_ROLE = 'roles/storage.objectCreator';

/** publishMemberFile 가 MemberFilePublishError 로 거부하는지 재다(toThrow 의 async 판). 거부 메시지를 돌려준다. */
async function expectPublishRejects(promise: Promise<unknown>): Promise<Error> {
  let captured: unknown = null;
  try { await promise; } catch (error) { captured = error; }
  expect(captured).toBeInstanceOf(MemberFilePublishError);
  return captured as Error;
}

/** PDF 콘텐츠 스트림(페이지에 text 한 줄 싣는 Tj). */
function pdfContentStream(text: string): string {
  return `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
}

/** 최소 완전 PDF 객체(xref/trailer 포함). 압축은 FlateDecode(deflateSync) — 원바이트 latin1 스캔이 본문을 못 보게 한다. */
function buildPdf(contentStream: string, opts?: { deflate?: boolean }): Uint8Array {
  const deflate = opts?.deflate !== false;
  const body = deflate ? deflateSync(Buffer.from(contentStream, 'latin1')) : Buffer.from(contentStream, 'latin1');
  const filter = deflate ? '/Filter /FlateDecode ' : '';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< ${filter}/Length ${body.length} >>\nstream\n${body.toString('latin1')}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

describe('publishMemberFile', () => {
  test('① 정상: 키 조립 원문·contentType 원문·public:true 원문·원장 1줄·URL 반환', async () => {
    const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'] } },
      { principal: 'local', bucket: 'pub-bucket', roles: [CREATOR_ROLE], policyHash: 'policy-hash-1', at: new Date(2026, 0, 21).toISOString() });
    const { path, bytes } = writeSample(configDir, 'My Report 2026.txt', 'hello quick publish\n');
    const sha12 = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
    const { store, puts } = fakeStore();
    const now = new Date(2026, 0, 21, 9, 5, 0);
    const expectedKey = `members/demo/public/20260121/my-report-2026-${sha12}.txt`;
    const result = await publishMemberFile({ configDir, filePath: path, handle: 'demo',
      deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, now: () => now, store } });
    expect(puts.length).toBe(1);
    expect(puts[0].key).toBe(expectedKey);
    expect(Buffer.from(puts[0].body).equals(bytes)).toBe(true);
    expect(puts[0].opts).toEqual({ contentType: 'text/plain; charset=utf-8', public: true });
    expect(result.key).toBe(expectedKey);
    expect(result.url).toBe(`https://storage.googleapis.com/pub-bucket/${expectedKey}`);
    expect(result.bytes).toBe(bytes.length);
    expect(result.contentType).toBe('text/plain; charset=utf-8');
    const ledgerPath = join(configDir, 'member-file-publish.jsonl');
    expect(existsSync(ledgerPath)).toBe(true);
    expect((lstatSync(ledgerPath).mode & 0o077)).toBe(0); // 0600
    const lines = readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(entry.handle).toBe('demo');
    expect(entry.key).toBe(expectedKey);
    expect(entry.url).toBe(result.url);
    expect(entry.bytes).toBe(bytes.length);
    expect(entry.contentType).toBe('text/plain; charset=utf-8');
    expect(typeof entry.at).toBe('string');
    expect(Number.isNaN(Date.parse(entry.at as string))).toBe(false);
  });

  test('①b 발행 형식 제한 — txt/md 게시 · png/jpg 거부(pdf 는 ⑭ 추출 게이트로 관리)', async () => {
    const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'] } },
      { principal: 'local', bucket: 'pub-bucket', roles: [CREATOR_ROLE], policyHash: 'policy-hash-1', at: new Date(2026, 0, 21).toISOString() });
    const enc = new TextEncoder();
    // txt/md 는 Content-Type 원문으로 통과.
    const passCases: Array<[string, Uint8Array, string]> = [
      ['a.txt', enc.encode('plain text\n'), 'text/plain; charset=utf-8'],
      ['d.md', enc.encode('x'), 'text/markdown; charset=utf-8'],
    ];
    for (const [name, body, contentType] of passCases) {
      const path = join(configDir, name);
      writeFileSync(path, body);
      const { store, puts } = fakeStore();
      await publishMemberFile({ configDir, filePath: path, handle: 'demo',
        deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, now: () => new Date(2026, 0, 21), store } });
      expect(puts[0].opts).toEqual({ contentType, public: true });
    }
    // png/jpg 는 원바이트 스캔·텍스트 추출 어느 쪽으로도 신뢰성 있게 검사할 수 없어 여전히 거부.
    // (pdf 는 OP #118856 ① 로 텍스트 추출 게이트를 통과하면 게시된다 — ⑭ 참조.)
    const rejectCases: Array<[string, Uint8Array]> = [
      ['c.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      ['e.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0])],
    ];
    for (const [name, body] of rejectCases) {
      const path = join(configDir, name);
      writeFileSync(path, body);
      const { store, puts } = fakeStore();
      await expectPublishRejects(publishMemberFile({ configDir, filePath: path, handle: 'demo',
        deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, now: () => new Date(2026, 0, 21), store } }));
      expect(puts.length).toBe(0);
    }
  });

  test('①c base명이 slug 로 모두 정리되면 빈 문자열 대신 file', async () => {
    const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'] } },
      { principal: 'local', bucket: 'pub-bucket', roles: [CREATOR_ROLE], policyHash: 'policy-hash-1', at: new Date(2026, 0, 21).toISOString() });
    const { path, bytes } = writeSample(configDir, '!!__!!.txt', 'z');
    const sha12 = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
    const { store, puts } = fakeStore();
    await publishMemberFile({ configDir, filePath: path, handle: 'demo',
      deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, now: () => new Date(2026, 0, 21), store } });
    expect(puts[0].key).toBe(`members/demo/public/20260121/file-${sha12}.txt`);
  });

  test('② 비허용 확장자 거부(put 미호출)', async () => {
    const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'] } });
    const { path } = writeSample(configDir, 'evil.exe', 'MZ');
    const { store, puts } = fakeStore();
    await expectPublishRejects(publishMemberFile({ configDir, filePath: path, handle: 'demo', deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store } }));
    expect(puts.length).toBe(0);
    expect(existsSync(join(configDir, 'member-file-publish.jsonl'))).toBe(false);
  });

  test('③ 100MiB 초과 거부(내려받기 없이 stat 크기로)', async () => {
    const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'] } });
    const { store, puts } = fakeStore();
    await expectPublishRejects(publishMemberFile({ configDir, filePath: join(configDir, 'big.pdf'), handle: 'demo',
      deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store, statImpl: () => ({ isFile: () => true, size: MEMBER_FILE_MAX_BYTES + 1 }) } }));
    expect(puts.length).toBe(0);
  });

  test('③b 100MiB 는 경계로 허용', async () => {
    const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'] } },
      { principal: 'local', bucket: 'pub-bucket', roles: [CREATOR_ROLE], policyHash: 'policy-hash-1', at: new Date(2026, 0, 21).toISOString() });
    const { store, puts } = fakeStore();
    const readFileCalls: string[] = [];
    await publishMemberFile({ configDir, filePath: join(configDir, 'edge.bin'.replace('bin', 'txt')), handle: 'demo',
      deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, now: () => new Date(2026, 0, 21), store,
        statImpl: () => ({ isFile: () => true, size: MEMBER_FILE_MAX_BYTES }),
        readFile: (p: string) => { readFileCalls.push(p); return new Uint8Array(MEMBER_FILE_MAX_BYTES); } } });
    expect(readFileCalls.length).toBe(1);
    expect(puts.length).toBe(1);
  });

  test('④ testHandles 밖 핸들 거부 — 남의 핸들 fail-closed', async () => {
    const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'] } });
    const { path } = writeSample(configDir, 'note.txt', 'n');
    const { store, puts } = fakeStore();
    await expectPublishRejects(publishMemberFile({ configDir, filePath: path, handle: 'intruder', deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store } }));
    expect(puts.length).toBe(0);
  });

  test('④b env ELANOUS_MEMBER_FILE_TEST_HANDLES 합집합 — env 만으로도 허용·둘 다 비면 전부 거부', async () => {
    const configDir = tempConfigDir();
    const { path } = writeSample(configDir, 'note.txt', 'n');
    const envOk: NodeJS.ProcessEnv = { ELANOUS_MEMBER_FILE_TEST_HANDLES: 'alpha,beta' };

    const { store, puts } = fakeStore();
    await publishMemberFile({ configDir, filePath: path, handle: 'alpha', deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: envOk, store } });
    await expectPublishRejects(publishMemberFile({ configDir, filePath: path, handle: 'demo', deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: envOk, store } }));
    expect(puts.length).toBe(1); // alpha 만 올라감
    // config ⊕ env 합집합
    const configDir2 = tempConfigDir({ memberFilePublish: { testHandles: ['demo'] } });
    const { store: store2, puts: puts2 } = fakeStore();
    await publishMemberFile({ configDir: configDir2, filePath: path, handle: 'alpha',
      deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: { ELANOUS_MEMBER_FILE_TEST_HANDLES: 'alpha' }, store: store2 } });
    await publishMemberFile({ configDir: configDir2, filePath: path, handle: 'demo', deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store: store2 } });
    expect(puts2.length).toBe(2);
    // 둘 다 비면 전부 거부
    const { store: store3, puts: puts3 } = fakeStore();
    await expectPublishRejects(publishMemberFile({ configDir, filePath: path, handle: 'demo', deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store: store3 } }));
    expect(puts3.length).toBe(0);
  });

  test('⑤ handle 경로 조작 거부(../user · 슬래시 · 대문자 · 점)', async () => {
    const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'] } });
    const { path } = writeSample(configDir, 'note.txt', 'n');
    const { store, puts } = fakeStore();
    for (const handle of ['../user', 'user/x', 'demo/../../etc', '..', 'Demo', 'de mo', 'x']) {
      await expectPublishRejects(publishMemberFile({ configDir, filePath: path, handle, deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store } }));
    }
    expect(puts.length).toBe(0);
  });

  test('⑥ publicUrl 이 null 이면 오류(원장 미기록)', async () => {
    const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'] } });
    const { path } = writeSample(configDir, 'note.txt', 'n');
    const { store, puts } = fakeStore(() => null);
    await expectPublishRejects(publishMemberFile({ configDir, filePath: path, handle: 'demo',
      deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store } }));
    expect(puts.length).toBe(1); // put 은 시도했으나 링크를 못 얻어 실패
    expect(existsSync(join(configDir, 'member-file-publish.jsonl'))).toBe(false);
  });

  test('⑦ 없는 파일·일반 파일 아님 거부', async () => {
    const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'] } });
    const { store, puts } = fakeStore();
    await expectPublishRejects(publishMemberFile({ configDir, filePath: join(configDir, 'nope.txt'), handle: 'demo', deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store } }));
    await expectPublishRejects(publishMemberFile({ configDir, filePath: configDir, handle: 'demo',
      deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store, statImpl: () => ({ isFile: () => false, size: 0 }) } }));
    expect(puts.length).toBe(0);
  });
});

describe('JUD-B #39393 mustFix — 내용 사전 검사(①②) · 데모 버킷 결속(④)', () => {
  function writeBytes(dir: string, name: string, bytes: Uint8Array): string {
    const path = join(dir, name);
    writeFileSync(path, bytes);
    return path;
  }
  const enc = new TextEncoder();

  test('⑧ txt/md 자격·내부데이터 사전 스캔 — AKIA · PRIVATE KEY · service_account · ya29 전부 거부(put 미호출·원장 0줄)', async () => {
    const leaks: Array<[string, string]> = [
      ['a.txt', 'key=AKIAIOSFODNN7EXAMPLE'],
      ['b.md', '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----'],
      ['c.txt', '{"type":"service_account","project_id":"x"}'],
      ['d.md', 'token: ya29.a0ARrdaM-abcdefghijklmnopqrstuv'],
      ['e.txt', 'api_key = "AIzaSyA' + 'bCdEfGhIjKlMnOpQrStUvWxYz1234567890"'],
    ];
    for (const [name, content] of leaks) {
      const configDir = tempConfigDir({ publicBucket: 'pub-bucket', memberFilePublish: { testHandles: ['demo'], buckets: ['pub-bucket'] } });
      const path = writeBytes(configDir, name, enc.encode(content));
      const { store, puts } = fakeStore();
      await expectPublishRejects(publishMemberFile({ configDir, filePath: path, handle: 'demo', deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store } }));
      expect(puts.length).toBe(0);
      expect(existsSync(join(configDir, 'member-file-publish.jsonl'))).toBe(false);
    }
  });

  test('⑨ 실제 바이트·형식 검증 — 가짜 pdf(추출 실패) 거부 · UTF-8 아닌 txt 거부 · UTF-8 txt 통과', async () => {
    const configDir = tempConfigDir({ publicBucket: 'pub-bucket', memberFilePublish: { testHandles: ['demo'] } });

    // pdf 처럼 꾸민 텍스트 — OP #118856 ①: 텍스트 추출이 실패하면 거부(fail-closed).
    const fakePdf = writeBytes(configDir, 'fake.pdf', enc.encode('hello not a pdf'));
    await expectPublishRejects(publishMemberFile({ configDir, filePath: fakePdf, handle: 'demo',
      deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store: fakeStore().store } }));
    // UTF-8 아닌 txt(연속된 0xFF 바이트 — fatal 디코드 실패).
    const badUtf8 = writeBytes(configDir, 'bad.txt', new Uint8Array([0xff, 0xfe, 0xfd, 0xfc]));
    await expectPublishRejects(publishMemberFile({ configDir, filePath: badUtf8, handle: 'demo',
      deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store: fakeStore().store } }));
    // UTF-8 txt 는 통과(put 1회).
    const dir = tempConfigDir({ publicBucket: 'pub-bucket', memberFilePublish: { testHandles: ['demo'] } });
    const path = writeBytes(dir, 'ok.txt', enc.encode('ok'));
    const { store, puts } = fakeStore();
    await publishMemberFile({ configDir: dir, filePath: path, handle: 'demo', deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store } });
    expect(puts.length).toBe(1);
  });

  test('⑩ 대상 공개 버킷 짝 결속(r3 hold ①) — grant 의 bucket 이 publicBucket 과 짝이 아니면 거부 · grants 비면 전부 거부 · env grants 로 통과', async () => {
    const path = (() => { const dir = mkdtempSync(join(tmpdir(), 'mfp-b-')); const p = join(dir, 'doc.txt'); writeFileSync(p, new TextEncoder().encode('ok')); return p; })();
    // 1) grant 의 principal 은 일치해도 bucket 이 다르면 거부(짝 결속).
    {
      const configDir = tempConfigDir({ publicBucket: 'pub-bucket', memberFilePublish: { testHandles: ['demo'], objectCreatorGrants: [{ principal: 'local', bucket: 'other-demo-bucket' }] } });
      const { store, puts } = fakeStore();
      await expectPublishRejects(publishMemberFile({ configDir, filePath: path, handle: 'demo', deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store } }));
      expect(puts.length).toBe(0);
    }
    // 2) grants 비면 전부 거부(fail-closed).
    {
      const configDir = tempConfigDir({ publicBucket: 'pub-bucket', memberFilePublish: { testHandles: ['demo'], objectCreatorGrants: [] } });
      const { store, puts } = fakeStore();
      await expectPublishRejects(publishMemberFile({ configDir, filePath: path, handle: 'demo', deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store } }));
      expect(puts.length).toBe(0);
    }
    // 3) env grants 로 허용하면 통과.
    {
      const configDir = tempConfigDir({ publicBucket: 'pub-bucket', memberFilePublish: { testHandles: ['demo'], objectCreatorGrants: [] } });
      const { store, puts } = fakeStore();
      await publishMemberFile({ configDir, filePath: path, handle: 'demo',
        deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: { ELANOUS_MEMBER_FILE_PUBLISH_OBJECT_CREATOR_GRANTS: 'local,pub-bucket' }, store } });
      expect(puts.length).toBe(1);
    }
  });
});

describe('JUD-B #39393 hold(11:52) mustFix — ① 실제 바이트 상한 · ② 내부데이터 스캔+바이너리 검사 정의 · ③ 업로더 신원 IAM 결속', () => {
  const enc = new TextEncoder();
  function writeBytes(dir: string, name: string, bytes: Uint8Array): string {
    const path = join(dir, name);
    writeFileSync(path, bytes);
    return path;
  }

  test('⑪ 실제 바이트 상한 — stat 은 작아도 readFile 이 100MiB 초과를 돌려주면 거부(put 미호출)', async () => {
    const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'] } });
    const { store, puts } = fakeStore();
    await expectPublishRejects(publishMemberFile({ configDir, filePath: join(configDir, 'grown.txt'), handle: 'demo',
      deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store,
        statImpl: () => ({ isFile: () => true, size: 16 }),
        readFile: () => new Uint8Array(MEMBER_FILE_MAX_BYTES + 1) } }));
    expect(puts.length).toBe(0);
  });

  test('⑫ 내부데이터 사전 스캔 — elanous-hq · seat-state · ~/.elanous · gs://elanous · /Users/user · .monad-agent 전부 거부(txt/md·바이너리 예외 없음)', async () => {
    const leaks: Array<[string, Uint8Array]> = [
      ['a.txt', enc.encode('look at ~/elanous-hq/seat-state/RES/evidence/report.md')],
      // 홈 절대 경로는 소스에 리터럴로 두지 않는다(PUBLIC-EXPORT absolute-home-path 표지 — 게이트가 문다).
      // 런타임 homedir() 로 실제 절대 경로를 만들어 내부 스캔 거부 시험을 그대로 유지한다.
      ['b.md', enc.encode(`config: ${homedir()}/.elanous/config.json`)],
      ['c.txt', enc.encode('bucket: gs://elanous-demo-reports-1121/x')],
      // /home/user 절대 경로도 소스 리터럴 금지(absolute-home-path) — 런타임 구성으로 같은 거부를 시험한다.
      ['d.md', enc.encode(`audit trail: ${homedir()}/../elanous-hq/x`)],
      ['e.txt', enc.encode('ledger ~/.monad-agent/audit/shell-x.ndjson copied')],
    ];
    for (const [name, body] of leaks) {
      const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'] } });
      const path = writeBytes(configDir, name, body);
      const { store, puts } = fakeStore();
      await expectPublishRejects(publishMemberFile({ configDir, filePath: path, handle: 'demo', deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store } }));
      expect(puts.length).toBe(0);
      expect(existsSync(join(configDir, 'member-file-publish.jsonl'))).toBe(false);
    }
  });

  test('⑫b 과잉 거부 없음 — 매직·내부 마커 문제 없는 깨끗한 UTF-8 텍스트는 통과', async () => {
    const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'] } });
    const path = writeBytes(configDir, 'clean.md', enc.encode('# Good content\n\nplain markdown.\n'));
    const { store, puts } = fakeStore();
    await publishMemberFile({ configDir, filePath: path, handle: 'demo',
      deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store } });
    expect(puts.length).toBe(1);
  });

  test('⑬ 업로더 주체 짝 결속(r3 hold ①) — ⑴ principal 불일치 거부 ⑵ 짝 일치 통과 ⑶ grants 비면 전부 거부 ⑷ env grants 통과 ⑸ 신원 해석 실패 거부', async () => {
    const path = (() => { const dir = mkdtempSync(join(tmpdir(), 'mfp-i-')); return writeBytes(dir, 'ok.txt', enc.encode('ok')); })();
    const principal = 'demo-objectcreator@demo.iam';
    // ⑴ principal 이 grant 와 불일치(버킷은 일치) → 거부.
    {
      const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'], objectCreatorGrants: [{ principal, bucket: 'pub-bucket' }] } });
      const { store, puts } = fakeStore();
      await expectPublishRejects(publishMemberFile({ configDir, filePath: path, handle: 'demo',
        deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store, resolveIdentity: () => 'someone-else@example.com' } }));
      expect(puts.length).toBe(0);
    }
    // ⑵ principal·bucket 짝이 모두 일치 → 통과(증거의 주체·버킷도 같은 짝).
    {
      const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'], objectCreatorGrants: [{ principal, bucket: 'pub-bucket' }] } },
        { principal, bucket: 'pub-bucket', roles: [CREATOR_ROLE], policyHash: 'policy-hash-1', at: new Date().toISOString() });
      const { store, puts } = fakeStore();
      await publishMemberFile({ configDir, filePath: path, handle: 'demo',
        deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store, resolveIdentity: () => principal } });
      expect(puts.length).toBe(1);
    }
    // ⑶ grants 비면 전부 거부(fail-closed).
    {
      const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'], objectCreatorGrants: [] } });
      const { store, puts } = fakeStore();
      await expectPublishRejects(publishMemberFile({ configDir, filePath: path, handle: 'demo',
        deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store, resolveIdentity: () => principal } }));
      expect(puts.length).toBe(0);
    }
    // ⑷ env grants 로 허용하면 통과(config grants 는 비어 있음·증거의 주체·버킷은 같은 짝).
    {
      const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'], objectCreatorGrants: [] } },
        { principal, bucket: 'pub-bucket', roles: [CREATOR_ROLE], policyHash: 'policy-hash-1', at: new Date().toISOString() });
      const { store, puts } = fakeStore();
      await publishMemberFile({ configDir, filePath: path, handle: 'demo',
        deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: { ELANOUS_MEMBER_FILE_PUBLISH_OBJECT_CREATOR_GRANTS: `${principal},pub-bucket` }, store, resolveIdentity: () => principal } });
      expect(puts.length).toBe(1);
    }
    // ⑸ 신원 해석 실패(원격 CLI 부재 등) → 거부(fail-closed).
    {
      const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'], objectCreatorGrants: [{ principal, bucket: 'pub-bucket' }] } });
      const { store, puts } = fakeStore();
      await expectPublishRejects(publishMemberFile({ configDir, filePath: path, handle: 'demo',
        deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store, resolveIdentity: () => null } }));
      expect(puts.length).toBe(0);
    }
  });
});

describe('OP #118856(4차) ① PDF 텍스트 추출 게이트 · OP #119090(5차) ② IAM 결속 증거 파일', () => {
  const enc = new TextEncoder();
  function writeBytes(dir: string, name: string, body: Uint8Array): string {
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
  }

  test('⑭ PDF 텍스트 추출 게이트(OP #118856 ①) — ⑴ 압축 스트림 가짜 키 거부 ⑵ 깨끗한 압축 PDF 통과 ⑶ 추출 실패 거부 ⑷ 평문 스트림 가짜 키 원스캔 거부', async () => {

    // ⑴ FlateDecode 압축 스트림 안 가짜 키: 원바이트 latin1 스캔은 압축이라 못 보고, 텍스트 추출이 발견해 거부.
    {
      const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'] } });
      const path = writeBytes(configDir, 'leak.pdf', buildPdf(pdfContentStream('key=AKIAIOSFODNN7EXAMPLE')));
      const { store, puts } = fakeStore();
      const err = await expectPublishRejects(publishMemberFile({ configDir, filePath: path, handle: 'demo',
        deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store } }));
      expect(err.message).toContain('자격');
      expect(puts.length).toBe(0);
      expect(existsSync(join(configDir, 'member-file-publish.jsonl'))).toBe(false);
    }
    // ⑵ 깨끗한 압축 PDF: 추출 통과 → put 원문 contentType application/pdf + 원장 1줄.
    {
      const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'] } },
        { principal: 'local', bucket: 'pub-bucket', roles: [CREATOR_ROLE], policyHash: 'policy-hash-1', at: new Date(2026, 0, 21).toISOString() });
      const path = writeBytes(configDir, 'clean.pdf', buildPdf(pdfContentStream('hello member file publish')));
      const { store, puts } = fakeStore();
      await publishMemberFile({ configDir, filePath: path, handle: 'demo',
        deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, now: () => new Date(2026, 0, 21), store } });
      expect(puts.length).toBe(1);
      expect(puts[0].opts).toEqual({ contentType: 'application/pdf', public: true });
      const lines = readFileSync(join(configDir, 'member-file-publish.jsonl'), 'utf8').split('\n').filter(Boolean);
      expect(lines.length).toBe(1);
      expect((JSON.parse(lines[0]) as Record<string, unknown>).contentType).toBe('application/pdf');
    }
    // ⑶ 추출 실패(머리만 있는 폭발한 PDF) = 거부(fail-closed).
    {
      const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'] } });
      const path = writeBytes(configDir, 'broken.pdf', enc.encode('%PDF-1.7\n'));
      const { store, puts } = fakeStore();
      const err = await expectPublishRejects(publishMemberFile({ configDir, filePath: path, handle: 'demo',
        deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store } }));
      expect(err.message).toContain('풀어');
      expect(puts.length).toBe(0);
    }
    // ⑷ 압축 안 된(평문) 스트림의 가짜 키는 전 바이트 latin1 원스캔이 이미 잡는다.
    {
      const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'] } });
      const path = writeBytes(configDir, 'plainleak.pdf', buildPdf(pdfContentStream('key=AKIAIOSFODNN7EXAMPLE'), { deflate: false }));
      const { store, puts } = fakeStore();
      const err = await expectPublishRejects(publishMemberFile({ configDir, filePath: path, handle: 'demo',
        deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store } }));
      expect(err.message).toContain('자격');
      expect(puts.length).toBe(0);
    }
  });

  test('⑮ IAM 결속 증거 파일 검증(OP #119090 5차) — ⑴ 통과·원장 iam 기록 ⑵ principal 불일치 거부 ⑶ 버킷 불일치 거부 ⑷ 역할 과다 거부 ⑸ 증거 부재 거부 ⑹ 만료·시각 파손 거부', async () => {
    const path = (() => { const dir = mkdtempSync(join(tmpdir(), 'mfp-iam-')); const p = join(dir, 'ok.txt'); writeFileSync(p, new TextEncoder().encode('ok')); return p; })();
    const principal = 'demo-objectcreator@demo.iam';
    const grants = [{ principal, bucket: 'pub-bucket' }];
    const evidence = (over: Partial<MemberFileIamEvidence> = {}): MemberFileIamEvidence => {
      const base = {
        principal: over.principal ?? principal,
        bucket: over.bucket ?? 'pub-bucket',
        roles: over.roles ?? [CREATOR_ROLE],
        policyHash: over.policyHash ?? 'policy-hash-1',
        at: over.at ?? new Date().toISOString(),
      };
      // JUD hold(13:33) ① — 증거는 RES seal 키(configDir 기본 'test-seal-key')로 봉인돼야 유효하다.
      return { ...base, seal: sealEvidence(base) };
    };
    // ⑴ 통과: 증거의 주체·버킷이 이 업로드와 일치하고 역할이 objectCreator 단독·조회 시각이 신선하다. 원장 줄에 iam 결과(증거 시각·정책 해시 포함)가 기록된다.
    {
      const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'], objectCreatorGrants: grants } }, evidence());
      const { store, puts } = fakeStore();
      await publishMemberFile({ configDir, filePath: path, handle: 'demo',
        deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store, resolveIdentity: () => principal } });
      expect(puts.length).toBe(1);
      const lines = readFileSync(join(configDir, 'member-file-publish.jsonl'), 'utf8').split('\n').filter(Boolean);
      const entry = JSON.parse(lines[0]!) as { iam?: { principal?: string; bucket?: string; roles?: string[]; objectCreatorOnly?: boolean; policyHash?: string; evidenceAt?: string } };
      expect(entry.iam?.principal).toBe(principal);
      expect(entry.iam?.bucket).toBe('pub-bucket');
      expect(entry.iam?.roles).toEqual([CREATOR_ROLE]);
      expect(entry.iam?.objectCreatorOnly).toBe(true);
      expect(entry.iam?.policyHash).toBe('policy-hash-1');
      expect(typeof entry.iam?.evidenceAt).toBe('string');
    }
    // ⑵ principal 불일치: 증거가 다른 주체의 것이면(짝 대조는 통과해도) 거부.
    {
      const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'], objectCreatorGrants: grants } }, evidence({ principal: 'someone-else@demo.iam' }));
      const { store, puts } = fakeStore();
      const err = await expectPublishRejects(publishMemberFile({ configDir, filePath: path, handle: 'demo',
        deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store, resolveIdentity: () => principal } }));
      expect(err.message).toContain('objectCreator');
      expect(puts.length).toBe(0);
    }
    // ⑶ 버킷 불일치: 증거의 버킷이 대상 공개 버킷과 다르면 거부.
    {
      const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'], objectCreatorGrants: grants } }, evidence({ bucket: 'other-demo-bucket' }));
      const { store, puts } = fakeStore();
      const err = await expectPublishRejects(publishMemberFile({ configDir, filePath: path, handle: 'demo',
        deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store, resolveIdentity: () => principal } }));
      expect(err.message).toContain('objectCreator');
      expect(puts.length).toBe(0);
    }
    // ⑷ 역할 과다: 증거에 objectAdmin 이 함께 있으면('만'이 아님) 거부.
    {
      const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'], objectCreatorGrants: grants } },
        evidence({ roles: [CREATOR_ROLE, 'roles/storage.objectAdmin'] }));
      const { store, puts } = fakeStore();
      const err = await expectPublishRejects(publishMemberFile({ configDir, filePath: path, handle: 'demo',
        deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store, resolveIdentity: () => principal } }));
      expect(err.message).toContain('objectCreator');
      expect(puts.length).toBe(0);
    }
    // ⑸ 증거 파일 부재(RES 가 설치 시 남기지 않음) = 거부(fail-closed).
    {
      const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'], objectCreatorGrants: grants } }, null);
      const { store, puts } = fakeStore();
      const err = await expectPublishRejects(publishMemberFile({ configDir, filePath: path, handle: 'demo',
        deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store, resolveIdentity: () => principal } }));
      expect(err.message).toContain('증거 파일');
      expect(puts.length).toBe(0);
    }
    // ⑆ 만료·시각 파손: 7일 신선 창 밖의 조회 시각과 해석 불가 시각은 전부 거부.
    {
      const expired = tempConfigDir({ memberFilePublish: { testHandles: ['demo'], objectCreatorGrants: grants } },
        evidence({ at: new Date(Date.now() - MEMBER_FILE_IAM_EVIDENCE_MAX_AGE_MS - 60_000).toISOString() }));
      const { store, puts } = fakeStore();
      await expectPublishRejects(publishMemberFile({ configDir: expired, filePath: path, handle: 'demo',
        deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store, resolveIdentity: () => principal } }));
      expect(puts.length).toBe(0);
      const broken = tempConfigDir({ memberFilePublish: { testHandles: ['demo'], objectCreatorGrants: grants } },
        evidence({ at: 'not-a-timestamp' }));
      const { store: store2, puts: puts2 } = fakeStore();
      const err = await expectPublishRejects(publishMemberFile({ configDir: broken, filePath: path, handle: 'demo',
        deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store: store2, resolveIdentity: () => principal } }));
      expect(err.message).toContain('증거 파일');
      expect(puts2.length).toBe(0);
    }
  });

  test('⑯ 증거 파일 신뢰 경계(JUD hold 13:33 ①·6차 + 14:57 ⑦차 ②) — ⑴ 통과(정규 파일·0600·RES Ed25519 서명) ⑵ mode 0644 거부 ⑶ 심볼릭 링크 거부 ⑷ seal 부재 거부 ⑸ 타 키 서명 거부 ⑸b 대칭(HMAC hex) 봉인 거부 ⑹ 검증 공개 키 부재(fail-closed) 거부 ⑹b env 공개 키로 검증 통과 ⑺ 소유자 불일치(st.uid ≠ 실행 uid) 거부 — root 없이 타 소유자 파일을 못 만들므로 getuid 잠시 대조 후 원복', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mfp-iam6-'));
    const path = join(dir, 'ok.txt');
    writeFileSync(path, new TextEncoder().encode('ok'));
    const principal = 'adc-demo-objectcreator@demo.iam';
    const grants = [{ principal, bucket: 'pub-bucket' }];
    const base = { principal, bucket: 'pub-bucket', roles: [CREATOR_ROLE], policyHash: 'policy-hash-1', at: new Date().toISOString() };
    const writeEvidence = (configDir: string, seal?: string, mode: number = 0o600) =>
      writeFileSync(join(configDir, MEMBER_FILE_IAM_EVIDENCE_NAME), JSON.stringify(seal === undefined ? base : { ...base, seal }), { mode });
    const run = async (configDir: string) => {
      const { store, puts } = fakeStore();
      const result = publishMemberFile({ configDir, filePath: path, handle: 'demo',
        deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store, resolveIdentity: () => principal } });
      return { store, puts, result };
    };
    // ⑴ 통과: 정규 파일·0600·RES seal 키로 봉인된 증거만 허용한다.
    {
      const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'], objectCreatorGrants: grants } }, null);
      writeEvidence(configDir, sealEvidence(base));
      const { puts, result } = await run(configDir);
      await result;
      expect(puts.length).toBe(1);
    }
    // ⑵ mode 0644: 그룹/other 가 읽을 수 있는 증거는 보호 출원이 아니다 → 거부.
    {
      const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'], objectCreatorGrants: grants } }, null);
      writeEvidence(configDir, sealEvidence(base), 0o644);
      const { puts, result } = await run(configDir);
      const err = await expectPublishRejects(result);
      expect(err.message).toContain('증거 파일');
      expect(puts.length).toBe(0);
    }
    // ⑶ 심볼릭 링크: 설정 디렉터리 밖 파일을 가리키는 링크 = 출원 조작 → 거부(lstat, 따라가지 않는다).
    {
      const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'], objectCreatorGrants: grants } }, null);
      const outside = mkdtempSync(join(tmpdir(), 'mfp-out-'));
      const target = join(outside, 'evidence.json');
      writeFileSync(target, JSON.stringify({ ...base, seal: sealEvidence(base) }), { mode: 0o600 });
      symlinkSync(target, join(configDir, MEMBER_FILE_IAM_EVIDENCE_NAME));
      const { puts, result } = await run(configDir);
      const err = await expectPublishRejects(result);
      expect(err.message).toContain('증거 파일');
      expect(puts.length).toBe(0);
    }
    // ⑷ seal 부재: 봉인 없는 평문 JSON = RES 가 아니 누구나 쓸 수 있다 → 거부.
    {
      const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'], objectCreatorGrants: grants } }, null);
      writeEvidence(configDir);
      const { puts, result } = await run(configDir);
      const err = await expectPublishRejects(result);
      expect(err.message).toContain('증거 파일');
      expect(puts.length).toBe(0);
    }
    // ⑸ seal 불일치: 다른 키로 봉인(예: 멤버가 임의 키로 자기 증거 위조) → 거부.
    {
      const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'], objectCreatorGrants: grants } }, null);
      writeEvidence(configDir, sealEvidence(base, ATTACKER_PRIVATE_KEY));
      const { puts, result } = await run(configDir);
      const err = await expectPublishRejects(result);
      expect(err.message).toContain('증거 파일');
      expect(puts.length).toBe(0);
    }
    // ⑻차 ③ — ⑹(config seal 키 부재)/⑹b(env 공개 키 덮어쓰기) 폐지: 검증 공개 키 원천이 config/env 에서
    // RES 운영 고정 경로(resEvidencePublicKeyPath)로 이동했다. 부재 fail-closed·env 무시·config 무시는 ⑳⑷⑸⑹ 이관.
    // ⑸b 대칭(HMAC hex) 봉인: ⑦차 mustFix ② — 발행자가 읽을 수 있는 대칭 키로 봉인하는 6차 스킴은 폐지됐다
    // (서명 권한 분리). 예전 HMAC-SHA256 hex 모양의 봉인으로 위조해도 전부 거부된다.
    {
      const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'], objectCreatorGrants: grants } }, null);
      writeEvidence(configDir, createHmac('sha256', 'any-symmetric-key').update(memberFileIamEvidenceCanonical(base)).digest('hex'));
      const { puts, result } = await run(configDir);
      const err = await expectPublishRejects(result);
      expect(err.message).toContain('증거 파일');
      expect(puts.length).toBe(0);
    }
    // (⑹b 원문 삭제 — ⑳⑸/env 덮어쓰기 무시 시험으로 이관)
    // ⑺ 소유자 불일치(st.uid ≠ 실행 uid): root 없이는 타 소유자 파일을 못 만들므로, getuid 를 실제
    // 파일 소유자(자신)와 다른 값으로 잠시 바꿔 거부를 대조한 뒤 즉시 원복한다(구현 readIamEvidence).
    {
      const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'], objectCreatorGrants: grants } }, null);
      writeEvidence(configDir, sealEvidence(base));
      const realGetuid = process.getuid!;
      const foreignUid = realGetuid.call(process) + 1;
      try {
        (process as unknown as { getuid: () => number }).getuid = () => foreignUid;
        const { puts, result } = await run(configDir);
        const err = await expectPublishRejects(result);
        expect(err.message).toContain('증거 파일');
        expect(puts.length).toBe(0);
      } finally {
        (process as unknown as { getuid?: () => number }).getuid = realGetuid;
      }
    }
  });

  test('⑰ 주체 해석(JUD hold 13:33 ①·6차 / ⑧차 ① 이관) — ⑴ gcs 독립 해석 폐지(null — 자격 결속은 ⑲a defaultResolveUploadCredential 몫) ⑵~⑸ JWT 판정 ⑹ local ⑺ CLI 실패 fail-closed null', () => {
    const b64u = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const jwt = (payload: Record<string, unknown>) => `${b64u({ alg: 'RS256', typ: 'JWT' })}.${b64u(payload)}.sig`;
    const gcsCfg = { provider: 'gcs' } as Parameters<typeof defaultResolveUploadIdentity>[0];
    // ⑴ ⑧차 ① — gcs 신원은 업로드 자격과 '같은 ADC 인스턴스'에서 나와야 한다(⑲a). 앰비언트 독립 해석은 폐지.
    expect(defaultResolveUploadIdentity(gcsCfg, () => jwt({ email: 'adc-demo@demo.iam', email_verified: true }))).toBeNull();
    // FU(OP #122924 처방 1번) — ⑵-⑹ JWT 신원 토큰 판정은 폐지: print-identity-token 은 gcloud(594.0.0) auth application-default
    // 그룹에 실존하지 않아 런타임이 전부 거부됐다(2026-11-21 e2e 사전점검 RC=1). principal 은 스냅샷 client_email,
    // 접근 토큰은 실존 명령 print-access-token(⑲a·⑳ 참조).
    // ⑹ local — 신원 해석 없이 'local'.
    expect(defaultResolveUploadIdentity({ provider: 'local' } as Parameters<typeof defaultResolveUploadIdentity>[0], () => { throw new Error('no cli'); })).toBe('local');
    // ⑺ CLI 부재/실패 = fail-closed(null — 게시 경로에서 거부).
    const s3Cfg = { provider: 's3', s3: { profile: 'demo' } } as Parameters<typeof defaultResolveUploadIdentity>[0];
    expect(defaultResolveUploadIdentity(s3Cfg, () => { throw new Error('cli missing'); })).toBeNull();
  });
});

describe('JUD hold(16:0x) ⑧차 mustFix — ① 같은 ADC 자격 인스턴스 ② 실행별 배타 토큰 저장 ③ RES 공개 키 신뢰 기점', () => {
  const enc = new TextEncoder();
  const b64u = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const jwt = (payload: Record<string, unknown>) => `${b64u({ alg: 'RS256', typ: 'JWT' })}.${b64u(payload)}.sig`;
  const principal = 'adc-demo-objectcreator@demo.iam';
  const grants = [{ principal, bucket: 'pub-bucket' }];
  const evidence = { principal, bucket: 'pub-bucket', roles: [CREATOR_ROLE], policyHash: 'policy-hash-1', at: new Date().toISOString() };
  const gcsCfg = { provider: 'gcs' } as Parameters<typeof defaultResolveUploadCredential>[0];
  const adcDir = mkdtempSync(join(tmpdir(), 'mfq-adc-'));
  const adcPath = join(adcDir, 'application_default_credentials.json');
  writeFileSync(adcPath, enc.encode('{"type":"service_account","client_email":"adc-demo-objectcreator@demo.iam"}'), { mode: 0o600 });
  const ADC_BYTES = readFileSync(adcPath);

  test('⑲a ① 같은 ADC 자격 인스턴스(client_email 결속 · OP #122924 처방 1번) — ⑴ gcloud 호출은 실존 명령 print-access-token 단 1회 ⑵ principal=스냅샷 client_email(JWT 신원 토큰 호출 폐지) ⑶ 호출 핀 경로=실행별 비공개 스냅샷·본문=원본 ADC ⑷ client_email 부재 스냅샷 = null(호출 0회) ⑸ ADC 원본 부재 = null(호출 0회) ⑹ 비 gcs = null ⑺ 스냅샷 정리', () => {
    const seen: Array<{ args: readonly string[]; config: string; gac: string; snapshot: Buffer }> = [];
    const exec = (file: string, args: readonly string[], env: NodeJS.ProcessEnv): string => {
      expect(file).toBe('gcloud');
      seen.push({ args, config: String(env.CLOUDSDK_CONFIG), gac: String(env.GOOGLE_APPLICATION_CREDENTIALS), snapshot: readFileSync(env.GOOGLE_APPLICATION_CREDENTIALS as string) });
      return args[2] === 'print-access-token' ? 'tok-⑲' : '';
    };
    const out = defaultResolveUploadCredential(gcsCfg, { env: {}, adcCredentialPath: () => adcPath, exec });
    expect(out?.principal).toBe(principal); // ⑵ 스냅샷의 client_email — 신원 토큰(JWT) 호출은 폐지
    expect(out?.accessToken).toBe('tok-⑲');
    expect(seen.length).toBe(1); // ⑴ gcloud 호출은 print-access-token 단 한 번
    expect(seen[0]!.args).toEqual(['auth', 'application-default', 'print-access-token']);
    // ⑶ 같은 자격 인스턴스: 호출의 핀 경로가 실행별 비공개 스냅샷이고 본문이 원본 ADC 와 같다(앰비언트 재해석 금지).
    expect(seen[0]!.config.startsWith(join(tmpdir(), 'mf-adc-'))).toBe(true);
    expect(seen[0]!.snapshot.equals(ADC_BYTES)).toBe(true);
    // JUD HOLD #123912(OP #123914) mustFix ② — 결속 두 변수는 '같은 스냅샷'을 가리킨다: GAC 경로의 상위 = CLOUDSDK_CONFIG.
    expect(dirname(seen[0]!.gac)).toBe(seen[0]!.config);
    // ⑺ 해석 뒤 스냅샷 디렉터리는 정리된다(자격 복제본이 남지 않는다).
    expect(existsSync(seen[0]!.config)).toBe(false);
    // ⑷ client_email 부재 스냅샷 = 신원 증명 불가 = gcloud 호출 없이 null(fail-closed).
    const noEmailDir = mkdtempSync(join(tmpdir(), 'mfq-noemail-'));
    const noEmailPath = join(noEmailDir, 'application_default_credentials.json');
    writeFileSync(noEmailPath, enc.encode('{"type":"authorized_user","refresh_token":"fixture"}'), { mode: 0o600 });
    const seenNoEmail: Array<readonly string[]> = [];
    expect(defaultResolveUploadCredential(gcsCfg, {
      env: {}, adcCredentialPath: () => noEmailPath,
      exec: (file, args) => { seenNoEmail.push(args); return 'tok-⑲'; },
    })).toBeNull();
    expect(seenNoEmail.length).toBe(0);
    // ⑸ ADC 원본 부재 = null(gcloud 호출 없음).
    const seenMissing: Array<readonly string[]> = [];
    expect(defaultResolveUploadCredential(gcsCfg, {
      env: {}, adcCredentialPath: () => join(adcDir, 'missing.json'),
      exec: (file, args) => { seenMissing.push(args); return 'x'; },
    })).toBeNull();
    expect(seenMissing.length).toBe(0);
    // ⑹ 비 gcs(local 등)는 자격 결속 대상이 아니다(null — publishMemberFile 은 gcs 에서만 부른다).
    expect(defaultResolveUploadCredential({ provider: 'local' } as Parameters<typeof defaultResolveUploadCredential>[0], { env: {}, exec: () => 'x' })).toBeNull();
  });

  // JUD HOLD #123912(OP #123914 원문) mustFix ① — 스냅샷 자격 JSON의 type 이 service_account 인 경우만 principal
  // 결속 표면(client_email)으로 인정한다: authorized_user 등 다른 자격 유형은 client_email 이 있어도 gcloud 호출 0회로
  // 즉시 거부한다(fail-closed). 다른 유형의 client_email 로 업로드를 서명하게 두면 주체 결속이 자격 유형과 어긋난다.
  test('⑲c JUD HOLD #123912 mustFix ① type=service_account 강제 — ⑴ authorized_user(client_email 있음) = null·gcloud 0회 ⑵ type 부재(client_email 있음) = null·gcloud 0회 ⑶ service_account 는 통과', () => {
    const snapshot = (adc: Record<string, unknown>): string => {
      const dir = mkdtempSync(join(tmpdir(), 'mfq-type-'));
      const path = join(dir, 'application_default_credentials.json');
      writeFileSync(path, enc.encode(JSON.stringify(adc)), { mode: 0o600 });
      return path;
    };
    // ⑴ authorized_user — client_email 이 있어도 다른 자격 유형이면 gcloud 호출에 닿기 전에 거부(fail-closed).
    {
      const calls: Array<readonly string[]> = [];
      const out = defaultResolveUploadCredential(gcsCfg, {
        env: {},
        adcCredentialPath: () => snapshot({ type: 'authorized_user', client_email: principal, client_id: 'fixture.apps.googleusercontent.com', refresh_token: 'fixture' }),
        exec: (file, args) => { calls.push(args); return 'tok-⑲c'; },
      });
      expect(out).toBeNull();
      expect(calls.length).toBe(0); // gcloud spawn 0회
    }
    // ⑵ type 필드 부재(모양을 알 수 없는 자격 유형) — 마찬가지로 gcloud 없이 거부.
    {
      const calls: Array<readonly string[]> = [];
      const out = defaultResolveUploadCredential(gcsCfg, {
        env: {},
        adcCredentialPath: () => snapshot({ client_email: principal, private_key: 'fixture' }),
        exec: (file, args) => { calls.push(args); return 'tok-⑲c'; },
      });
      expect(out).toBeNull();
      expect(calls.length).toBe(0);
    }
    // ⑶ service_account — 통과: principal=스냅샷 client_email · 접근 토큰은 실존 명령 1회 호출로(⑲a 와 같은 경로).
    {
      const calls: Array<readonly string[]> = [];
      const out = defaultResolveUploadCredential(gcsCfg, {
        env: {},
        adcCredentialPath: () => snapshot({ type: 'service_account', client_email: principal, private_key: 'fixture' }),
        exec: (file, args) => { calls.push(args); return 'tok-⑲c'; },
      });
      expect(out?.principal).toBe(principal);
      expect(out?.accessToken).toBe('tok-⑲c');
      expect(calls).toEqual([['auth', 'application-default', 'print-access-token']]);
    }
  });

  // ⑳(r1 게이트 FOCUSED_NEW_FAILURE 계기): 게이트·CI 러너 환경에는 gcloud 가 없다(Executable not found in $PATH — PREGATE-RED/39475-…-224552 focused.raw 원문).
  // 계약 실측은 gcloud 가 있는 실행 환경(로컬·e2e)에서만 가능하므로, gcloud 부재·호출 실패 시 skip(fail 이 아니다).
  const gcloudApplicationDefaultHelp: string | null = (() => {
    try {
      return execFileSync('gcloud', ['auth', 'application-default', '--help'], { encoding: 'utf8', timeout: 15_000 });
    } catch {
      return null; // ENOENT(게이트·CI PATH 부재)·그 외 실패 — 이 환경에서는 계약 실측 불가
    }
  })();
  test.skipIf(gcloudApplicationDefaultHelp === null)(
    '⑳ 실존 명령 계약(OP #122924 처방 1번) — 이 모듈이 부르는 gcloud 하위명령은 실제 gcloud 도움말에 존재한다. print-identity-token(실존하지 않는 하위명령 — e2e 사전점검 RC=1 거부 계기)은 다시는 안 부른다. gcloud 부재 환경(게이트·CI)에서는 skip — 계약 실측은 gcloud 있는 실행 환경에서만.',
    () => {
      const help = gcloudApplicationDefaultHelp as string;
      expect(help).toContain('print-access-token'); // defaultResolveUploadCredential 이 부르는 유일한 auth 하위명령
      expect(help).not.toContain('print-identity-token'); // gcloud(594.0.0) auth application-default 그룹에 없다
    },
  );

  // JUD HOLD #123912(OP #123914) mustFix ② — ⑳(--help 존재 확인)만으로는 부족하다: '고정 스냅샷에서 실제 토큰을 얻는
  // 자격 선택 경로'를 증명한다. ⑳b 는 목업 없이 진짜 자식 프로세스(defaultEnvSyncExec → execFileSync)를 띄운다 —
  // 스텁 gcloud(PATH 우선)가 결속 환경변수(CLOUDSDK_CONFIG=<스냅샷 config dir>·GOOGLE_APPLICATION_CREDENTIALS=<스냅샷 JSON 경로>)
  // 로 가리킨 파일 원문을 '토큰'으로 돌려주고, 그 토큰이 고정 스냅샷에서 왔음을 본문 대조로 증명한다. gcloud 여부와
  // 무관(스텁) — 게이트 러너에서도 실행된다.
  test('⑳b mustFix ② 스냅샷 결속 env 실전 전달 — 스텁 gcloud 자식 프로세스가 고정 스냅샷에서 토큰을 도출(principal=client_email·토큰=스냅샷 원문)', () => {
    const stubDir = mkdtempSync(join(tmpdir(), 'mfq-stub-'));
    writeFileSync(join(stubDir, 'gcloud'), [
      '#!/bin/sh',
      'set -eu',
      'cfg="${CLOUDSDK_CONFIG:?CLOUDSDK_CONFIG missing}"', // 스냅샷 config dir 결속
      'gac="${GOOGLE_APPLICATION_CREDENTIALS:?GOOGLE_APPLICATION_CREDENTIALS missing}"', // 스냅샷 JSON 경로 결속
      'test -f "$cfg/application_default_credentials.json" || exit 10', // config dir 안 스냅샷 파일 확인
      'cat "$gac"',
      '',
    ].join('\n'), { flag: 'wx', mode: 0o755 });
    const snapshotJson = JSON.stringify({ type: 'service_account', client_email: principal, private_key: 'fixture' });
    const snapshotDir = mkdtempSync(join(tmpdir(), 'mfq-snap-'));
    const snapshotPath = join(snapshotDir, 'application_default_credentials.json');
    writeFileSync(snapshotPath, enc.encode(snapshotJson), { mode: 0o600 });
    const realPath = process.env.PATH;
    process.env.PATH = `${stubDir}${realPath ? ':' : ''}${realPath ?? ''}`; // 진짜 자식 프로세스 해석 — 스텁이 우선. 복구는 finally.
    try {
      const out = defaultResolveUploadCredential(gcsCfg, { env: { PATH: process.env.PATH }, adcCredentialPath: () => snapshotPath });
      expect(out?.principal).toBe(principal);
      // 자식 프로세스가 결속 변수로 읽어 돌려준 '토큰' 원문 === 고정 스냅샷 파일 원문 — 토큰은 그 스냅샷에서 왔다.
      expect(out?.accessToken).toBe(snapshotJson);
    } finally {
      if (realPath === undefined) delete process.env.PATH; else process.env.PATH = realPath;
      rmSync(stubDir, { recursive: true, force: true });
      rmSync(snapshotDir, { recursive: true, force: true });
    }
  });

  // JUD HOLD #123912 mustFix ② — 실존 gcloud 자식 프로세스 경로: 결속 환경변수가 실전 gcloud 에 그대로 전달되고
  // (래핑 exec 가 env 를 기록·실전 execFileSync 로 위임), 실존 gcloud 는 그 고정 스냅샷만 본다 — bogus 개인키
  // 스냅샷에서는 토큰을 못 얻는다(fail-closed). 실행 환경에 유효한 앰비언트 ADC 가 있어도 쓰지 않는다: 결속이
  // 없었다면 앰비언트 자격으로 실 토큰이 나왔을 것이므로, null 결과가 곧 '실전에서도 결속이 지켜진다'의 증명이다.
  // gcloud 부재 환경(게이트 러너)에서는 ⑳ 과 같은 skip 경계.
  test.skipIf(gcloudApplicationDefaultHelp === null)(
    '⑳c mustFix ② 실존 gcloud 자격 선택 경로 — 결속 env 실전 전달·고정 스냅샷(bogus 키) = 토큰 없음(fail-closed null)',
    () => {
      const fixtureDir = mkdtempSync(join(tmpdir(), 'mfq-real-'));
      const bogusSnapshotPath = join(fixtureDir, 'application_default_credentials.json');
      writeFileSync(bogusSnapshotPath, enc.encode(JSON.stringify({
        type: 'service_account',
        client_email: 'mfq-fixture-sa@fixture.iam',
        private_key: '-----BEGIN PRIVATE KEY-----\nZm9v\n-----END PRIVATE KEY-----\n',
      })), { mode: 0o600 });
      const delivered: Array<{ file: string; args: readonly string[]; config: string | undefined; gac: string | undefined }> = [];
      const recordAndDelegate = (file: string, args: readonly string[], env: NodeJS.ProcessEnv): string => {
        delivered.push({ file, args, config: env.CLOUDSDK_CONFIG, gac: env.GOOGLE_APPLICATION_CREDENTIALS });
        return execFileSync(file, [...args], { encoding: 'utf8', timeout: 15_000, env }); // 실전 자식 프로세스(gcloud)
      };
      try {
        const out = defaultResolveUploadCredential(gcsCfg, { env: process.env, adcCredentialPath: () => bogusSnapshotPath, exec: recordAndDelegate });
        // ⑴ 결속 환경변수가 실전 gcloud 자식 프로세스에 전달됐다 — GAC 경로의 상위 = CLOUDSDK_CONFIG(스냅샷 config dir).
        expect(delivered.length).toBe(1);
        expect(delivered[0]!.file).toBe('gcloud');
        expect(delivered[0]!.args).toEqual(['auth', 'application-default', 'print-access-token']);
        expect(typeof delivered[0]!.config).toBe('string');
        expect(typeof delivered[0]!.gac).toBe('string');
        expect(dirname(String(delivered[0]!.gac))).toBe(String(delivered[0]!.config));
        expect(String(delivered[0]!.gac).startsWith(join(tmpdir(), 'mf-adc-'))).toBe(true);
        // ⑵ 그 고정 스냅샷(bogus 개인키)에서 실존 gcloud 는 토큰을 못 얻는다 → null(fail-closed · 앰비언트 자격 미사용).
        expect(out).toBeNull();
      } finally {
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    },
  );

  test('⑲b ② 실행별 배타 토큰 저장 — ⑴ 동시 2 게시 혼선 0(경로 상이·내용 각자·0600·상위 0700·configDir 밖) ⑵ 게시 뒤 임시 정리 ⑶ 자격(토큰) 해석 실패 = 거부·put 0', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'mfq-fa-'));
    const fileA = join(dirA, 'a.txt'); writeFileSync(fileA, enc.encode('a'));
    const dirB = mkdtempSync(join(tmpdir(), 'mfq-fb-'));
    const fileB = join(dirB, 'b.txt'); writeFileSync(fileB, enc.encode('b'));
    const record: Array<{ path?: string; content: string; mode: number; dirMode: number }> = [];
    const tick = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    const storeFor = (): ObjectStore => {
      const base = fakeStore();
      return {
        ...base.store,
        async put(_key: string, _body: Uint8Array, opts?: { contentType?: string; public?: boolean; gcsAccessTokenFile?: string }) {
          const file = opts?.gcsAccessTokenFile;
          record.push({
            path: file,
            content: file ? readFileSync(file, 'utf8') : '',
            mode: file ? lstatSync(file).mode & 0o777 : -1,
            dirMode: file ? lstatSync(dirname(file)).mode & 0o777 : -1,
          });
          await tick(); // 중간 양보 — 다른 게시의 쓰기와 교차해도 서로 파일을 침범하지 않는다.
        },
      } as unknown as ObjectStore;
    };
    const configA = tempConfigDir({ provider: 'gcs', memberFilePublish: { testHandles: ['demo'], objectCreatorGrants: grants } }, evidence);
    const configB = tempConfigDir({ provider: 'gcs', memberFilePublish: { testHandles: ['demo'], objectCreatorGrants: grants } }, evidence);
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith('member-file-upload-'));
    await Promise.all([
      publishMemberFile({ configDir: configA, filePath: fileA, handle: 'demo',
        deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store: storeFor(), resolveUploadCredential: async () => ({ principal, accessToken: 'tok-A' }) } }),
      publishMemberFile({ configDir: configB, filePath: fileB, handle: 'demo',
        deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store: storeFor(), resolveUploadCredential: async () => ({ principal, accessToken: 'tok-B' }) } }),
    ]);
    expect(record.length).toBe(2);
    // ⑴ 고정 경로 재사용 금지 — 실행별 경로 상이(동시 혼선 0: 각자 자기 토큰 파일을 본다).
    expect(record[0]!.path).not.toBe(record[1]!.path);
    expect([...record.map((entry) => entry.content)].sort()).toEqual(['tok-A\n', 'tok-B\n']);
    for (const entry of record) {
      expect(entry.mode).toBe(0o600);   // 배타 생성(O_EXCL — 기존 파일 이어쓰기·mode 미갱신 문제 없음)
      expect(entry.dirMode).toBe(0o700); // 상위 디렉터리도 실행별 비공개
      expect(dirname(entry.path as string)).not.toBe(configA);
      expect(dirname(entry.path as string)).not.toBe(configB);
    }
    // ⑵ 게시 뒤 이 실행들의 임시 디렉터리는 전부 정리된다(토큰이 남지 않는다).
    const after = readdirSync(tmpdir()).filter((name) => name.startsWith('member-file-upload-'));
    expect(after.filter((name) => !before.includes(name)).length).toBe(0);
    // ⑶ 자격 해석 실패 = 거부(fail-closed) — put 0.
    {
      const configDir = tempConfigDir({ provider: 'gcs', memberFilePublish: { testHandles: ['demo'], objectCreatorGrants: grants } }, evidence);
      const { store, puts } = fakeStore();
      const err = await expectPublishRejects(publishMemberFile({ configDir, filePath: fileA, handle: 'demo',
        deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store, resolveUploadCredential: async () => null } }));
      expect(err.message).toContain('자격');
      expect(puts.length).toBe(0);
    }
  });

  test('⑳ ③ RES 공개 키 신뢰 기점 — ⑴ 고정 경로(0444) 검증 통과·원장 기록 ⑵ 쓰기 비트(0644) 거부 ⑶ 심볼릭 링크 거부 ⑷ 경로 부재 fail-closed ⑸ env 덮어쓰기 무시 ⑹ config 키 무시(경로 우선)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mfq-pk-'));
    const file = join(dir, 'ok.txt');
    writeFileSync(file, enc.encode('ok'));
    const localEvidence = { principal: 'local', bucket: 'pub-bucket', roles: [CREATOR_ROLE], policyHash: 'policy-hash-1', at: new Date().toISOString() };
    const pubkeyFile = (mode: number): string => {
      const holder = mkdtempSync(join(tmpdir(), 'mfq-pkfile-'));
      const path = join(holder, 'member-file-evidence-pubkey.spki.b64');
      writeFileSync(path, `${resPubB64}\n`, { mode });
      return path;
    };
    type PublishDeps = NonNullable<Parameters<typeof publishMemberFile>[0]['deps']>;
    const run = (configDir: string, extra: Record<string, unknown> = {}) => {
      const { store, puts } = fakeStore();
      return {
        puts,
        result: publishMemberFile({ configDir, filePath: file, handle: 'demo',
          deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store, ...extra } as unknown as PublishDeps }),
      };
    };
    // ⑴ 통과: RES 고정 경로 픽스처(0444)로 검증 — 원장에 경로+mode 가 기록된다.
    {
      const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'] } }, localEvidence);
      const path0444 = pubkeyFile(0o444);
      const { puts, result } = run(configDir, { resEvidencePublicKeyPath: path0444 });
      await result;
      expect(puts.length).toBe(1);
      const entry = JSON.parse(readFileSync(join(configDir, 'member-file-publish.jsonl'), 'utf8').split('\n').filter(Boolean)[0]!) as { iam?: { evidencePubkeyPath?: string; evidencePubkeyMode?: string } };
      expect(entry.iam?.evidencePubkeyPath).toBe(path0444);
      expect(entry.iam?.evidencePubkeyMode).toBe('0444');
    }
    // ⑵ 쓰기 비트가 있으면(0644) RES 운영 경계 아님 — 소유자(발행자)가 교체할 수 있는 키는 신뢰 기점이 못 된다 → 거부.
    {
      const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'] } }, localEvidence);
      const { puts, result } = run(configDir, { resEvidencePublicKeyPath: pubkeyFile(0o644) });
      const err = await expectPublishRejects(result);
      expect(err.message).toContain('증거 파일');
      expect(puts.length).toBe(0);
    }
    // ⑶ 심볼릭 링크 = 경로 조작 → 거부(lstat — 따라가지 않는다).
    {
      const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'] } }, localEvidence);
      const target = pubkeyFile(0o444);
      const link = join(dir, 'link.spki.b64');
      symlinkSync(target, link);
      const { puts, result } = run(configDir, { resEvidencePublicKeyPath: link });
      const err = await expectPublishRejects(result);
      expect(err.message).toContain('증거 파일');
      expect(puts.length).toBe(0);
    }
    // ⑷ 경로 부재(RES 미설치) = 검증 자체가 불가능 → fail-closed 거부.
    {
      const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'] } }, localEvidence);
      const { puts, result } = run(configDir, { resEvidencePublicKeyPath: join(dir, 'nope.spki.b64') });
      const err = await expectPublishRejects(result);
      expect(err.message).toContain('증거 파일');
      expect(puts.length).toBe(0);
    }
    // ⑸ env 덮어쓰기(ELANOUS_MEMBER_FILE_EVIDENCE_PUBKEY)는 무시된다: 경로 부재 상태 그대로 거부.
    {
      const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'] } }, localEvidence);
      const { puts, result } = run(configDir, { resEvidencePublicKeyPath: join(dir, 'nope2.spki.b64'), env: { ELANOUS_MEMBER_FILE_EVIDENCE_PUBKEY: resPubB64 } });
      const err = await expectPublishRejects(result);
      expect(err.message).toContain('증거 파일');
      expect(puts.length).toBe(0);
    }
    // ⑹ config evidencePublicKey 자리(공격자 키)도 무시된다 — 검증은 RES 경로의 키로만 한다.
    {
      const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'], evidencePublicKey: ATTACKER_PUB_B64 } }, localEvidence);
      const { puts, result } = run(configDir);
      await result;
      expect(puts.length).toBe(1);
    }
  });
});
// JUD hold ⑨차(#121287) · OP #121289 — 고정 검증 키: 공개 키 파일은 '코드 상수 핀 지문'과 일치할 때만 검증에 쓴다.
// 파일 권한(mode·쓰기 실패)은 참고 경계일 뿐 신뢰 기점이 아니다(JUD 9차 지적) — 지문 불일치 = 그 파일은 RES 발행 키가 아니므로 거부.
describe('JUD hold ⑨차(OP #121289) — 고정 검증 키: 공개 키 파일은 핀 지문(sha256(SPKI DER))과 일치할 때만 사용', () => {
  test('㉑a 핀 지문 상수 = RES 발행 지문(우편 #121293 · sha256(SPKI DER 원바이트))', () => {
    expect(MEMBER_FILE_EVIDENCE_PUBKEY_SHA256).toBe('51286c51c2f9cbfe30fe8e38f03ea2349b947c76dc14bd5e2990083423ee0882');
  });

  test('㉑b 파일 내용 지문 ≠ 핀 → 거부(put 0) · 일치 → 통과(put 1) · 원장 1줄에 검증 지문 기록', async () => {
    const doc = (): string => {
      const dir = mkdtempSync(join(tmpdir(), 'mfp9-'));
      const p = join(dir, 'doc.txt');
      writeFileSync(p, new TextEncoder().encode('ok'));
      return p;
    };
    // 1) 불일치: 같은 0444 경계 파일이라도 내용 지문이 핀과 다르면(= 교체됐으면) 검증 거부(fail-closed).
    {
      const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'] } });
      const { store, puts } = fakeStore();
      await expectPublishRejects(publishMemberFile({ configDir, filePath: doc(), handle: 'demo',
        deps: { resEvidencePublicKeyPath: PUBKEY, resEvidencePubkeySha256: 'ab'.repeat(32), env: {}, store } }));
      expect(puts.length).toBe(0);
      expect(existsSync(join(configDir, 'member-file-publish.jsonl'))).toBe(false);
    }
    // 2) 일치: 통과 + 원장 1줄에 검증에 쓴 실제 지문이 기록된다(감사 대조 — 코드 핀과 대조 가능).
    {
      const configDir = tempConfigDir({ memberFilePublish: { testHandles: ['demo'] } });
      const { store, puts } = fakeStore();
      await publishMemberFile({ configDir, filePath: doc(), handle: 'demo',
        deps: { resEvidencePubkeySha256: RES_PUBKEY_SHA256, resEvidencePublicKeyPath: PUBKEY, env: {}, store } });
      expect(puts.length).toBe(1);
      const entry = JSON.parse(readFileSync(join(configDir, 'member-file-publish.jsonl'), 'utf8').split('\n').filter(Boolean)[0]!) as { iam?: { evidencePubkeySha256?: string } };
      expect(entry.iam?.evidencePubkeySha256).toBe(RES_PUBKEY_SHA256);
    }
  });
});
