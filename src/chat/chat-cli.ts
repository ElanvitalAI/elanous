// chat CLI 글루 seam — runDevPipeline interactive dispatch 재라우팅(U4b·2026-07-25).
//
// index.ts 의 chat 액션에서 "재라우팅 로직"(opts→spec 매핑 + runDevPipeline 라우팅)을 추출한다. 액션은
// 온보딩·config·하니스-자식 log-sink·chat 턴 실행(runChatTurnCli 클로저)만 담당한다.
//
// ⚠️ chat 엔진(runChatTurnCli)은 index.ts 소유(cfg/세션스토어/온보딩 결합)라 dev-pipeline·이 seam 이 직접
//    import 불가(순환). 따라서 interactive dispatch 는 cfg-바인딩된 runChatTurn 클로저를 CLI 레이어가 주입한다
//    (executor≠pipeline-소유·설계상 CLI-레이어 소유). self implement/orchestrate 처럼 리치 결과가 없어 exit-code
//    매핑도 없다(runChatTurnCli 가 자체 I/O·성공 exit 0·bad-session 내부 exit 1).
//
// 계약: [[PLAN-unified-selfdev-cli-runDevPipeline-2026-07-25]] §7 U4b · self-implement-cli/orchestrate-cli 대칭.

import { buildChatDevSpec, runDevPipeline } from '../self-dev/dev-pipeline.js';
import type { DevChatOpts } from '../self-dev/dev-pipeline.js';

/** chat CLI 옵션(commander) — `--new`/`--tools`/`--goal-loop` 는 boolean, `--session` 은 id/prefix. */
export interface ChatCliOpts {
  session?: string;
  new?: boolean;
  json?: boolean;
  tools?: boolean;
  goalLoop?: boolean;
}

export interface ChatCliDeps {
  /** cfg-바인딩된 chat 턴 실행(index.ts 가 runChatTurnCli 클로저로 주입·필수). */
  runChatTurn: (text: string, chat: DevChatOpts) => Promise<void>;
  /** runDevPipeline 주입(테스트). 기본 실 runDevPipeline. */
  runDevPipeline?: typeof runDevPipeline;
}

/** CLI 옵션 → DevChatOpts(--new→forceNew·나머지 boolean 정규화). reuseActive 는 dispatch 클로저에서 !forceNew 파생.
 *  session 은 `!== undefined` 로 통과(원 액션 explicitSessionId:opts.session 과 정확 등가 — 빈 문자열도 그대로,
 *  runChatTurnCli 가 falsy 처리해 결과는 동일하나 중간값까지 무손실 유지). */
export function toDevChatOpts(opts: ChatCliOpts): DevChatOpts {
  return {
    ...(opts.session !== undefined ? { session: opts.session } : {}),
    forceNew: opts.new === true,
    json: opts.json === true,
    enableTools: opts.tools === true,
    goalLoop: opts.goalLoop === true,
  };
}

/**
 * chat 재라우팅 — userText + CLI 옵션을 interactive DevPipelineSpec 으로 매핑, runDevPipeline 로 라우팅해 주입된
 * runChatTurn(cfg-바인딩 runChatTurnCli)을 구동한다. 결과·exit-code 없음(chat 턴은 자체 I/O). 무손실 등가.
 */
export async function runChatCliCommand(text: string, opts: ChatCliOpts, deps: ChatCliDeps): Promise<void> {
  const spec = buildChatDevSpec(text, toDevChatOpts(opts));
  const run = deps.runDevPipeline ?? runDevPipeline;
  await run(spec, {
    runChatTurn: deps.runChatTurn,
    ...(opts.json ? { progress: (message: string) => { process.stderr.write(`${message}\n`); } } : {}),
  });
}
