// ── elanous config sync-test — 운영→테스트 config 물질화 동기화 (ISO-1 · 2026-07-13) ──
//
// 격리 테스트 인스턴스의 config 완전 분리(대표 결정 2026-07-13). 종전에는 테스트
// 데몬이 **운영 config 를 공유**하고 in-memory overlay(buildTestSafeDaemonConfig)로
// 아웃바운드만 가렸다 — overlay 뷰가 디스크에 박제되는 오염 사건(#4029)과 "공유
// config write-through" 함정의 뿌리. 이제:
//
//   ~/.elanous/config.json            ← 운영 유일 진실원 (테스트 프로세스 무접촉)
//   <repo>/.elanous-test/config.json  ← 이 CLI 가 변환·물질화한 테스트 사본
//
// 변환은 **raw JSON 레벨** — 정규화(getUserConfig)를 거치지 않아 미지 필드가
// 보존된다(정규화 저장이 필드를 조용히 떨어뜨리는 사고 클래스 회피). 정책은
// buildTestSafeDaemonConfig 와 아웃바운드 정책 파리티(시험으로 고정), 추가로 평문 비밀 제거:
//   • telegram.botToken → testChannel.botToken (없으면 telegram off)
//   • 운영 아웃바운드 경로 제거 (reportChannel · homeChannel · channels)
//   • discord off · 평문 비밀 필드 재귀 제거
//   • 채널 탭(telegram:* · discord:*)의 tokenRef 제거 — 🩸 2026-09-27: 봇 토큰이 탭 tokenRef 로 옮겨간 뒤(#20732)
//     `resolveChannelBotToken` 이 tokenRef 를 먼저 풀어 «시험 봇 스왑»을 무시하고 운영 봇을 격리 우주에 줬다.
//   • secrets.json 은 «그대로»가 아니라 아웃바운드 자격(채널 탭 봇 토큰 · 웹 푸시 VAPID)을 뺀 사본으로.
//
// 부속 파일 복사 정책(대표 지시 "현재 그대로 복사"):
//   • 복사 = 연산/인바운드에 필요한 것 (LLM 키·oauth·identity)
//   • 제외 = 아웃바운드 자격(apns/pushcut — 테스트가 실기기 푸시 발송 금지)과
//     무장류(autopilot/finance mandate — 부재 시 fail-closed=DISARMED 가 테스트의
//     안전 기본값) · 상태 DB(테스트는 빈 우주에서 시작)

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import { isSecretRef, secretIdFromRef } from '../nexus/config/types.js';

/** 운영 config 루트(항상 실 운영 — --config-dir 오버라이드와 무관하게 원본을 읽는다). */
export function prodConfigDir(): string {
  return join(homedir(), '.elanous');
}

/** 그대로 복사할 부속 파일 (운영 config dir 상대). 없는 파일은 조용히 스킵. */
export const TEST_SYNC_AUX_FILES: readonly string[] = [
  'secrets.json',      // LLM/서비스 키 — 에이전트 턴에 필요 (아웃바운드 자격은 빼고 쓴다 — testSyncExcludedSecretIds)
  'llm-fallback.json', // 모델 폴백 체인
  'auth.json',         // oauth 자격 (LLM provider)
  'identity.json',     // self identity — 무해·자기인식 일관
  // POL1 (10-01): the LLM policy (credit use · pace · grants). Without it a tree's test universe resolved «fallback»
  // while production said «credits», and every harness run from a work tree went to grok.
  'policy/llm.yaml',
];

/** 의도적 제외 (복사 금지 — 이유 명시. 목록 변경 시 반드시 사유와 함께). */
export const TEST_SYNC_EXCLUDED: ReadonlyArray<{ file: string; reason: string }> = [
  { file: 'apns.p8', reason: '실기기 푸시 발송 자격 — 테스트 아웃바운드 금지' },
  { file: 'pushcut.json', reason: '실기기 푸시 발송 자격 — 테스트 아웃바운드 금지' },
  { file: 'autopilot.json', reason: '자율 무장 — 부재=fail-closed(DISARMED)가 테스트 기본' },
  { file: 'autopilot-materialize-mandate.json', reason: '무장류 — 동상' },
  { file: 'finance-trade-mandate.json', reason: '매매 무장 — 동상' },
];

