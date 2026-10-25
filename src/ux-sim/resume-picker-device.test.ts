// 재현 — TUI-RESUME-PICKER(10-23 00:44 대표 보고 · OP 22:4x n8n 세션 재기동 때도 봄):
// `/resume` Enter → «usage: /session load <id-prefix>» 뿐 고를 목록 없음 ⊕ `/session list` 의 id 가 잘림.
// 설치본 0.2.36-dev.0-f32b610b89f9 로 같은 장치를 돌리면: classic `/session list` 가 앞 8자 같은 세 세션을
// «c0ffee00» 세 줄로 똑같이 보여 주고, next 는 `/resume` 을 채팅 턴으로 모델에 보낸다.
// 진짜 PTY 로 TUI 를 띄워 한 판에 30~60초라 기본 게이트 밖 — `ELANOUS_N03_SLOW=1` 일 때만 돈다.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runResumePickerDevice } from './resume-picker-device.js';

const REPO_CLI = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');

describe('N03 TUI-RESUME-PICKER 장치 (이 트리 · fake LLM · 앞 8자 같은 세션 셋)', () => {
  test.skipIf(process.env.ELANOUS_N03_SLOW !== '1')('classic: /session list 고유 앞자리 · /resume 픽커 · ↓ Enter → 둘째 줄 세션 로드', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-resume-classic-'));
    try {
      const r = await runResumePickerDevice({ tui: 'classic', root: join(dir, 'iso'), executable: process.execPath, entry: REPO_CLI });
      expect(r.checks).toEqual({
        sessionListUniquePrefixes: true, pickerOpenedNotUsage: true, pickerUniquePrefixes: true,
        resumedSecondRow: true, noAmbiguous: true, exitedClean: true,
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 240_000);

  test.skipIf(process.env.ELANOUS_N03_SLOW !== '1')('next: /resume 번호 붙은 목록(고유 앞자리) · /resume 2 → 둘째 줄 대화로 전환', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n03-resume-next-'));
    try {
      const r = await runResumePickerDevice({ tui: 'next', root: join(dir, 'iso'), executable: process.execPath, entry: REPO_CLI });
      expect(r.checks).toEqual({
        listShownNotUsage: true, uniquePrefixesShown: true, rowsNumbered: true,
        resumedRow2ByNumber: true, chosenConversationOnScreen: true, exitedClean: true,
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 240_000);

  // ②③④ — 설치본 2e119dc: `--resume` 뒤 «85 turns restored» 한 줄뿐 지난 대화 미표시 · classic ctx 0.
  for (const tui of ['classic', 'next'] as const) {
    test.skipIf(process.env.ELANOUS_N03_SLOW !== '1')(`${tui}: --resume 379행 세션 → 첫 화면에 마지막 답 · 위로 스크롤하면 첫 질문${tui === 'classic' ? ' · ctx 0 아님' : ''}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), `n03-resume-boot-${tui}-`));
      try {
        const r = await runResumePickerDevice({ tui, mode: 'boot-resume', root: join(dir, 'iso'), executable: process.execPath, entry: REPO_CLI });
        expect(r.checks).toEqual(tui === 'classic'
          ? { lastReplyOnFirstScreen: true, firstTurnReachable: true, exitedClean: true, resumedLine: true, ctxNotZero: true }
          : { lastReplyOnFirstScreen: true, firstTurnReachable: true, exitedClean: true });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }, 240_000);
  }
});
