// Boundary tests for the daemon config seam (CEO-CHANNEL-FIRST-CLASS): env parsing, the token
// resolution order and the fail-secure allowlist defaults — the runtime wiring itself is three
// calls into the boundary-tested modules (src/els/ceo-channel*.test.ts).
import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CEO_TOKEN_SECRET_ID, ceoDaemonConfig, resolveCeoToken } from './ceo-channel-daemon.js';

describe('ceo-channel-daemon config', () => {
  test('env token beats the secret store; blank env falls back to the store; neither ⇒ null (a startup error)', () => {
    expect(resolveCeoToken({ TELEGRAM_OP_BOT_TOKEN: ' env-tok ' }, () => 'store-tok')).toBe('env-tok');
    expect(resolveCeoToken({}, (id) => (id === CEO_TOKEN_SECRET_ID ? 'store-tok' : undefined))).toBe('store-tok');
    expect(resolveCeoToken({}, () => undefined)).toBeNull();
  });

  test('defaults — elanous-owned state dir, the real mail ledger, 25/15/60 s periods, no senders, no bridge, not --once', () => {
    const config = ceoDaemonConfig({}, false, () => 'tok')!;
    expect(config.token).toBe('tok');
    expect(config.stateDir).toBe(join(homedir(), '.elanous', 'ceo-channel'));
    expect(config.mailDb).toBe(join(homedir(), '.elanous', 'msg', 'messages.db'));
    expect(config.pollTimeoutSec).toBe(25);
    expect(config.mailScanSec).toBe(15);
    expect(config.outboxRetrySec).toBe(60);
    expect(config.senders).toBeNull();
    expect(config.injectModule).toBeNull();
    expect(config.once).toBeFalse();
  });

  test('the allowlist parses comma lists — trims, drops blanks, dedupes; empty senders ⇒ null (any sender of a bound chat is from=CEO)', () => {
    const config = ceoDaemonConfig({ CEO_TG_CHAT_IDS: ' 100 , 200,, 100 ', CEO_TG_SENDERS: ' , ,' }, false, () => 'tok')!;
    expect(config.chatIds).toEqual(['100', '200']);
    expect(config.senders).toBeNull();
    const withSenders = ceoDaemonConfig({ CEO_TG_SENDERS: ' 7,8 ' }, false, () => 'tok')!;
    expect(withSenders.senders).toEqual(['7', '8']);
  });

  test('periods floor at 1 s (0 or garbage falls back), the long-poll clamps into 1..50, and --once rides along', () => {
    const config = ceoDaemonConfig({ CEO_MAIL_SCAN_SEC: '0', CEO_OUTBOX_RETRY_SEC: 'x', CEO_TG_POLL_SEC: '500' }, true, () => 'tok')!;
    expect(config.mailScanSec).toBe(15);
    expect(config.outboxRetrySec).toBe(60);
    expect(config.pollTimeoutSec).toBe(50);
    expect(config.once).toBeTrue();
  });

  test('a missing token is a startup error, and the bridge module path trims (blank ⇒ none)', () => {
    expect(ceoDaemonConfig({}, false, () => undefined)).toBeNull();
    expect(ceoDaemonConfig({ CEO_INJECT_MODULE: '  ' }, false, () => 'tok')!.injectModule).toBeNull();
    expect(ceoDaemonConfig({ CEO_INJECT_MODULE: ' ./bridge.js ' }, false, () => 'tok')!.injectModule).toBe('./bridge.js');
  });
});