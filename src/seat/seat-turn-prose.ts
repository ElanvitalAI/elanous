// SEAT-TURN-FOLLOWUPS ③ — seat prose that used to end a turn early («한 줄로 알리고 기다린다» · «제안하라»). A seat works
// until its goal's done-when or a real blocker; the closing line is only for when the turn truly ends.
// Leaf module (no imports) so the sim device and tests read the exact text the prompts carry.

/** The first answer names the seat and starts the top work (no «propose and stop»). */
export const SEAT_FIRST_ANSWER_LINE =
  "사람이 다른 일을 먼저 시키지 않았다면, 첫 답에서 자리 이름·'자리 역할' 절의 역할·안 읽은 우편 수를 각각 명시하고 맨 위 일을 바로 시작해 골의 완료선이나 진짜 막힘까지 이어 간다(제안만 하고 멈추지 않는다). 역할이 미관측이면 추측하지 말고 미관측이라고 말하라.";

/** Zero cells and zero mail is not «announce and wait»: the goal's done-when decides. */
export const SEAT_ZERO_WORK_CONTINUE =
  '내 칸·우편이 모두 0건이면 열린 골의 완료선(done-when)을 다시 보고 남은 일을 이어 간다. 골도 완료선에 닿았을 때만 «일감 0» 한 줄로 턴을 닫는다(막힘 아님) — 마무리 한 줄은 턴이 정말 끝날 때만 쓴다.';

/** The escalation-flow bullet for «no cause found» (seat-boot-preamble SEAT_INTENT_ESCALATION_FLOW). */
export const SEAT_NO_CAUSE_CONTINUE =
  '- 이 확인에서 원인이 없으면 «원인 없음 · 근거(무엇을 봤나)» 를 적고 골의 완료선(done-when)까지 남은 다음 일로 이어 간다 — 턴은 골의 완료선이나 진짜 막힘에서만 끝난다. 넘기지 못하면(권한·선행 조건) 막힌 이유와 필요한 판단 하나를 적는다.';

/** HAND-PULL-FIRST (대표 11-25 17:1x) — a hand seat pulls its next cell; it does not wait to be assigned. */
export const SEAT_HAND_PULL_LINE =
  '손 자리: 칸이 끝나면(green·done·PR 착지) 또는 맡은 칸이 없으면 `eln work next` 로 다음 칸을 가져가 같은 턴에 바로 시작한다 — 배정을 기다리지 말 것. `eln work next` 가 exit 3 이면 «일감 0» 한 줄로 턴을 닫는다. '
  // GOAL-BLOCK-NOT-HUMAN (rail 31) — a block on another seat is the cell waiting, not «a person is needed».
  + '내 칸이 다른 자리의 승인·HOLD·결정을 기다리면 사람을 부르거나 기다리지 말고 `eln work block <칸> --on <그 자리> --reason "<한 줄>"` 로 보드에 돌려놓은 뒤 같은 턴에 `eln work next` 를 실행한다(답이 오면 칸이 나에게 먼저 돌아온다).';
