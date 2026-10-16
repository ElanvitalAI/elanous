// TUI-SLASH-SPLIT-MISSION(D4b) — /mission 을 src/tui/slash/mission.ts 로 «순수 이동»한 뒤의 행위 계약.
// 등록 위치·순서(한 번만) ⊕ 하위 명령별 사용법 경로(인자 없음 → usage · 미션 DB·워처 무접촉)를 문다.
import { describe, expect, test } from 'bun:test';
import { buildDashboardSlashRegistry } from '../src/dashboard/slash-runtime/dashboard-handlers.js';
import { SlashCommandRegistry } from '../src/dashboard/slash-runtime/registry.js';
import * as oldEntry from '../src/dashboard/slash-runtime/index.js';
import { handleMissionSlash, registerMissionSlash, type MissionSlashContext } from '../src/tui/slash/mission.js';

function fakeCtx(): { ctx: MissionSlashContext; watches: string[]; scroll: number[] } {
  const watches: string[] = [];
  const scroll: number[] = [];
  const id = (t: string): string => t;
  const ctx: MissionSlashContext = {
    chatLines: [],
    setChatScrollOffset: (v) => { scroll.push(v); },
    muted: id, accent: id, text: id, error: id, success: id, warning: id, info: id, subtext: id,
    missionTui: {
      startReadyWatch: (m) => { watches.push(`ready:${m}`); },
      startRunWatch: (m) => { watches.push(`run:${m}`); },
    },
  };
  return { ctx, watches, scroll };
}

describe('/mission 등록 (src/tui/slash/mission.ts)', () => {
  test('대시보드 레지스트리에 옛 자리(harness 다음 · ad 앞)에 한 번만 등록된다', () => {
    const names = buildDashboardSlashRegistry().names();
    expect(names.filter((n) => n === 'mission')).toHaveLength(1);
    expect(names.indexOf('mission')).toBe(names.indexOf('harness') + 1);
    expect(names.indexOf('ad')).toBe(names.indexOf('mission') + 1);
  });

  test('옛 입구(slash-runtime/index.ts)가 새 집의 공개 심볼을 그대로 낸다', () => {
    expect(oldEntry.registerMissionSlash).toBe(registerMissionSlash);
    expect(oldEntry.handleMissionSlash).toBe(handleMissionSlash);
  });

  test('registerMissionSlash 는 빈 레지스트리에 mission 하나만 단다(별칭 없음)', () => {
    const reg = new SlashCommandRegistry<MissionSlashContext, never>();
    registerMissionSlash(reg);
    expect(reg.names()).toEqual(['mission']);
  });
});

describe('/mission 하위 명령 사용법 경로 (인자 없음 → usage · 워처 무접촉)', () => {
  const cases: Array<[string[], string]> = [
    [['new'], '  usage: /mission new <goal 문장>'],
    [['revise'], '  usage: /mission revise <apm_id> <정정 코멘트>'],
    [['phases'], '  usage: /mission phases <apm_id>'],
    [['trim'], '  usage: /mission trim <apm_id> <phase index|task id>'],
    [['defer'], '  usage: /mission defer <apm_id> <phase index|task id>'],
    [['edit'], '  usage: /mission edit <apm_id> <phase> <새 제목> (설명 교정은 CLI/tool 의 description)'],
    [['approve'], '  usage: /mission approve <apm_id> — 승인·집행 시작'],
    [['hold'], '  usage: /mission hold <apm_id> — 보류(기록 유지·실행 안 함)'],
    [['rerun'], '  usage: /mission rerun <apm_id> — 처음부터 재실행(세대+1·이전 PR close)'],
    [['rebuild', 'apm_x'], '  usage: /mission rebuild <apm_id> <phase index|task id> — 그 페이즈부터 재구현'],
    [['rereflect'], '  usage: /mission rereflect <apm_id> — 비평 지적 페이즈만 자동 재구현(머지는 HITL)'],
    [['split', 'apm_x'], '  usage: /mission split <apm_id> <phase index> — 과대 페이즈를 단일책임 서브페이즈로 재분해'],
    [['skip', 'apm_x'], '  usage: /mission skip <apm_id> <phase index> — 페이즈 건너뛰기(기능 제외·부분 완주)'],
    [['log'], '  usage: /mission log <apm_id> [줄수(기본 40)] — 미션 실행 로그 tail'],
    [['watch'], '  usage: /mission watch <apm_id>'],
    [['trace'], '  usage: /mission trace <apm_id>'],
    [['brief'], '  usage: /mission briefing <apm_id> [grounded] — 실집행 전 종합 브리핑(골 진화·여정·산출물·정착). grounded=PR merge 현실 대조(느림)'],
    [['land'], '  usage: /mission landing <apm_id> — 완주 전 미머지 PR 빠른 스캔'],
    [['arm'], '  usage: /mission arm <apm_id>'],
  ];
  for (const [args, usage] of cases) {
    test(`/mission ${args.join(' ')}`, async () => {
      const { ctx, watches, scroll } = fakeCtx();
      await handleMissionSlash(args, ctx);
      expect(ctx.chatLines[0]).toBe('');
      expect(ctx.chatLines.at(-1)).toBe(usage);
      expect(watches).toEqual([]);
      expect(scroll).toEqual([-1]);
    });
  }

  test('대소문자 무시 · 모르는 하위 명령은 «❯ /mission» ⊕ unknown ⊕ 전체 usage', async () => {
    const { ctx, watches } = fakeCtx();
    await handleMissionSlash(['BOGUS'], ctx);
    expect(ctx.chatLines.slice(0, 3)).toEqual(['', '❯ /mission', '  unknown subcommand: bogus']);
    expect(ctx.chatLines.at(-1)).toStartWith('  usage: /mission [list [status]] | new <goal> |');
    expect(watches).toEqual([]);
  });
});
