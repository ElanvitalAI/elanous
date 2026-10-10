import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultLlmPolicy, loadLlmPolicy, resolveSubscriptionReviewer, validateLlmPolicy } from './llm-policy.js';

const roots: string[] = [];
function fixture(legacy: object = {}, yaml?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'llm-policy-'));
  roots.push(root);
  writeFileSync(join(root, 'config.json'), JSON.stringify(legacy));
  if (yaml !== undefined) {
    mkdirSync(join(root, 'policy'));
    writeFileSync(join(root, 'policy', 'llm.yaml'), yaml);
  }
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });

const now = new Date('2026-10-30T12:00:00Z');
test('missing file and empty YAML preserve code defaults without writing a file', () => {
  const root = fixture();
  const missing = loadLlmPolicy({ configDir: root, now });
  expect(missing.valid).toBe(true);
  expect(missing.filePresent).toBe(false);
  expect(missing.policy).toEqual(defaultLlmPolicy());
  expect(missing.sources['accounts.codex.rotateAtPercent']).toBe('default');
  for (const text of ['', '# comment only\n', '---\n']) {
    const blank = fixture({}, text);
    const result = loadLlmPolicy({ configDir: blank, now });
    expect(result.valid).toBe(true);
    expect(result.policy).toEqual(missing.policy);
    expect(readFileSync(join(blank, 'policy', 'llm.yaml'), 'utf8')).toBe(text);
  }
});

test('explicit null YAML is invalid rather than an empty mapping', () => {
  for (const text of ['null\n', '~\n', '--- null\n']) {
    const root = fixture({}, text);
    const result = loadLlmPolicy({ configDir: root, now });
    expect(result.filePresent).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('policy must be a mapping');
    expect(result.policy).toEqual(defaultLlmPolicy());
  }
});

test('missing legacy config is normal; malformed or unreadable config names its path and cause', () => {
  const missing = mkdtempSync(join(tmpdir(), 'llm-policy-'));
  roots.push(missing);
  const absent = loadLlmPolicy({ configDir: missing, now });
  expect(absent.valid).toBe(true);
  expect(absent.warnings).toEqual([]);
  expect(absent.policy).toEqual(defaultLlmPolicy());

  const malformed = fixture();
  const malformedPath = join(malformed, 'config.json');
  writeFileSync(malformedPath, '{ invalid');
  const broken = loadLlmPolicy({ configDir: malformed, now });
  expect(broken.valid).toBe(true);
  expect(broken.policy).toEqual(defaultLlmPolicy());
  expect(broken.warnings.some(w => w.includes(malformedPath) && w.includes('could not be loaded') && w.includes('JSON'))).toBe(true);

  const unreadable = fixture();
  const unreadablePath = join(unreadable, 'config.json');
  chmodSync(unreadablePath, 0);
  try {
    const denied = loadLlmPolicy({ configDir: unreadable, now });
    expect(denied.valid).toBe(true);
    expect(denied.policy).toEqual(defaultLlmPolicy());
    expect(denied.warnings.some(w => w.includes(unreadablePath) && w.includes('EACCES'))).toBe(true);
  } finally {
    chmodSync(unreadablePath, 0o600);
  }
});

test('legacy precedence uses explicit values including false, quota key beats credits alias, partial YAML wins at leaf level', () => {
  const root = fixture({
    llm: { provider: 'openai-codex', model: 'gpt-6-sol', fallbackChain: ['codex-rotate'], codexCreditsAllowed: true,
      codexQuotaPolicy: 'within-quota', codexAccountOrder: ['third', 'team'], codexAccountRotation: false,
      codexAccountRotationThresholdPercentByAccount: { default: 1 } },
    roleLlm: { review: { provider: 'grok' } },
    harness: { budgetGate: { minHeadroomPercent: 12, maxUsedPercent: { 'openai-codex': 94, grok: 47 } } },
  }, 'version: 1\naccounts:\n  codex:\n    rotateAtPercent: 90\ncaps:\n  codex:\n    harness: 85\n');
  const result = loadLlmPolicy({ configDir: root, now });
  expect(result.valid).toBe(true);
  expect(result.policy.default).toEqual({ provider: 'openai-codex', model: 'gpt-6-sol' });
  expect(result.policy.credits.codex).toBe('never');
  expect(result.policy.fallback).toEqual(['codex-rotate']);
  expect(result.policy.accounts.codex.rotationEnabled).toBe(false);
  expect(result.policy.accounts.codex.perAccount.default.rotateAtPercent).toBe(1);
  expect(result.policy.accounts.codex.rotateAtPercent).toBe(90);
  expect(result.policy.caps.codex).toMatchObject({ harness: 85, headroom: 12, pod: 95 });
  expect(result.sources['caps.codex.harness']).toBe('file');
  expect(result.sources['caps.codex.headroom']).toBe('legacy-config');
  expect(result.sources['caps.codex.pod']).toBe('default');
  expect(result.sources['accounts.codex.perAccount.default.rotateAtPercent']).toBe('legacy-config');
  expect(result.warnings).toContain('legacy config llm.codexQuotaPolicy applies; migrate to policy/llm.yaml');
});

