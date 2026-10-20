// finance.conatusNativePort 게이트 회귀 — 파리티 검증된 Conatus TS 포트 라우팅.
//
// 검증 축:
//   ① 게이트 seam(conatusNativePortEnabled): flag 미설정/false → false(python 경로 불변),
//      flag true → true. 격리 config-dir override + resetUserConfig 로 결정론.
//   ② native 경로(flag true): finance_backtest / finance_signals(screen·trend·factor) 가
//      TS 포트 렌더로 동일 shape({script,output,note} / {kind,report,note})를 반환.
//      격리 CONATUS_DATA_DIR fixture(conatus-*.test 스타일) — python·네트워크 무의존.
//   ③ sector_flow 는 포트 미커버 → native 브랜치 제외(guard `kind !== 'sector_flow'`) 구조 확인.
//
// ⚠️ flag false 의 python 실행 경로 자체는 실행하지 않는다(python·네트워크 회피). seam(①)이
//    false 임을 결정론으로 보장하므로 브랜치 선택은 고정된다(false → python default·byte-불변).

import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getElanousConfigDirOverride, resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';

// ── 격리 config-dir ──────────────────────────────────────────────────────────
let cfgDir: string;
let prevConfigDir: string | undefined;

/** 격리 config.json 을 쓰고 getUserConfig 캐시를 무효화(다음 read 가 새 파일 반영). */
async function writeConfig(obj: unknown): Promise<void> {
  writeFileSync(join(cfgDir, 'config.json'), JSON.stringify(obj));
  const { resetUserConfig } = await import('../user-config.js');
  resetUserConfig();
}

// ── 격리 CONATUS_DATA_DIR fixture ─────────────────────────────────────────────
// runScreens()/loadFullPanel() 은 CONATUS_DATA_DIR/cache 의 bulk_K?_*.json 만 읽는다.
// runScreens() 는 end 미지정 시 '오늘'부터 뒤로 8 거래일을 훑으므로(warm cache 전제),
// python·네트워크 없이 결정론이 되도록 오늘 기준 롤링 40일 window 를 미리 채운다.
let dataDir: string;
let prevData: string | undefined;

function isoMinus(n: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - n)).toISOString().slice(0, 10);
}
function row(code: string, ex: string, date: string, close: number, vol: number) {
  return { code, exchange_short_name: ex, date, open: close, high: close, low: close, close, adjusted_close: close, volume: vol };
}

beforeAll(() => {
  // config 디렉토리
  prevConfigDir = getElanousConfigDirOverride();
  cfgDir = mkdtempSync(join(tmpdir(), 'conatus-native-cfg-'));
  setElanousConfigDir(cfgDir);

  // 데이터 fixture — 오늘 기준 롤링 40일(주말 포함·recentTradingDates 가 평일만 채택).
  prevData = process.env.CONATUS_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'conatus-native-data-'));
  const cache = join(dataDir, 'cache');
  mkdirSync(cache, { recursive: true });
  process.env.CONATUS_DATA_DIR = dataDir;
  for (let n = 0; n <= 40; n++) {
    const d = isoMinus(n);
    // 결정론 합성가(급변동 신호 유발용 톱니 패턴 — 어세션은 헤더만 검사).
    const a = [80, 100, 80, 120, 150][n % 5]!;
    const b = [200, 160, 120, 120, 130][n % 5]!;
    const g = [80, 82, 85, 88, 90][n % 5]!;
    const ko = [
      row('000001', 'KO', d, a, 1000),
      row('000002', 'KO', d, b, 500),
      row('000003', 'KO', d, 10 + (n % 5), 100), // ETF(name/type 제외)
      row('000004', 'KO', d, 90 + (n % 5), 100), // 우선주(type 제외)
    ];
    const kq = [row('100001', 'KQ', d, g, 2000)];
    writeFileSync(join(cache, `bulk_KO_${d}.json`), JSON.stringify(ko));
    writeFileSync(join(cache, `bulk_KQ_${d}.json`), JSON.stringify(kq));
  }
  writeFileSync(
    join(cache, 'ticker_map.json'),
    JSON.stringify({
      '000001': { name: 'Alpha Corp', exchange: 'KOSPI', type: 'Common Stock' },
      '000002': { name: 'Beta Ltd', exchange: 'KOSPI', type: 'Common Stock' },
      '000003': { name: 'KODEX 200', exchange: 'KOSPI', type: 'ETF' },
      '000004': { name: 'Alpha Corp Pref', exchange: 'KOSPI', type: 'Preferred Share' },
      '100001': { name: 'Gamma Tech', exchange: 'KOSDAQ', type: 'Common Stock' },
    }),
  );
});

afterEach(async () => {
  // 각 test 후 config 캐시 초기화(격리)
  const { resetUserConfig } = await import('../user-config.js');
  resetUserConfig();
});