const SECRET_KEY_PATTERN = /^(apiKey|botToken|token|secret|password|clientSecret|webhookSecret|accessToken|refreshToken)$/i;

/** 봇 토큰을 tokenRef 로 드는 채널 탭 id(`telegram:1` · `discord:1` …). */
const CHANNEL_TAB_ID = /^(telegram|discord):/;
/** 웹 푸시 VAPID 쌍 — 격리 우주는 부재 시 자기 쌍을 새로 만든다(`src/web-push/vapid-keys.ts`). */
const VAPID_SECRET_PREFIX = 'pwa-push-vapid-';

/** 운영 secrets.json 에서 격리 사본에 넣지 않을 비밀 id — 채널 탭이 참조하는 봇 토큰 ⊕ VAPID. */
export function testSyncExcludedSecretIds(raw: Record<string, unknown>, secretIds: readonly string[]): string[] {
  const refd = new Set<string>();
  const tabs = raw.tabs && typeof raw.tabs === 'object' && !Array.isArray(raw.tabs) ? raw.tabs as Record<string, unknown> : {};
  for (const [id, tab] of Object.entries(tabs)) {
    if (!CHANNEL_TAB_ID.test(id) || !tab || typeof tab !== 'object') continue;
    const ref = (tab as Record<string, unknown>).tokenRef;
    const sid = isSecretRef(ref) ? secretIdFromRef(ref as string) : null;
    if (sid) refd.add(sid);
  }
  return secretIds.filter((sid) => refd.has(sid) || /^(telegram|discord)_\d+__tokenRef$/.test(sid) || sid.startsWith(VAPID_SECRET_PREFIX));
}

/** raw JSON dict 레벨 test-safe 변환 — 미지 필드는 보존하고 평문 비밀만 제거한다. */
export function buildTestSafeRawConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  const tg = { ...((raw.telegram ?? {}) as Record<string, unknown>) };
  const testChannel = (tg.testChannel ?? {}) as Record<string, unknown>;
  const testToken = typeof testChannel.botToken === 'string' ? testChannel.botToken.trim() : '';
  const testAllow = Array.isArray(testChannel.allowedUsers) ? testChannel.allowedUsers : undefined;
  if (testToken.length > 0) {
    tg.botToken = testToken;
    if (testAllow && testAllow.length > 0) tg.allowedUsers = testAllow;
  } else {
    tg.enabled = false;
  }
  if (tg.testChannel && typeof tg.testChannel === 'object' && !Array.isArray(tg.testChannel)) {
    const safeTestChannel = { ...testChannel };
    if (testToken.length > 0 && !testToken.startsWith('secret://')) delete safeTestChannel.botToken;
    tg.testChannel = safeTestChannel;
  }
  delete tg.reportChannel;
  delete tg.homeChannel;
  delete tg.channels;
  out.telegram = tg;
  out.discord = { ...((raw.discord ?? {}) as Record<string, unknown>), enabled: false };

  const paths: string[] = [];
  if (raw.tabs && typeof raw.tabs === 'object' && !Array.isArray(raw.tabs)) {
    const tabs: Record<string, unknown> = {};
    for (const [id, tab] of Object.entries(raw.tabs as Record<string, unknown>)) {
      if (CHANNEL_TAB_ID.test(id) && tab && typeof tab === 'object' && !Array.isArray(tab) && 'tokenRef' in tab) {
        const { tokenRef: _dropped, ...rest } = tab as Record<string, unknown>;
        paths.push(`tabs.${id}.tokenRef`);
        Object.defineProperty(tabs, id, { value: rest, enumerable: true, writable: true, configurable: true });
      } else {
        Object.defineProperty(tabs, id, { value: tab, enumerable: true, writable: true, configurable: true });
      }
    }
    out.tabs = tabs;
  }
  const strip = (value: unknown, path: string): unknown => {
    if (Array.isArray(value)) return value.map((item, i) => strip(item, `${path}[${i}]`));
    if (value === null || typeof value !== 'object') return value;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (SECRET_KEY_PATTERN.test(key) && typeof child === 'string' && !child.startsWith('secret://')
        && !(path === 'telegram' && key === 'botToken' && testToken.length > 0)) {
        paths.push(childPath);
        continue;
      }
      // `__proto__` 등 특수 키도 «자기 필드»로 보존한다(대입은 프로토타입을 바꾸고 필드를 잃는다).
      Object.defineProperty(result, key, { value: strip(child, childPath), enumerable: true, writable: true, configurable: true });
    }
    return result;
  };
  const safe = strip(out, '') as Record<string, unknown>;
  safe._testSecretsStripped = paths.length;
  debug.log('config.test-sync', 'secrets-stripped', { count: paths.length, paths });
  return safe;
}

