// C-②a — Exercise omni-market's subprocess boundary with fixed JSON replies.
import { describe, test, expect, spyOn } from 'bun:test';
import * as childProcess from 'node:child_process';
import { marketQuote } from './market-quote.js';

describe('omniQuote launcher and provider labels', () => {
  test('index, FX, and closed/live equity branches invoke bun and preserve provider identity', () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const replies = [
      { close: 5100, previousClose: 5000, change_p: 2, high: 5200, provider: 'Yahoo', session: 'eodhd-close' },
      { close: 1450, previousClose: 1440, change_p: 0.7, high: 1460, session: 'toss-live' },
      { close: 75000, previousClose: 74000, change_p: 1.3, high: 75500, provider: 'eodhd' },
      { close: 220, previousClose: 215, change_p: 2.3, high: 222, provider: 'yahoo' },
      { close: 221, previousClose: 220, change_p: 0.5, high: 223, provider: 'eodhd' },
    ];
    const exec = spyOn(childProcess, 'execFileSync').mockImplementation(((bin: string, args: string[]) => {
      calls.push({ bin, args });
      return JSON.stringify(replies.shift());
    }) as typeof childProcess.execFileSync);
    try {
      const now = new Date('2026-07-12T12:00:00Z');
      const index = marketQuote('^GSPC', now);
      const fx = marketQuote('USDKRW.FOREX', now);
      const krClosed = marketQuote('005930.KS', now);
      const usClosed = marketQuote('AAPL.US', now);
      const usLive = marketQuote('AAPL.US', new Date('2026-07-13T15:00:00Z'));
      expect(index).toMatchObject({ source: 'yahoo', price: 5100, market: 'index' });
      expect(fx).toMatchObject({ source: 'toss', price: 1450, market: 'fx' });
      expect(krClosed).toMatchObject({ source: 'eodhd', price: 75000, market: 'kr-equity', freshness: 'eod' });
      expect(usClosed).toMatchObject({ source: 'yahoo', price: 220, market: 'us-equity', freshness: 'eod' });
      expect(usLive).toMatchObject({ source: 'eodhd', price: 221, market: 'us-equity', freshness: 'live' });
      expect(calls.map(({ bin, args }) => ({ bin, action: args[1], symbol: args[2], format: args[3] }))).toEqual([
        { bin: 'bun', action: 'quote', symbol: '^GSPC', format: '--json' },
        { bin: 'bun', action: 'quote', symbol: 'USDKRW.FOREX', format: '--json' },
        { bin: 'bun', action: 'quote', symbol: '005930.KS', format: '--json' },
        { bin: 'bun', action: 'quote', symbol: 'AAPL.US', format: '--json' },
        { bin: 'bun', action: 'quote', symbol: 'AAPL.US', format: '--json' },
      ]);
      expect(calls.every(({ args }) => args[0]?.endsWith('/omni-market/scripts/main.ts'))).toBe(true);
    } finally { exec.mockRestore(); }
  });
});