test('YAML role overrides do not mutate legacy input or a later load from that input', () => {
  const legacy = { roleLlm: { review: { provider: 'grok', model: 'grok-4' } } };
  const root = fixture({}, 'roles:\n  review:\n    model: grok-5\n');
  const first = loadLlmPolicy({ configDir: root, legacyConfig: legacy, now });
  expect(first.valid).toBe(true);
  expect(first.policy.roles.review).toEqual({ provider: 'grok', model: 'grok-5' });
  expect(first.sources['roles.review.provider']).toBe('legacy-config');
  expect(first.sources['roles.review.model']).toBe('file');
  expect(first.policy.roles.review).not.toBe(legacy.roleLlm.review);
  expect(legacy.roleLlm.review).toEqual({ provider: 'grok', model: 'grok-4' });

  const secondRoot = fixture();
  const second = loadLlmPolicy({ configDir: secondRoot, legacyConfig: legacy, now });
  expect(second.policy.roles.review).toEqual({ provider: 'grok', model: 'grok-4' });
  expect(second.sources['roles.review.model']).toBe('legacy-config');
});

test('expired per-account and pace entries fall back independently; through-date stays active', () => {
  const root = fixture({ llm: { codexAccountRotationThresholdPercentByAccount: { default: 11 } } }, `version: 1
accounts:
  codex:
    perAccount:
      default: { rotateAtPercent: 1, until: 2026-10-29 }
      team: { rotateAtPercent: 20, until: 2026-10-30 }
credits:
  pace: { targetPerDay: 2200, until: 2026-10-29 }
`);
  const result = loadLlmPolicy({ configDir: root, now });
  expect(result.valid).toBe(true);
  expect(result.policy.accounts.codex.perAccount.default.rotateAtPercent).toBe(11);
  expect(result.policy.accounts.codex.perAccount.team.rotateAtPercent).toBe(20);
  expect(result.policy.credits.pace).toBeUndefined();
  expect(result.sources['accounts.codex.perAccount.default.rotateAtPercent']).toBe('legacy-config');
  expect(result.warnings).toContain('accounts.codex.perAccount.default expired on 2026-10-29; ignored');
  expect(result.warnings).toContain('credits.pace expired on 2026-10-29; ignored');
});

test('invalid YAML, unknown fields, and malformed policy never partially apply', () => {
  for (const yaml of ['version: 2\ncaps: { codex: { pod: 40 } }', 'fallback: [evil]', 'credits: { grants: [{ account: third, amount: -2, expires: bad, source: x }] }', 'credits: [oops]', 'caps: { codex: { pod: 40, typo: 2 } }', 'fallback: [', 'version: 1\nversion: 1']) {
    const root = fixture({}, yaml);
    const result = loadLlmPolicy({ configDir: root, now });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.policy).toEqual(defaultLlmPolicy());
  }
  expect(validateLlmPolicy({ alerts: { creditsStep: 5000 }, resetCredits: { redeem: 'human' } }).valid).toBe(true);
});

test('grants and valid partial overrides remain visible with file sources and no implicit prod config lookup', () => {
  const root = fixture({}, `credits:
  codex: use
  grants:
    - { account: third, amount: 62500, expires: 2026-12-31, source: "Pro 200 compensation" }
alerts: { creditsStep: 3000 }
`);
  const result = loadLlmPolicy({ configDir: root, now });
  expect(result.valid).toBe(true);
  expect(result.policy.credits.grants[0]).toEqual({ account: 'third', amount: 62500, expires: '2026-12-31', source: 'Pro 200 compensation' });
  expect(result.sources['credits.grants']).toBe('file');
  expect(result.sources['alerts.creditsStep']).toBe('file');
  expect(result.sources['alerts.lowRemainingPercent']).toBe('default');
  expect(result.policy.credits.codex).toBe('use');
});