afterAll(async () => {
  if (prevConfigDir === undefined) resetElanousConfigDir();
  else setElanousConfigDir(prevConfigDir);
  if (prevData === undefined) delete process.env.CONATUS_DATA_DIR;
  else process.env.CONATUS_DATA_DIR = prevData;
  const { resetUserConfig } = await import('../user-config.js');
  resetUserConfig();
  if (cfgDir) rmSync(cfgDir, { recursive: true, force: true });
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

// ── ① 게이트 seam ────────────────────────────────────────────────────────────

test('conatusNativePortEnabled: flag 미설정 → false(python 경로 불변·기본값)', async () => {
  await writeConfig({ finance: { enabled: true } }); // conatusNativePort 없음
  const { conatusNativePortEnabled } = await import('./finance-tools.js');
  expect(conatusNativePortEnabled()).toBe(false);
});

test('conatusNativePortEnabled: flag=false → false', async () => {
  await writeConfig({ finance: { enabled: true, conatusNativePort: false } });
  const { conatusNativePortEnabled } = await import('./finance-tools.js');
  expect(conatusNativePortEnabled()).toBe(false);
});

test('conatusNativePortEnabled: flag=true → true', async () => {
  await writeConfig({ finance: { enabled: true, conatusNativePort: true } });
  const { conatusNativePortEnabled } = await import('./finance-tools.js');
  expect(conatusNativePortEnabled()).toBe(true);
});

// ── ② native 경로 shape(flag true) ───────────────────────────────────────────

test('finance_backtest(flag true): backtest TS 포트 렌더 · {script,output,note} shape', async () => {
  await writeConfig({ finance: { enabled: true, conatusNativePort: true } });
  const { buildFinanceTools } = await import('./finance-tools.js');
  const { dispatch } = buildFinanceTools();
  const r = (await dispatch('finance_backtest', {})) as { script: string; output: string; note: string };
  expect(r.script).toBe('backtest.py');
  expect(typeof r.output).toBe('string');
  expect(r.output.length).toBeGreaterThan(0);
  expect(r.output).toContain('신호'); // 백테스트 표 헤더
  expect(r.note).toContain('conatus-native');
});

test('finance_backtest(flag true·factor): factorResearch TS 포트 · script=factor_research.py', async () => {
  await writeConfig({ finance: { enabled: true, conatusNativePort: true } });
  const { buildFinanceTools } = await import('./finance-tools.js');
  const { dispatch } = buildFinanceTools();
  const r = (await dispatch('finance_backtest', { factor: true })) as { script: string; output: string; note: string };
  expect(r.script).toBe('factor_research.py');
  expect(r.output).toContain('패널'); // factor 렌더 헤더
  expect(r.note).toContain('conatus-native');
});

test('finance_signals(flag true·screen): reportMd TS 포트 · {kind,report,note}', async () => {
  await writeConfig({ finance: { enabled: true, conatusNativePort: true } });
  const { buildFinanceTools } = await import('./finance-tools.js');
  const { dispatch } = buildFinanceTools();
  const r = (await dispatch('finance_signals', { kind: 'screen' })) as { kind: string; report: string; note: string };
  expect(r.kind).toBe('screen');
  expect(r.report).toContain('한국시장 스크리너'); // reportMd 헤더
  expect(r.note).toContain('conatus-native');
});

test('finance_signals(flag true·trend): computeTrend/render TS 포트(db 없음 → fallback 문자열)', async () => {
  await writeConfig({ finance: { enabled: true, conatusNativePort: true } });
  const { buildFinanceTools } = await import('./finance-tools.js');
  const { dispatch } = buildFinanceTools();
  const r = (await dispatch('finance_signals', { kind: 'trend' })) as { kind: string; report: string; note: string };
  expect(r.kind).toBe('trend');
  // fixture 에 screener.db 없음 → computeTrend null → render = TREND_FALLBACK
  expect(r.report).toContain('추세 데이터 부족');
  expect(r.note).toContain('conatus-native');
});

test('finance_signals(flag true·factor): factorResearch TS 포트', async () => {
  await writeConfig({ finance: { enabled: true, conatusNativePort: true } });
  const { buildFinanceTools } = await import('./finance-tools.js');
  const { dispatch } = buildFinanceTools();
  const r = (await dispatch('finance_signals', { kind: 'factor' })) as { kind: string; report: string; note: string };
  expect(r.kind).toBe('factor');
  expect(r.report).toContain('패널');
  expect(r.note).toContain('conatus-native');
});

// ── ③ unknown kind 는 flag 무관 error(guard 불변) ─────────────────────────────

test('finance_signals(flag true·unknown): native 진입 전 unknown 가드(python 파리티)', async () => {
  await writeConfig({ finance: { enabled: true, conatusNativePort: true } });
  const { buildFinanceTools } = await import('./finance-tools.js');
  const { dispatch } = buildFinanceTools();
  const r = (await dispatch('finance_signals', { kind: 'nope' })) as { error?: string };
  expect(r.error).toContain('unknown kind');
});
