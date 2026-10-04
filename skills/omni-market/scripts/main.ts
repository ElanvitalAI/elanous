#!/usr/bin/env -S npx tsx
import { parseArgs } from 'node:util';
import { initEnv } from '../src/env.js';
import { resolveDateRange } from '../src/date.js';
import { route, listProviders } from '../src/router.js';
import { render } from '../src/render.js';
import type { Command } from '../src/types.js';
import { writeStdoutJson } from './stdout-json.js';

initEnv();

// Preprocess: convert `--from -1m` to `--from=-1m`
const rawArgs = process.argv.slice(2);
const fixedArgs: string[] = [];
for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  const next = rawArgs[i + 1];
  if ((arg === '--from' || arg === '--to') && next && /^-\d/.test(next)) {
    fixedArgs.push(`${arg}=${next}`);
    i++;
  } else {
    fixedArgs.push(arg);
  }
}

const { values: flags, positionals } = parseArgs({
  args: fixedArgs,
  allowPositionals: true,
  options: {
    from:       { type: 'string' },
    to:         { type: 'string' },
    period:     { type: 'string' },
    order:      { type: 'string' },
    limit:      { type: 'string' },
    offset:     { type: 'string' },
    interval:   { type: 'string' },
    func:       { type: 'string', short: 'f' },
    'func-period': { type: 'string' },
    filters:    { type: 'string' },
    signals:    { type: 'string' },
    sort:       { type: 'string' },
    country:    { type: 'string' },
    indicator:  { type: 'string' },
    'calendar-type': { type: 'string' },
    topic:      { type: 'string' },
    code:       { type: 'string' },
    comparison: { type: 'string' },
    'event-type': { type: 'string' },
    exchange:   { type: 'string' },
    delisted:   { type: 'boolean', default: false },
    'ticker-type': { type: 'string' },
    'bulk-type': { type: 'string' },
    symbols:    { type: 'string' },
    extended:   { type: 'boolean', default: false },
    'filing-type': { type: 'string' },
    'period-type': { type: 'string' },
    // output
    json:       { type: 'boolean', default: false },
    // meta
    provider:   { type: 'string' },
    'self-test': { type: 'boolean', default: false },
    help:       { type: 'boolean', short: 'h', default: false },
  },
});

if (flags.help) { printHelp(); process.exit(0); }
if (flags['self-test']) { await runSelfTest(); process.exit(0); }

const command = positionals[0] as Command;
const target = positionals.slice(1).join(' ').trim();

if (!command) { console.error('Error: 명령어를 입력해주세요.'); printHelp(); process.exit(1); }

main().catch(err => { console.error(`Error: ${err.message}`); process.exit(1); });

async function main() {
  const { from, to } = resolveDateRange(flags.from, flags.to);
  const opts = {
    from, to,
    period: flags.period as any,
    order: flags.order as any,
    limit: flags.limit ? Number(flags.limit) : undefined,
    offset: flags.offset ? Number(flags.offset) : undefined,
    interval: flags.interval as any,
    func: flags.func,
    funcPeriod: flags['func-period'] ? Number(flags['func-period']) : undefined,
    filters: flags.filters,
    signals: flags.signals,
    sort: flags.sort,
    country: flags.country,
    indicator: flags.indicator,
    calendarType: flags['calendar-type'] as any,
    topic: flags.topic,
    code: flags.code,
    comparison: flags.comparison,
    eventType: flags['event-type'],
    exchangeCode: flags.exchange,
    delisted: flags.delisted,
    tickerType: flags['ticker-type'],
    bulkType: flags['bulk-type'] as any,
    symbols: flags.symbols,
    extended: flags.extended,
    filing_type: flags['filing-type'],
    period_type: flags['period-type'] as any,
  };

  // Header
  console.log('━'.repeat(60));
  console.log('OmniMarket — Multi-Provider Financial Data');
  console.log('━'.repeat(60));

  // Show provider status
  const providers = listProviders();
  const statusLine = providers.map(p => `${p.name}:${p.available ? 'ON' : 'OFF'}`).join('  ');
  console.log(`프로바이더: ${statusLine}`);
  console.log(`명령:  ${command}`);
  if (target) console.log(`대상:  ${target}`);
  if (opts.from || opts.to) {
    const rangeStr = [opts.from && `from=${opts.from}`, opts.to && `to=${opts.to}`].filter(Boolean).join('  ');
    console.log(`기간:  ${rangeStr}`);
  }
  console.log('');

  // Route to best provider with fallback
  const result = await route(command, target, opts);

  if (result.fallbackUsed) {
    console.log(`⚠ Primary provider failed → fallback to ${result.provider}`);
  }

  // Render output
  if (flags.json) {
    // provider 마커 주입 — object 데이터엔 실제 서빙 provider(toss/yahoo/eodhd/…)를 실어 소비자
    // (elanous omniQuote 등)가 출처를 정확히 판별하게 한다(제1원칙 자기 관측성). 종전엔 --json 에
    // provider 정보가 없어 소비자가 브래킷 regex 실패→오라벨. 배열 데이터(eod 등)는 형태 보존 위해 미주입.
    const payload = (result.data && typeof result.data === 'object' && !Array.isArray(result.data))
      ? { ...result.data, provider: result.provider }
      : result.data;
    await writeStdoutJson(JSON.stringify(payload, null, 2) + '\n');
  } else {
    const markdown = render(result.renderKey, result.data, {
      target,
      func: opts.func,
      calendarType: opts.calendarType,
      country: opts.country || target,
      indicator: opts.indicator || 'gdp_current_usd',
      exchange: opts.exchangeCode || target,
      provider: result.provider,
    });
    console.log(markdown);
  }

  console.log('\n' + '━'.repeat(60));
}

