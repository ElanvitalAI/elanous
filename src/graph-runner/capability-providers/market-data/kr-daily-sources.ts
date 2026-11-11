import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import type { GraphCapabilityProviderDeclaration } from '../../capabilities.js';
import { failed, isoDate, number, object, stockInput } from './stock-common.js';

const execFileAsync = promisify(execFile);
const PYKRX_CODE = `import json,sys
from pykrx import stock
f,t,s=sys.argv[1:]
df=stock.get_market_ohlcv_by_date(f,t,s)
print(json.dumps([{'date':str(i)[:10],'open':float(r['시가']),'high':float(r['고가']),'low':float(r['저가']),'close':float(r['종가']),'volume':float(r['거래량'])} for i,r in df.iterrows()]))`;
type PykrxReader = (from: string, to: string, symbol: string) => Promise<unknown>;
async function readPykrx(from: string, to: string, symbol: string): Promise<unknown> {
  const { stdout } = await execFileAsync('python3', ['-c', PYKRX_CODE, from, to, symbol],
    { timeout: 20_000, maxBuffer: 2_000_000 });
  return JSON.parse(stdout);
}

/** Optional local pykrx daily bars, no credential. */
export function createPykrxDeclarations(options: { readDaily?: PykrxReader; available?: () => boolean } = {}): readonly GraphCapabilityProviderDeclaration[] {
  const readDaily = options.readDaily ?? readPykrx;
  const available = options.available ?? (() => {
    try { execFileSync('python3', ['-c', 'import pykrx'], { timeout: 1500, stdio: 'ignore' }); return true; }
    catch { return false; }
  });
  return [{ id: 'pykrx-kr-daily', provides: ['market.ohlcv@1'], tier: 'free', latency: 1500,
    conditions: { market: 'KR' }, available, guarantees: { sourceAttribution: true },
    invoke: async (context) => {
      try {
        const input = stockInput(context, 'KR');
        if (!input.from || !input.to || input.from > input.to) throw new Error('invalid_input');
        const raw = await readDaily(input.from.replaceAll('-', ''), input.to.replaceAll('-', ''), input.symbol);
        if (!Array.isArray(raw)) throw new Error('invalid_response');
        const bars = raw.map((value) => { const row = object(value);
          if (!isoDate(row.date) || row.date < input.from! || row.date > input.to!) throw new Error('invalid_response');
          return { date: row.date, open: number(row.open), high: number(row.high), low: number(row.low),
            close: number(row.close), volume: number(row.volume) }; });
        return { ok: true, outcome: 'ok' as const, result: { source: 'pykrx', market: 'KR', symbol: input.symbol, bars },
          evidence: { source: 'pykrx', timing: 'end-of-day' } };
      } catch (error) { return failed(error); }
    } }];
}
