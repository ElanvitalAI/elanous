// CAPSULE-A5 모델 계약 — 20261118-92460 한 갈래 문구(A3 #38772~#38779 착지 반영)를 리터럴로 증명한다.
// 기대값은 제품 상수가 아니라 손으로 쓴 독립 리터럴/정규식(OP 규칙 11).
// 옛 off 갈래·both-flags·바이트 동일·capsuleStageEnabled 플래그 시험 철회 —
// 갈래가 하나뿐이며 A5 문구는 스위치 없이 적용된다.
import { describe, expect, test } from 'bun:test';
import { buildAgentTool } from '../skills/tools/agent.js';
import { a5Wordings } from './a5-wording.js';

describe('CAPSULE-A5 모델 계약 — 한 갈래', () => {
  test('조립된 Agent 기술 전체 = 손으로 쓴 완결 리터럴과 바이트 동일', () => {
    const HAND_AGENT_DESCRIPTION =
      'Delegate a focused unit of work to a sub-agent that runs in its own context window. Use this when:\n' +
      '  • The work would consume a lot of tool output you do not need to keep in your own history (e.g. large file reads, long bash output).\n' +
      '  • You want to fan out N independent workers in parallel — call Agent N times in the same turn; each runs independently.\n' +
      '  • A SKILL.md instructs you to "spawn N expert agents" / "use the Agent tool" — that is exactly this tool.\n' +
      '\n' +
      'Delegate heavy multistep work that would overflow your context, fan out independent units in parallel, and hand off long investigations; launches run in the background by default — the spawn returns immediately and the worker\'s final message arrives on the next turn as a <task-notification>. Contract: once launched, finish this turn — do not poll for the child. Delivery differs by completion_delivery: "follow-up" (default) results arrive as a new turn event (<task-notification>); "supplement" results arrive as one concise chat line and never reopen a TUI turn.\n' +
      'For parallel research, prefer completion_delivery="supplement" and budget_minutes=8: ask each child for its best verified evidence within the budget; late results appear as one chat line without reopening a TUI turn. At the fan-out ceiling (11 live background agents) a new launch waits on the shared admission queue by default and spawns as soon as a slot reopens; only an explicit wait_for_slot=false gets the immediate \"NOT SPAWNED\" refusal.\n' +
      '\n' +
      'The sub-agent inherits the parent-provided tool catalog by default (Agent recursion is removed) and its own turn budget (default 20). It returns ONE final message which is delivered to you as a <task-notification> user message (or one supplement chat line). Pass everything the worker needs (data, persona, framing) inside `prompt` — the worker starts with no memory of your conversation.';
    const spec = buildAgentTool();
    expect(spec.description).toBe(HAND_AGENT_DESCRIPTION);
  });

  test('8필드 전부 = 손으로 쓴 리터럴 · agentLaunchContract splice 무결성', () => {
    const w = a5Wordings();
    expect(w.agentOutputDescription).toBe(
      "Peek at the current state of a background AgentTask by id. Pairs with Agent background launches. block=false (default) returns immediately: retrievalStatus='not_ready' while the task is still pending/running, else the terminal result. block=true waits up to timeoutMs for terminal state and returns retrievalStatus='timeout' if the wait elapses — a completed task always returns its result. The default flow is fire-and-forget: once a background task is launched, finish this turn — the result arrives on its own as a new turn event (<task-notification> for follow-up, one chat line for supplement). Do not loop on this tool waiting for completion.",
    );
    expect(w.agentOutputTimeoutParam).toBe(
      "Upper bound on one blocking peek when block=true, clamped to the hard cap. Keep it short: this is a status check, not a wait for the result — the result arrives on its own as a new turn event. Ignored when block=false.",
    );
    expect(w.agentOutputWaitHint).toBe(
      "end your turn — the result arrives on its own as a new turn event (<task-notification>)",
    );
    expect(w.agentLaunchContract).toBe(
      "and hand off long investigations; launches run in the background by default — the spawn returns immediately and the worker's final message arrives on the next turn as a <task-notification>. Contract: once launched, finish this turn — do not poll for the child. Delivery differs by completion_delivery: \"follow-up\" (default) results arrive as a new turn event (<task-notification>); \"supplement\" results arrive as one concise chat line and never reopen a TUI turn.\nFor parallel research, prefer completion_delivery=\"supplement\" and budget_minutes=8: ask each child for its best verified evidence within the budget; late results appear as one chat line without reopening a TUI turn. At the fan-out ceiling (11 live background agents) a new launch waits on the shared admission queue by default and spawns as soon as a slot reopens; only an explicit wait_for_slot=false gets the immediate \"NOT SPAWNED\" refusal.\n\nThe sub-agent inherits the parent-provided tool catalog by default (Agent recursion is removed) and its own turn budget (default 20). It returns ONE final message which is delivered to you as a <task-notification> user message (or one supplement chat line). Pass everything the worker needs (data, persona, framing) inside `prompt` — the worker ",
    );
    expect(w.agentWaitForSlot).toBe(
      "Only meaningful with run_in_background. Default true: when the per-session fan-out ceiling (11 live background agents) is full, this launch waits on the shared admission queue and spawns as soon as a live background agent finishes. Waiting subagent spawns (ones that name a subagent_type) are admitted before general-purpose ones; launches of the same class keep arrival order. Pass false explicitly to skip the queue and get the immediate \"NOT SPAWNED\" refusal — then re-issue the launch later.",
    );
    expect(w.agentRunInBackground).toBe(
      "Default true: returns the spawn handle immediately instead of waiting for completion. The child keeps running; its final message arrives in your next turn as a <task-notification> user message. When false, the call waits for the child only up to a cap, then detaches it — the detached child's result still arrives as a <task-notification>. Use for long-running explorations (multi-minute research, 10+ tool calls) so you can keep working in parallel.",
    );
    expect(w.shellPollDescription).toBe(
      "Read the current state of a shell-runner handle by id — immediate status only. Returns status, elapsed, and exit code if the command has resolved. Does not block. A backgrounded command finishes on its own and its completion arrives as a new turn event — do not poll in a loop waiting for it to finish.",
    );
    expect(w.runShellMode).toBe(
      "Shell-runner mode. Omit for the legacy argv-only path. 'inline' captures command output; 'bg' registers it for later ShellPoll (completion also arrives on its own as a turn event — do not poll in a loop).",
    );
    // splice integrity: contract must end with 'the worker ' so agent.ts appends
    // 'starts with no memory of your conversation.' into a complete sentence.
    expect(w.agentLaunchContract.endsWith('the worker ')).toBe(true);
  });

  test('옛 문구 부재 — 폴링 재호출·결과 대기 유도가 사라졌다', () => {
    const w = a5Wordings();
    const all = [
      w.agentOutputDescription,
      w.agentOutputTimeoutParam,
      w.agentOutputWaitHint,
      w.agentLaunchContract,
      w.agentWaitForSlot,
      w.agentRunInBackground,
      w.shellPollDescription,
      w.runShellMode,
    ];
    for (const s of all) {
      expect(s).not.toMatch(/call again with the same taskId/i);
      expect(s).not.toMatch(/finish after the results arrive/i);
    }
    expect(w.agentRunInBackground).not.toMatch(/When true, the call waits/i);
    // 옛 tool_result 배달 문구도 철회 — 결과는 새 턴 사건으로만 온다.
    expect(w.agentLaunchContract).not.toMatch(/becomes your tool_result/);
  });
});