test('a __proto__ account override stays an own account without polluting Object.prototype or changing adjacent precedence', () => {
  const root = fixture({ llm: { codexAccountRotationThresholdPercentByAccount: { team: 45 } } }, `accounts:
  codex:
    perAccount:
      __proto__: { rotateAtPercent: 1 }
      team: { rotateAtPercent: 25 }
`);
  const result = loadLlmPolicy({ configDir: root, now });
  expect(result.valid).toBe(true);
  expect(Object.prototype.hasOwnProperty.call(result.policy.accounts.codex.perAccount, '__proto__')).toBe(true);
  expect(result.policy.accounts.codex.perAccount['__proto__']).toEqual({ rotateAtPercent: 1 });
  expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'rotateAtPercent')).toBe(false);
  expect(result.policy.accounts.codex.perAccount.team.rotateAtPercent).toBe(25);
  expect(result.sources['accounts.codex.perAccount.__proto__.rotateAtPercent']).toBe('file');
  expect(result.sources['accounts.codex.perAccount.team.rotateAtPercent']).toBe('file');
  expect(result.sources['accounts.codex.perAccount.default.rotateAtPercent']).toBe('default');
});

test('legacy __proto__ account is stored as data and YAML can override its leaf', () => {
  const legacy = JSON.parse('{"llm":{"codexAccountRotationThresholdPercentByAccount":{"__proto__":23,"team":45}}}');
  const root = fixture(legacy, `accounts:
  codex:
    perAccount:
      __proto__: { rotateAtPercent: 1 }
`);
  const result = loadLlmPolicy({ configDir: root, now });
  expect(result.valid).toBe(true);
  expect(result.policy.accounts.codex.perAccount['__proto__']).toEqual({ rotateAtPercent: 1 });
  expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'rotateAtPercent')).toBe(false);
  expect(result.policy.accounts.codex.perAccount.team.rotateAtPercent).toBe(45);
  expect(result.sources['accounts.codex.perAccount.__proto__.rotateAtPercent']).toBe('file');
  expect(result.sources['accounts.codex.perAccount.team.rotateAtPercent']).toBe('legacy-config');
});

test('expired credit grants are omitted with a warning while current grants stay', () => {
  const root = fixture({}, `credits:
  grants:
    - { account: old, amount: 10, expires: 2026-10-29, source: compensation }
    - { account: live, amount: 20, expires: 2026-10-30, source: compensation }
`);
  const result = loadLlmPolicy({ configDir: root, now });
  expect(result.valid).toBe(true);
  expect(result.policy.credits.grants.map(g => g.account)).toEqual(['live']);
  expect(result.warnings).toContain('credits.grants old expired on 2026-10-29; ignored');
});

test('an unreadable policy folder is an error with its path, not «no file · valid»', () => {
  if (process.getuid?.() === 0) return; // root reads through mode bits
  const root = fixture({}, 'version: 1\n');
  const folder = join(root, 'policy');
  chmodSync(folder, 0o000);
  try {
    const result = loadLlmPolicy({ configDir: root, now });
    expect(result.valid).toBe(false);
    expect(result.filePresent).toBe(true);
    expect(result.errors.join('\n')).toContain(join(folder, 'llm.yaml'));
    expect(result.errors.join('\n')).toContain('EACCES');
  } finally {
    chmodSync(folder, 0o755);
  }
});

test('resolveSubscriptionReviewer — one reviewer row for the harness and `self review` (REVIEW-ACP-CLI)', () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-policy-reviewer-'));
  try {
    const none = loadLlmPolicy({ configDir: root, legacyConfig: {} });
    expect(resolveSubscriptionReviewer(none)).toBeUndefined();
    expect(resolveSubscriptionReviewer(none, { reviewer: { provider: 'claude-acp', executor: 'cc' } }))
      .toEqual({ spec: { provider: 'claude-acp', executor: 'cc' }, cap: none.policy.caps.claude.harness });
    const legacy = loadLlmPolicy({ configDir: root, legacyConfig: { roleLlm: { reviewer: { provider: 'claude-acp' } } } });
    expect(resolveSubscriptionReviewer(legacy, { reviewer: { provider: 'claude-acp', executor: 'cc' } }))
      .toEqual({ spec: { provider: 'claude-acp' }, cap: legacy.policy.caps.claude.harness });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
