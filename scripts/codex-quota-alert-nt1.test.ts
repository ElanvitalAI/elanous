import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodexQuotaAlert } from './codex-quota-alert.js';

const exhausted = { provider: 'codex', accountName: 'private-team', subscription: { remainingPercent: 0 }, credits: { usedPercent: 100, balance: 100, hasCredits: true } };
const fallback = { provider: 'grok', accountName: 'fallback', subscription: { remainingPercent: 50 } };

describe('NT1 poller wiring', () => {
  test('same NT1 key suppresses repeat while balance baselines advance', async () => {
    const root = mkdtempSync(join(tmpdir(), 'quota-nt1-'));
    const statePath = join(root, 'state.json');
    const messages: string[] = [];
    const row = structuredClone(exhausted);
    const oldPolicy = process.env.ELANOUS_CODEX_QUOTA_POLICY;
    const oldStateDir = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = root;
    process.env.ELANOUS_CODEX_QUOTA_POLICY = 'fallback';
    const poll = () => runCodexQuotaAlert({ statePath, readUsage: () => ({ rows: [row, fallback] }), send: (text) => { messages.push(text); return true; } });
    const state = (): Record<string, string> => JSON.parse(readFileSync(statePath, 'utf8'));
    try {
      await poll();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('할 일:');
      expect(messages[0]).not.toContain('private-team');
      expect(state().nt1Key).toBe('fallback:grok');
      expect(state()['balance:private-team']).toBe('100');
      await poll();
      expect(messages).toHaveLength(1);
      // 정책 «fallback» 인데 크레딧이 줄었다 = 정책 밖 지출 — 한 통(리뷰 3라운드 must-fix: 같은 fallback 키로 묻히면 안 된다).
      row.credits.balance = 80;
      await poll();
      expect(state()['balance:private-team']).toBe('80');
      expect(messages).toHaveLength(2);
      expect(messages[1]).toContain('정책 밖 지출');
      expect(messages[1]).not.toContain('private-team');
      expect(state().nt1Key).toStartWith('off-policy:');
      // 같은 단계(5,000) 안에서 더 줄면 침묵 — 매시 경보로 묻히지 않게.
      row.credits.balance = 0;
      await poll();
      expect(messages).toHaveLength(2);
      expect(state()['balance:private-team']).toBe('0');
    } finally {
      if (oldPolicy === undefined) delete process.env.ELANOUS_CODEX_QUOTA_POLICY;
      else process.env.ELANOUS_CODEX_QUOTA_POLICY = oldPolicy;
      if (oldStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = oldStateDir;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('exhaustion alerts again after recovery clears the previous NT1 key', async () => {
    const root = mkdtempSync(join(tmpdir(), 'quota-nt1-recovery-'));
    const statePath = join(root, 'state.json');
    const oldStateDir = process.env.ELANOUS_STATE_DIR;
    const oldConfigDir = process.env.ELANOUS_CONFIG_DIR;
    const oldPolicy = process.env.ELANOUS_CODEX_QUOTA_POLICY;
    process.env.ELANOUS_STATE_DIR = root;
    process.env.ELANOUS_CONFIG_DIR = root;
    process.env.ELANOUS_CODEX_QUOTA_POLICY = 'fallback';
    const row = structuredClone(exhausted);
    row.credits.balance = 0;
    const messages: string[] = [];
    const state = (): Record<string, string> => JSON.parse(readFileSync(statePath, 'utf8'));
    const poll = () => runCodexQuotaAlert({ statePath, readUsage: () => ({ rows: [row, fallback] }), send: (text) => { messages.push(text); return true; } });
    try {
      await poll();
      expect(messages).toHaveLength(1);
      expect(state().nt1Key).toBe('fallback:grok');
      row.subscription.remainingPercent = 50;
      row.credits.balance = 40;
      await poll();
      expect(messages).toHaveLength(1);
      expect(state().nt1Key).toBeUndefined();
      expect(state()['balance:private-team']).toBe('40');
      row.subscription.remainingPercent = 0;
      await poll();
      expect(messages).toHaveLength(2);
      expect(messages[1]).toContain('grok');
      expect(state().nt1Key).toBe('fallback:grok');
    } finally {
      if (oldStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = oldStateDir;
      if (oldConfigDir === undefined) delete process.env.ELANOUS_CONFIG_DIR;
      else process.env.ELANOUS_CONFIG_DIR = oldConfigDir;
      if (oldPolicy === undefined) delete process.env.ELANOUS_CODEX_QUOTA_POLICY;
      else process.env.ELANOUS_CODEX_QUOTA_POLICY = oldPolicy;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('credit grants and pace from the policy reach the NT1 snapshot without account names', async () => {
    const root = mkdtempSync(join(tmpdir(), 'quota-nt1-policy-'));
    const statePath = join(root, 'state.json');
    const oldStateDir = process.env.ELANOUS_STATE_DIR;
    const oldConfigDir = process.env.ELANOUS_CONFIG_DIR;
    const oldPolicy = process.env.ELANOUS_CODEX_QUOTA_POLICY;
    process.env.ELANOUS_STATE_DIR = root;
    process.env.ELANOUS_CONFIG_DIR = root;
    process.env.ELANOUS_CODEX_QUOTA_POLICY = 'credits';
    const expire = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    mkdirSync(join(root, 'policy'), { recursive: true });
    writeFileSync(join(root, 'policy/llm.yaml'), `version: 1\ncredits:\n  codex: use\n  grants:\n    - account: private-team\n      amount: 500\n      expires: ${expire}\n      source: test\n`);
    const messages: string[] = [];
    try {
      await runCodexQuotaAlert({ statePath, readUsage: () => ({ rows: [structuredClone(exhausted)] }), send: (text) => { messages.push(text); return true; } });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('크레딧 100');
      expect(messages[0]).toContain('만료');
      expect(messages[0]).not.toContain('private-team');
      expect(JSON.parse(readFileSync(statePath, 'utf8')).nt1Key).toStartWith('expiry:');
    } finally {
      if (oldStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = oldStateDir;
      if (oldConfigDir === undefined) delete process.env.ELANOUS_CONFIG_DIR;
      else process.env.ELANOUS_CONFIG_DIR = oldConfigDir;
      if (oldPolicy === undefined) delete process.env.ELANOUS_CODEX_QUOTA_POLICY;
      else process.env.ELANOUS_CODEX_QUOTA_POLICY = oldPolicy;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an unreadable account warns without claiming exhaustion or exposing its name', async () => {
    const root = mkdtempSync(join(tmpdir(), 'quota-nt1-unknown-'));
    const statePath = join(root, 'state.json');
    const oldStateDir = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = root;
    const messages: string[] = [];
    const poll = () => runCodexQuotaAlert({ statePath, readUsage: () => ({ rows: [{ provider: 'codex', accountName: 'secret-account' }] }), send: (text) => { messages.push(text); return true; } });
    try {
      await poll();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('읽지 못했습니다');
      expect(messages[0]).not.toContain('secret-account');
      expect(messages[0]).not.toContain('한도 참');
      expect(JSON.parse(readFileSync(statePath, 'utf8')).nt1Key).toBe('unreadable');
      await poll();
      expect(messages).toHaveLength(1);
    } finally {
      if (oldStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = oldStateDir;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('unreadable warning retries failed delivery without advancing nt1Key', async () => {
    const root = mkdtempSync(join(tmpdir(), 'quota-nt1-unknown-failed-'));
    const statePath = join(root, 'state.json');
    const oldStateDir = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = root;
    const originalExit = process.exit;
    process.exit = ((code?: number) => { throw new Error(`exit:${code}`); }) as typeof process.exit;
    let deliver = false;
    const messages: string[] = [];
    const poll = () => runCodexQuotaAlert({ statePath, readUsage: () => ({ rows: [
      { provider: 'codex', accountName: 'secret-account', credits: { balance: 17, usedPercent: 100 } },
    ] }), send: (text) => { messages.push(text); return deliver; } });
    try {
      await expect(poll()).rejects.toThrow('exit:1');
      expect(JSON.parse(readFileSync(statePath, 'utf8')).nt1Key).toBeUndefined();
      expect(JSON.parse(readFileSync(statePath, 'utf8'))['balance:secret-account']).toBe('17');
      deliver = true;
      await poll();
      expect(messages).toHaveLength(2);
      expect(messages[0]).toContain('읽지 못했습니다');
      expect(messages[0]).not.toContain('secret-account');
      expect(JSON.parse(readFileSync(statePath, 'utf8')).nt1Key).toBe('unreadable');
      await poll();
      expect(messages).toHaveLength(2);
    } finally {
      process.exit = originalExit;
      if (oldStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = oldStateDir;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('unknown subscription does not become exhausted from credit usage, while a known new limit still alerts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'quota-nt1-mixed-'));
    const statePath = join(root, 'state.json');
    const oldStateDir = process.env.ELANOUS_STATE_DIR;
    const oldPolicy = process.env.ELANOUS_CODEX_QUOTA_POLICY;
    process.env.ELANOUS_STATE_DIR = root;
    process.env.ELANOUS_CODEX_QUOTA_POLICY = 'fallback';
    const messages: string[] = [];
    const known = { provider: 'codex', accountName: 'known', subscription: { remainingPercent: 50 } };
    const unknown = { provider: 'codex', accountName: 'secret', credits: { usedPercent: 100 } };
    const poll = () => runCodexQuotaAlert({ statePath, readUsage: () => ({ rows: [known, unknown, fallback] }), send: (text) => { messages.push(text); return true; } });
    try {
      await poll();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('읽지 못했습니다');
      expect(messages[0]).not.toContain('secret');
      expect(messages[0]).not.toContain('못 써서');
      expect(JSON.parse(readFileSync(statePath, 'utf8')).nt1Key).toBe('unreadable');
      known.subscription.remainingPercent = 0;
      await poll();
      expect(messages).toHaveLength(2);
      expect(messages[1]).toContain('확인된 1개 계정은 한도가 소진됐습니다');
      expect(messages[1]).not.toContain('secret');
      expect(JSON.parse(readFileSync(statePath, 'utf8')).nt1Key).toBe('unreadable:secret:known:0');
      known.subscription.remainingPercent = 5;
      await poll();
      expect(messages).toHaveLength(3);
      expect(messages[2]).toContain('잔여가 10% 이하');
      expect(JSON.parse(readFileSync(statePath, 'utf8')).nt1Key).toBe('unreadable:secret:known:5');
      known.subscription.remainingPercent = 50;
      await poll();
      expect(messages).toHaveLength(4);
      expect(JSON.parse(readFileSync(statePath, 'utf8')).nt1Key).toBe('unreadable');
    } finally {
      if (oldStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = oldStateDir;
      if (oldPolicy === undefined) delete process.env.ELANOUS_CODEX_QUOTA_POLICY;
      else process.env.ELANOUS_CODEX_QUOTA_POLICY = oldPolicy;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('provider reset credit expiry still alerts without a policy grant', async () => {
    const root = mkdtempSync(join(tmpdir(), 'quota-nt1-reset-'));
    const statePath = join(root, 'state.json');
    const oldStateDir = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = root;
    const messages: string[] = [];
    const expiresAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const poll = () => runCodexQuotaAlert({ statePath, readUsage: () => ({ rows: [{ provider: 'codex', accountName: 'secret', subscription: { remainingPercent: 80 }, credits: { balance: 42 }, resetCredits: { status: 'available', expiresAt } }] }), send: (text) => { messages.push(text); return true; } });
    try {
      await poll();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('만료');
      expect(messages[0]).not.toContain('secret');
      expect(JSON.parse(readFileSync(statePath, 'utf8')).nt1Key).toStartWith('expiry:');
      await poll();
      expect(messages).toHaveLength(1);
    } finally {
      if (oldStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = oldStateDir;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('usage lookup failure keeps its warning branch and does not record unsuccessful delivery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'quota-nt1-unreadable-'));
    const statePath = join(root, 'state.json');
    const warnings: string[] = [];
    const oldStateDir = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = root;
    const originalExit = process.exit;
    process.exit = (() => { throw new Error('exit:0'); }) as typeof process.exit;
    let deliver = false;
    const poll = () => runCodexQuotaAlert({ statePath, readUsage: () => ({ error: 'USAGE_DOWN' }), send: (text) => { warnings.push(text); return deliver; } });
    try {
      await expect(poll()).rejects.toThrow('exit:0');
      expect(warnings[0]).toContain('LLM 한도 조회가 실패했습니다');
      expect(warnings[0]).toContain('USAGE_DOWN');
      expect(() => readFileSync(statePath, 'utf8')).toThrow();
      deliver = true;
      await expect(poll()).rejects.toThrow('exit:0');
      expect(warnings).toHaveLength(2);
      expect(JSON.parse(readFileSync(statePath, 'utf8'))['usage-unreadable']).toBe('USAGE_DOWN');
      await expect(poll()).rejects.toThrow('exit:0');
      expect(warnings).toHaveLength(2);
    } finally {
      process.exit = originalExit;
      if (oldStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = oldStateDir;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('failed NT1 delivery retains the old key and retries until it succeeds', async () => {
    const root = mkdtempSync(join(tmpdir(), 'quota-nt1-failed-'));
    const statePath = join(root, 'state.json');
    const sent: string[] = [];
    let deliver = false;
    const oldPolicy = process.env.ELANOUS_CODEX_QUOTA_POLICY;
    const oldStateDir = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = root;
    process.env.ELANOUS_CODEX_QUOTA_POLICY = 'fallback';
    const poll = () => runCodexQuotaAlert({ statePath, readUsage: () => ({ rows: [structuredClone(exhausted), fallback] }), send: (text) => { sent.push(text); return deliver; } });
    const state = (): Record<string, string> => JSON.parse(readFileSync(statePath, 'utf8'));
    const originalExit = process.exit;
    process.exit = ((code?: number) => { throw new Error(`exit:${code}`); }) as typeof process.exit;
    try {
      await expect(poll()).rejects.toThrow('exit:1');
      expect(state().nt1Key).toBeUndefined();
      expect(state()['balance:private-team']).toBe('100');
      deliver = true;
      await poll();
      expect(sent).toHaveLength(2);
      expect(state().nt1Key).toBe('fallback:grok');
      await poll();
      expect(sent).toHaveLength(2);
    } finally {
      process.exit = originalExit;
      if (oldPolicy === undefined) delete process.env.ELANOUS_CODEX_QUOTA_POLICY;
      else process.env.ELANOUS_CODEX_QUOTA_POLICY = oldPolicy;
      if (oldStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = oldStateDir;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
