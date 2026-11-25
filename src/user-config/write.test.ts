// ELN-CONFIG-SET-DROPS — serializeUserConfig 의 chat whitelist 가 autoCompact.workingBudgetTokens 를 안 실어
// `config set` 이 다른 칸을 고칠 때마다 드롭되던 결함의 왕복 시험. (seatTurnCap 은 SEAT-TURN-CAP-DEFAULT-15M 로 옵션 삭제됨.)
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUserConfig, saveUserConfig } from '../user-config.js';

describe('serializeUserConfig: chat.autoCompact.workingBudgetTokens round-trip (잠복 드롭)', () => {
  // autoCompact.workingBudgetTokens — 타입(chat.ts:32)·디폴트(256_000)·파서(chat.ts:260 positiveIntOr)에는
  // 있으나 serializeUserConfig chat whitelist 에 없어, `config set` 이 다른 칸을 고칠 때마다 드롭된다.
  // 재현 리터럴 — 운영에서 사용자가 명시적으로 설정하는 값(기본 아님)으로 round-trip.
  const BUDGET = 384_000; // 출처: #92090 TC 재현 레시피(ELN-CONFIG-SET-DROPS) — 화이트리스트 대조 실측, 사용자 설정값(기본 256_000 아님)으로 식별

  test('config set 아무 칸 → workingBudgetTokens 보존(리터럴)', () => {
    const root = mkdtempSync(join(tmpdir(), 'eln-autocompact-budget-rt-'));
    try {
      const path = join(root, 'config.json');
      writeFileSync(path, JSON.stringify({ chat: { autoCompact: { workingBudgetTokens: BUDGET } } }));
      const cfg = buildUserConfig(path);
      expect(cfg.chat.autoCompact.workingBudgetTokens).toBe(BUDGET);
      // `config set` 으로 다른 칸(guardian.mode)을 고친 뒤 저장하는 것과 같은 호출 경로.
      cfg.guardian = { mode: 'live' };
      saveUserConfig(cfg, path);
      const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { chat?: { autoCompact?: { workingBudgetTokens?: unknown } } };
      expect(onDisk.chat?.autoCompact?.workingBudgetTokens).toBe(BUDGET);
      // 재읽기(재시작)에서도 보존.
      expect(buildUserConfig(path).chat.autoCompact.workingBudgetTokens).toBe(BUDGET);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('미설정이면 workingBudgetTokens 칸을 쓰지 않는다(최소 파일 유지)', () => {
    const root = mkdtempSync(join(tmpdir(), 'eln-autocompact-budget-min-'));
    try {
      const path = join(root, 'config.json');
      writeFileSync(path, JSON.stringify({}));
      const cfg = buildUserConfig(path);
      cfg.guardian = { mode: 'live' };
      saveUserConfig(cfg, path);
      const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { chat?: { autoCompact?: { workingBudgetTokens?: unknown } } };
      expect(onDisk.chat?.autoCompact?.workingBudgetTokens).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('serializeUserConfig: chat.factQuestion.maxToolTurns round-trip (11-25 «저장 후 값 미반영»)', () => {
  test('a set value survives save and re-read; the default is not written', () => {
    const root = mkdtempSync(join(tmpdir(), 'eln-fact-budget-rt-'));
    try {
      const path = join(root, 'config.json');
      writeFileSync(path, JSON.stringify({ chat: { factQuestion: { maxToolTurns: 60 } } })); // 출처: #40092 ops «config set … 60» repro
      const cfg = buildUserConfig(path);
      expect(cfg.chat.factQuestion.maxToolTurns).toBe(60);
      cfg.guardian = { mode: 'live' };
      saveUserConfig(cfg, path);
      const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { chat?: { factQuestion?: { maxToolTurns?: unknown } } };
      expect(onDisk.chat?.factQuestion?.maxToolTurns).toBe(60);
      expect(buildUserConfig(path).chat.factQuestion.maxToolTurns).toBe(60);
      writeFileSync(path, JSON.stringify({}));
      const plain = buildUserConfig(path);
      plain.guardian = { mode: 'live' };
      saveUserConfig(plain, path);
      const minimal = JSON.parse(readFileSync(path, 'utf8')) as { chat?: { factQuestion?: unknown } };
      expect(minimal.chat?.factQuestion).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