export interface TestSyncResult {
  testConfigPath: string;
  copied: string[];
  skippedMissing: string[];
  /** 대상이 이미 바이트 동일해 복사하지 않은 파일(읽기 전용 대상도 여기로 — EACCES 로 뒤 파일이 끊기지 않게). */
  skippedIdentical: string[];
  telegramMode: 'test-token' | 'disabled';
  /** 사본의 _testSecretsStripped (syncTestConfig 가 채운다). */
  testSecretsStripped?: number;
}

/** cwd 에서 위로 걸어 올라가 레포 루트(.git 보유 dir)를 찾는다. 못 찾으면 null. */
export function findRepoRootUp(cwd: string): string | null {
  let dir = cwd;
  for (let i = 0; i < 30; i++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

/** 운영 config → <testDir>/config.json 물질화 + 부속 복사. 순수 파일 연산 —
 *  데몬/오버레이 무관. 반환 = 요약(호출측이 출력). */
export function syncTestConfig(testDir: string, srcDir: string = prodConfigDir()): TestSyncResult {
  const srcPath = join(srcDir, 'config.json');
  const raw = JSON.parse(readFileSync(srcPath, 'utf-8')) as Record<string, unknown>;
  const transformed = buildTestSafeRawConfig(raw); // 운영 비밀을 제거한 뒤에만 사본을 저장한다.
  transformed._testSyncedFrom = srcPath;
  transformed._testSyncedAt = new Date().toISOString();
  const testConfigPath = join(testDir, 'config.json');
  atomicWriteJson(testConfigPath, transformed);

  const copied: string[] = [];
  const skippedMissing: string[] = [];
  const skippedIdentical: string[] = [];
  for (const f of TEST_SYNC_AUX_FILES) {
    const from = join(srcDir, f);
    if (!existsSync(from)) { skippedMissing.push(f); continue; }
    const to = join(testDir, f);
    if (f === 'secrets.json') {
      const store = JSON.parse(readFileSync(from, 'utf-8')) as { secrets?: Record<string, unknown> } & Record<string, unknown>;
      const all = store.secrets && typeof store.secrets === 'object' ? store.secrets : {};
      const excluded = new Set(testSyncExcludedSecretIds(raw, Object.keys(all)));
      const kept: Record<string, unknown> = {};
      for (const [sid, v] of Object.entries(all)) if (!excluded.has(sid)) kept[sid] = v;
      const body = JSON.stringify(store.secrets && typeof store.secrets === 'object' ? { ...store, secrets: kept } : store, null, 2);
      debug.log('config.test-sync', 'secrets-file-filtered', { kept: Object.keys(kept).length, excluded: [...excluded] });
      if (existsSync(to) && readFileSync(to, 'utf-8') === body) { chmodSync(to, 0o600); skippedIdentical.push(f); continue; }
      mkdirSync(dirname(to), { recursive: true });
      const tmp = `${to}.tmp-${process.pid}`;
      writeFileSync(tmp, body, { mode: 0o600 });
      renameSync(tmp, to);
      chmodSync(to, 0o600);
      copied.push(excluded.size ? `${f}(아웃바운드 자격 ${excluded.size}개 뺌)` : f);
      continue;
    }
    // 🩸 2026-09-24: 대상 `llm-fallback.json` 이 읽기 전용(0444)이라 copyFileSync 가 EACCES 로 던졌고,
    //   목록 뒤의 `auth.json`(codex 로그인)이 복사되지 않아 격리 우주의 자식이 codex 를 못 썼다.
    //   ⇒ 이미 같은 바이트면 건너뛴다(멱등) — 다르면 종전처럼 복사한다(실패는 그대로 드러난다).
    if (existsSync(to) && readFileSync(from).equals(readFileSync(to))) { chmodSync(to, 0o600); skippedIdentical.push(f); continue; }
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    chmodSync(to, 0o600);
    copied.push(f);
  }
  const tg = transformed.telegram as Record<string, unknown>;
  return {
    testConfigPath,
    copied,
    skippedMissing,
    skippedIdentical,
    telegramMode: tg.enabled === false ? 'disabled' : 'test-token',
    testSecretsStripped: transformed._testSecretsStripped as number,
  };
}

/** drift 판정 — 운영 config 파일이 테스트 사본 파일보다 새로우면 true.
 *  파일 mtime 끼리 비교(같은 시계 도메인 — _testSyncedAt 사람용 스탬프는
 *  판정에 안 씀·sub-ms 경합 회피). 테스트 사본 부재 = drift 아님(최초
 *  sync 는 호출측 소관). */
export function isTestConfigStale(testDir: string, srcDir: string = prodConfigDir()): boolean {
  try {
    const testPath = join(testDir, 'config.json');
    if (!existsSync(testPath)) return false;
    return statSync(join(srcDir, 'config.json')).mtimeMs > statSync(testPath).mtimeMs;
  } catch {
    return false;
  }
}

// ── elanous config promote — 테스트→운영 필드 단위 전파 (ISO-4) ─────────────
//
// 테스트 인스턴스에서 조정한 노브를 운영에 반영하는 유일한 정방향 통로.
// **필드 경로 단위 raw patch 만** — 전체 파일 되쓰기는 구조적으로 불가
// (overlay 박제 사건 #4029 의 교훈: 전체 저장이 오염의 문법이다).
// 기본은 dry-run(diff 표시)·적용은 --yes.

/** dotted path 로 raw dict 에서 값 읽기. 없으면 undefined. */
function getRawPath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** dotted path 로 raw dict 에 값 쓰기(중간 객체 생성). */
function setRawPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split('.');
  let cur = obj;
  for (const seg of segs.slice(0, -1)) {
    const next = cur[seg];
    if (!next || typeof next !== 'object') cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1]!] = value;
}

