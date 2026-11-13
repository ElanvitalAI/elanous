import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNextMailWake } from './next-mail-wake.js';

describe('next TUI seat mail → H2 gate', () => {
  test('does not read mail without a seat opt-in', () => {
    let reads = 0;
    const wake = createNextMailWake({
      seat: 'R-TICKET', enabled: false, readUnread: () => { reads++; return { count: 1, maxId: 7 }; }, // Source: #36648 isolated fake mail fixture.
      startTurnIfIdle: () => ({ opened: true, turnId: 'auto-1' }),
    });
    wake.poll();
    expect(reads).toBe(0);
    wake.dispose();
  });

  test('retries H2 refusal, delivers once, and waits for a new mail id', () => {
    let attempts = 0; // Source: #36648 first refusal then retry fixture.
    let maxId = 7; // Source: #36648 initial fake mail id.
    const calls: string[] = [];
    const wake = createNextMailWake({
      seat: 'R-TICKET', enabled: true, intervalMs: 60_000,
      readUnread: () => ({ count: 1, maxId }),
      startTurnIfIdle: (text, opts) => {
        calls.push(`${opts.origin}:${text}`);
        return ++attempts === 1 ? { opened: false, reason: 'HumanTyping', detail: 'buffer' }
          : { opened: true, turnId: `auto-${attempts}` };
      },
      log: () => {},
    });
    wake.poll();
    expect(calls).toHaveLength(1);
    wake.poll();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('msg-wake:[우편 깨움] R-TICKET 미읽음 1통');
    wake.confirmDelivery();
    wake.poll();
    expect(calls).toHaveLength(2);
    maxId = 8; // Source: #36648 subsequent fake mail id.
    wake.poll();
    expect(calls).toHaveLength(3);
    wake.dispose();
  });

  test('deleting opt-in stops reads and recreation admits new mail', () => {
    const home = mkdtempSync(join(tmpdir(), 'next-mail-optin-'));
    const seatDir = join(home, 'elanous-hq', 'seat-state', 'R-TICKET');
    const switchPath = join(seatDir, 'autowake');
    mkdirSync(seatDir, { recursive: true });
    writeFileSync(switchPath, 'on\n');
    let maxId = 7; // Source: #36648 initial fake mail id.
    let reads = 0;
    let opens = 0;
    const wake = createNextMailWake({ seat: 'R-TICKET', home, intervalMs: 60_000,
      readUnread: () => { reads++; return { count: 1, maxId }; },
      startTurnIfIdle: () => ({ opened: true, turnId: `auto-${++opens}` }), log: () => {} });
    try {
      wake.poll();
      wake.confirmDelivery();
      expect({ reads, opens }).toEqual({ reads: 1, opens: 1 });
      rmSync(switchPath);
      maxId = 8; // Source: #36648 subsequent fake mail id.
      wake.poll();
      expect({ reads, opens }).toEqual({ reads: 1, opens: 1 });
      writeFileSync(switchPath, 'on\n');
      wake.poll();
      expect({ reads, opens }).toEqual({ reads: 2, opens: 2 });
    } finally {
      wake.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
