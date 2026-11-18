// HARNESS-DIFFICULTY-ROUTER — 순수 판정·라우터·원장 레코드. 시계·네트워크·LLM 0.
// 숫자는 모듈 상수·픽스처 길이에서 유도한다(NUMGUARD).
import { describe, expect, test } from 'bun:test';
import {
  PLAIN_L1_MAX_PATHS,
  PLAIN_L2_MAX_PATHS,
  WORK_LEVELS,
  WORK_RISK_CATEGORIES,
  WORK_ROUTE_MAX_REASONS,
  classifyWorkRisk,
  isRiskyLevel,
  workPathTokens,
  workRiskInputFromFields,
  type WorkRiskCategory,
} from './work-risk-router.js';

/** #38155(반복 예약 · grok 4라운드)의 바뀐 파일 — `gh pr view 38155 --json files` (2026-11-17). */
const PR_38155_FILES = [
  'src/dashboard/index.ts',
  'src/skills/tools/schedule-wakeup-persist.test.ts',
  'src/skills/tools/schedule-wakeup.ts',
  'src/tui-client/next-wakeup-persist.test.ts',
  'src/tui-client/next-wakeup.ts',
  'src/tui/entry.ts',
];

const CATEGORY_FIXTURES: Readonly<Record<WorkRiskCategory, readonly string[]>> = {
  persistence: ['src/session/chat-store.ts', 'src/self-implement/run-ledger.ts', 'src/memory/sqlite-db.ts'],
  locking: ['src/self-implement/run-ledger-lock.ts', 'src/harness/seat-mutex.ts', 'src/pod/leases.ts'],
  'cross-process': ['src/nexus/runtime/server.ts', 'src/pty-shell/registry.ts', 'src/daemon/ipc-bridge.ts'],
  security: ['src/oauth/codex-account-store-auth.ts', 'src/secrets/vault.ts', 'src/auth/credentials.ts'],
};

const PLAIN_PATHS = ['src/tui/chat/status-line.ts', 'src/i18n/messages-ko.ts', 'src/pwa/components/Button.tsx', 'src/tui/slash/help-text.ts'];

describe('classifyWorkRisk — path categories', () => {
  for (const category of WORK_RISK_CATEGORIES) {
    test(`${category} paths → L4+ and the category is reported`, () => {
      for (const path of CATEGORY_FIXTURES[category]) {
        const result = classifyWorkRisk({ paths: [path] });
        expect(result.riskCategories).toContain(category);
        expect(result.level).toBe(WORK_LEVELS[WORK_LEVELS.indexOf('L4') + result.riskCategories.length - 1]);
      }
    });
  }

  test('tokens are whole-segment matches — restore/author/tokenizer do not trigger', () => {
    expect(workPathTokens('src/self-dev/runLedgerStore.ts')).toEqual(['src', 'self', 'dev', 'run', 'ledger', 'store', 'ts']);
    const result = classifyWorkRisk({ paths: ['src/backup/restore-view.ts', 'src/self-implement/goal-author.ts', 'src/tui/design-tokens.ts'] });
    expect(result.riskCategories).toEqual([]);
  });

  test('plain UI/string paths stay L1–L3 by code path count', () => {
    for (let n = 1; n <= PLAIN_PATHS.length; n += 1) {
      const result = classifyWorkRisk({ paths: PLAIN_PATHS.slice(0, n) });
      const expected = n <= PLAIN_L1_MAX_PATHS ? 'L1' : n <= PLAIN_L2_MAX_PATHS ? 'L2' : 'L3';
      expect(result.level).toBe(expected);
      expect(result.riskCategories).toEqual([]);
    }
  });

  test('docs do not count as code paths; no code paths is L3, not a risk level', () => {
    const result = classifyWorkRisk({ paths: ['docs/manual/MANUAL-session-store.md', 'README.md'] });
    expect(result).toMatchObject({ level: 'L3', bloom: 'apply', riskCategories: [] });
  });

  test('mixed plain + risky paths → L4+; more categories raise the level up to L6', () => {
    const mixed = classifyWorkRisk({ paths: [...PLAIN_PATHS, CATEGORY_FIXTURES.persistence[0]!] });
    expect(mixed.level).toBe('L4');
    expect(mixed.bloom).toBe('analyze');
    const two = classifyWorkRisk({ paths: [CATEGORY_FIXTURES.persistence[0]!, CATEGORY_FIXTURES.locking[0]!] });
    expect(two.riskCategories).toEqual(['persistence', 'locking']);
    expect(two.level).toBe('L5');
    const all = classifyWorkRisk({ paths: WORK_RISK_CATEGORIES.map((category) => CATEGORY_FIXTURES[category][0]!) });
    expect(all.riskCategories).toEqual([...WORK_RISK_CATEGORIES]);
    expect(all.level).toBe('L6');
    expect(all.bloom).toBe('create');
  });

  test('declared categories count; unknown names are dropped', () => {
    const result = classifyWorkRisk({ paths: [PLAIN_PATHS[0]!], declaredCategories: ['Locking', 'vibes'] });
    expect(result.riskCategories).toEqual(['locking']);
    expect(result.reasons).toContain('declared:locking');
  });

  test('explicit level is honoured for plain work but cannot drop below the risk floor', () => {
    expect(classifyWorkRisk({ paths: [PLAIN_PATHS[0]!], explicitLevel: 'L5' }).level).toBe('L5');
    const lowered = classifyWorkRisk({ paths: ['src/auth/credentials.ts'], explicitLevel: 'L1' });
    expect(lowered.level).toBe('L4');
    expect(lowered.reasons).toContain('explicit-below-risk-floor:L1->L4');
  });

  test('#38155 file list (first target in the ask) is persistence work → L4', () => {
    const result = classifyWorkRisk({ paths: PR_38155_FILES });
    expect(result.riskCategories).toEqual(['persistence']);
    expect(result.level).toBe('L4');
    const persistReasons = result.reasons.filter((reason) => reason.startsWith('path:persistence:'));
    expect(persistReasons).toEqual(PR_38155_FILES.filter((path) => path.includes('-persist')).map((path) => `path:persistence:${path}`));
  });

  test('reasons are bounded and the level-setting reason survives the cut', () => {
    const many = Array.from({ length: WORK_ROUTE_MAX_REASONS + PLAIN_PATHS.length }, (_, n) => `src/db/table-${n}.ts`);
    const { reasons } = classifyWorkRisk({ paths: many });
    expect(reasons).toHaveLength(WORK_ROUTE_MAX_REASONS);
    expect(reasons[0]).toBe('risk-floor:L4');
  });

  test('light field parser reads only line-head fields, never prose', () => {
    const doc = ['lock the session store in prose', '대상 경로: `src/a.ts` · src/b.ts', '위험 범주: security', '위험 등급: l5'].join('\n');
    expect(workRiskInputFromFields(doc)).toEqual({ paths: ['src/a.ts', 'src/b.ts'], declaredCategories: ['security'], explicitLevel: 'L5' });
    expect(workRiskInputFromFields('lock the session store')).toEqual({ paths: [] });
  });

  test('L4+ is the risky line', () => {
    expect(WORK_LEVELS.filter(isRiskyLevel)).toEqual(['L4', 'L5', 'L6']);
  });

  test('pure: same input, same output', () => {
    const input = { paths: [...PR_38155_FILES], declaredCategories: ['security'] };
    expect(classifyWorkRisk(input)).toEqual(classifyWorkRisk(input));
  });
});