/** 전파 금지 필드 — 테스트 사본에서 운영으로 절대 못 넘어가는 것들.
 *  (테스트 형상 자체이거나, 스왑/제거된 아웃바운드 — 운영에 쓰면 오염) */
export const PROMOTE_DENYLIST_PREFIXES: readonly string[] = [
  'telegram', 'discord', '_testSyncedFrom', '_testSyncedAt',
];

export function isPromotable(path: string): boolean {
  return !PROMOTE_DENYLIST_PREFIXES.some((p) => path === p || path.startsWith(`${p}.`));
}

/** 순수 코어 — 테스트 config 의 <path> 값을 운영 raw 에 patch 한 사본 반환.
 *  운영 파일은 호출측이 원자 저장. */
export function buildPromotedProdConfig(
  prodRaw: Record<string, unknown>,
  testRaw: Record<string, unknown>,
  path: string,
): { next: Record<string, unknown>; before: unknown; after: unknown } {
  const after = getRawPath(testRaw, path);
  if (after === undefined) throw new Error(`테스트 config 에 '${path}' 없음`);
  const before = getRawPath(prodRaw, path);
  const next = structuredClone(prodRaw);
  setRawPath(next, path, after);
  return { next, before, after };
}

/** CLI 진입 — `elanous config promote <path...> [--repo] [--yes]`. 다중 경로(provider 세트 원샷·2026-07-15). */
export function runConfigPromote(paths: readonly string[], opts: { repo?: string; yes?: boolean }): number {
  const list = paths.filter(Boolean);
  if (list.length === 0) { console.error('elanous config promote: 경로 최소 1개 필요'); return 1; }
  const bad = list.filter((p) => !isPromotable(p));
  if (bad.length) {
    console.error(`elanous config promote: 전파 금지 경로 (${PROMOTE_DENYLIST_PREFIXES.join('·')}): ${bad.join(', ')}`);
    return 1;
  }
  const repoRoot = opts.repo ?? findRepoRootUp(process.cwd());
  if (!repoRoot) {
    console.error('elanous config promote: 레포 루트(.git) 미발견 — --repo <path>');
    return 1;
  }
  const testPath = join(repoRoot, '.elanous-test', 'config.json');
  const prodPath = join(prodConfigDir(), 'config.json');
  if (!existsSync(testPath)) {
    console.error(`elanous config promote: 테스트 config 없음 (${testPath}) — 먼저 elanous config sync-test`);
    return 1;
  }
  try {
    const prodRaw = JSON.parse(readFileSync(prodPath, 'utf-8')) as Record<string, unknown>;
    const testRaw = JSON.parse(readFileSync(testPath, 'utf-8')) as Record<string, unknown>;
    // 필드마다 순차 patch(누적) — 각 경로의 diff 표시.
    let next = structuredClone(prodRaw);
    for (const path of list) {
      const r = buildPromotedProdConfig(next, testRaw, path);
      next = r.next;
      console.log(`${path}:`);
      console.log(`  운영(현재): ${JSON.stringify(r.before)}`);
      console.log(`  테스트(전파값): ${JSON.stringify(r.after)}`);
    }
    if (!opts.yes) {
      console.log(`dry-run — 적용하려면 --yes (${list.length} 필드)`);
      return 0;
    }
    atomicWriteJson(prodPath, next);
    console.log(`적용 완료 → ${prodPath} (${list.length} 필드 patch: ${list.join(', ')})`);
    return 0;
  } catch (e) {
    console.error(`elanous config promote 실패: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

/** CLI 진입 — `elanous config sync-test [--repo <path>] [--state-dir <dir>]`.
 *  --state-dir 은 임의 격리 루트 직접 지정(telegram-test 의
 *  ~/.elanous/telegram-test 등 — ISO-5) · 미지정 시 레포의 .elanous-test. */
export function runConfigSyncTest(opts: { repo?: string; stateDir?: string; json?: boolean }): number {
  let testDir: string;
  if (opts.stateDir?.trim()) {
    testDir = opts.stateDir.trim();
  } else {
    const repoRoot = opts.repo ?? findRepoRootUp(process.cwd());
    if (!repoRoot) {
      console.error('elanous config sync-test: 레포 루트(.git) 미발견 — 레포 안에서 실행하거나 --repo/--state-dir');
      return 1;
    }
    testDir = join(repoRoot, '.elanous-test');
  }
  try {
    const r = syncTestConfig(testDir);
    if (opts.json) {
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    console.log(`운영 config → ${r.testConfigPath}`);
    console.log(`  telegram: ${r.telegramMode === 'test-token' ? '테스트 봇 토큰으로 스왑 · report/home/channels 제거' : 'testChannel 없음 → off'}`);
    console.log(`  discord: off · 비밀 칸 ${r.testSecretsStripped}개 뺌`);
    console.log(`  부속 복사: ${r.copied.join(', ') || '없음'}${r.skippedMissing.length ? ` (부재 스킵: ${r.skippedMissing.join(', ')})` : ''}${r.skippedIdentical.length ? ` (동일 스킵: ${r.skippedIdentical.join(', ')})` : ''}`);
    console.log(`  제외(정책): ${TEST_SYNC_EXCLUDED.map((e) => e.file).join(', ')}`);
    console.log(`격리 루트: ${basename(testDir) === '.elanous-test' ? basename(dirname(testDir)) : testDir} — 테스트 인스턴스 재기동 시 반영`);
    return 0;
  } catch (e) {
    console.error(`elanous config sync-test 실패: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