async function runSelfTest() {
  console.log('=== OmniMarket self-test ===\n');

  const providers = listProviders();
  for (const p of providers) {
    console.log(`  ${p.name}: ${p.available ? 'AVAILABLE' : 'NO API KEY'}`);
  }
  console.log('');

  // Test: eod via router
  try {
    const result = await route('eod', 'AAPL.US', { from: '2025-01-01', to: '2025-01-10' });
    const count = Array.isArray(result.data) ? result.data.length : '?';
    console.log(`  PASS: eod AAPL.US → ${count}건 [${result.provider}]`);
  } catch (e: any) { console.log(`  FAIL: eod — ${e.message}`); }

  // Test: quote via router
  try {
    const result = await route('quote', 'AAPL.US', {});
    console.log(`  PASS: quote AAPL.US → close=${result.data.close} [${result.provider}]`);
  } catch (e: any) { console.log(`  FAIL: quote — ${e.message}`); }

  // Test: fundamentals via router
  try {
    const result = await route('fundamentals', 'MSFT.US', {});
    const name = result.data?.General?.Name || '?';
    console.log(`  PASS: fundamentals MSFT.US → ${name} [${result.provider}]`);
  } catch (e: any) { console.log(`  FAIL: fundamentals — ${e.message}`); }

  // Test: FDS-only command (if available)
  try {
    const result = await route('earnings', 'NVDA', {});
    console.log(`  PASS: earnings NVDA [${result.provider}]`);
  } catch (e: any) { console.log(`  SKIP: earnings — ${e.message}`); }

  console.log('\n=== done ===');
}

function printHelp() {
  console.log(`
OmniMarket — Multi-Provider Financial Data CLI

사용법: npx tsx scripts/main.ts <command> [target] [OPTIONS]

Commands (EODHD + FDS 공통):
  eod <SYMBOL>          EOD 히스토리컬 가격
  quote <SYMBOL>        실시간(지연) 시세
  fundamentals <SYMBOL> 기업 펀더멘털
  insider [SYMBOL]      내부자 거래
  screener              종목 스크리너
  search <QUERY>        종목 검색

Commands (EODHD 전용):
  intraday <SYMBOL>     장중 가격
  technical <SYMBOL>    기술적 지표 (--func sma/rsi/macd/bbands)
  news [SYMBOL]         금융 뉴스
  sentiment <SYMBOLS>   뉴스 센티먼트
  dividends <SYMBOL>    배당 히스토리
  splits <SYMBOL>       액면분할
  market-cap <SYMBOL>   히스토리컬 시가총액
  macro [COUNTRY]       거시경제 지표
  events                경제 이벤트 캘린더
  calendar              실적/IPO/분할 캘린더
  ust [TYPE]            미국채 금리
  exchanges             거래소 목록
  tickers [EXCHANGE]    거래소 종목 목록
  bulk [EXCHANGE]       벌크 EOD

Commands (FDS 전용 — US 종목):
  earnings <TICKER>     실적 데이터 (서프라이즈 포함)
  filings <TICKER>      SEC 공시 (10-K, 10-Q, 8-K)
  institutional <TICKER> 기관 보유 현황 (13F)
  company <TICKER>      기업 기본 정보

Options:
  --from <DATE>         시작일 (절대/상대: -3m, ytd, 2025-01-01)
  --to <DATE>           종료일
  --period d|w|m        기간
  --limit N             결과 수 제한
  --func <name>         기술적 지표 함수
  --filing-type <type>  SEC 공시 유형 (10-K, 10-Q, 8-K)
  --json                JSON 원본 출력
  --help, -h            도움말

Provider routing:
  글로벌 지수(eod/quote): Yahoo (무료·키 불필요) — N225/GDAXI/BSESN/BVSP/SSEC 등
    EODHD가 빈값 주는 비-US/KR 지수까지 커버. CODE.INDX 또는 ^CODE 입력.
  그 외(종목·펀더멘털 등): EODHD 1순위 → 실패 시 FDS(US 종목) 자동 전환.
  환경변수: EODHD_API_KEY, FDS_API_KEY (Yahoo는 키 불필요)

예시:
  npx tsx scripts/main.ts eod AAPL.US --from -3m
  npx tsx scripts/main.ts quote NVDA.US
  npx tsx scripts/main.ts eod N225.INDX      # 닛케이 (Yahoo)
  npx tsx scripts/main.ts eod GDAXI.INDX     # DAX (Yahoo)
  npx tsx scripts/main.ts earnings NVDA
  npx tsx scripts/main.ts filings AAPL --filing-type 10-K --limit 5
  npx tsx scripts/main.ts institutional TSLA
`);
}
