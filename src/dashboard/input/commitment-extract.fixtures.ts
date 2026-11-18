// ── 약속 추출 시험 fixture (ELN-COMMITMENT-LEDGER · I1) ──
// 양성 = 원장 항목이 돼야 하는 문장(꼴·내용·깨울 조건 단서) · 음성 = 오탐하면 안 되는 문장(과거·가정·질문·인용·코드·부정).
// 11-17 D/E/MOB-1 자리 답 꼬리의 문형(METHOD-SELF-PROACTIVE-1117 S)을 본떠 지었다 — 실자리 원문 아님.
import type { CommitmentPattern, CommitmentWaitHint } from './commitment-extract.js';

export interface PositiveCommitmentFixture {
  name: string;
  input: string;
  pattern: CommitmentPattern;
  text: string;
  waitHint?: CommitmentWaitHint;
}

export const POSITIVE_COMMITMENTS: readonly PositiveCommitmentFixture[] = [
  { name: '다음 스텝 선언 ⊕ PR 착지 단서', input: '다음 스텝: #38049 착지 확인 후 TC 우편으로 보고.', pattern: 'declared-next-step', text: '#38049 착지 확인 후 TC 우편으로 보고', waitHint: { kind: 'pr-merged', pr: 38049 } },
  { name: '이어서 …합니다', input: '이어서 ELN-SELF-TIMER-WATCH 칸을 진행합니다.', pattern: 'continue-marker', text: '이어서 ELN-SELF-TIMER-WATCH 칸을 진행합니다' },
  { name: '결과 보고하겠습니다', input: '시험을 돌린 뒤 결과를 보고하겠습니다.', pattern: 'report-after-check', text: '시험을 돌린 뒤 결과를 보고하겠습니다' },
  { name: '리뷰 결과 단서', input: 'PR #38050 리뷰 결과 도착하면 must-fix 를 반영하겠습니다.', pattern: 'pledge-ko', text: 'PR #38050 리뷰 결과 도착하면 must-fix 를 반영하겠습니다', waitHint: { kind: 'review', pr: 38050 } },
  { name: '영어 I will', input: "I'll rebase onto origin/main and push the new head.", pattern: 'pledge-en', text: "I'll rebase onto origin/main and push the new head" },
  { name: '영어 Next step', input: 'Next step: wire the extractor into the turn-end gate.', pattern: 'declared-next-step', text: 'wire the extractor into the turn-end gate' },
  { name: '영어 report back', input: 'Let me check the gate result and report back.', pattern: 'report-after-check', text: 'Let me check the gate result and report back' },
  { name: '시간 단서', input: '10분 뒤 게이트 상태를 다시 보겠습니다.', pattern: 'pledge-ko', text: '10분 뒤 게이트 상태를 다시 보겠습니다', waitHint: { kind: 'time', minutes: 10 } },
  { name: '우편 회신 단서 ⊕ …할게요', input: '우편 #4123 회신이 오면 처리할게요.', pattern: 'pledge-ko', text: '우편 #4123 회신이 오면 처리할게요', waitHint: { kind: 'mail-reply', message: 4123 } },
  { name: '목록 기호 ⊕ 화살표 선언', input: '- 다음 단계 → 착지 영수증 정리', pattern: 'declared-next-step', text: '착지 영수증 정리' },
  { name: '명사형 확인 후 보고', input: 'PR 착지 확인 후 보고.', pattern: 'report-after-check', text: 'PR 착지 확인 후 보고' },
];

export interface NegativeCommitmentFixture { name: string; input: string }

export const NEGATIVE_COMMITMENTS: readonly NegativeCommitmentFixture[] = [
  { name: '과거형 보고', input: '어제 #38013 을 머지했습니다.' },
  { name: '영어 과거형', input: 'I rebased onto origin/main and pushed.' },
  { name: '가정 — 원하시면', input: '원하시면 PR 본문도 고치겠습니다.' },
  { name: '가정 — if you', input: "If you want, I'll open a follow-up PR." },
  { name: '영어 could', input: 'I could also split the PR.' },
  { name: '질문 — 물음표', input: '이대로 진행할까요?' },
  { name: '질문 — 영어', input: 'Should I merge it now?' },
  { name: '요청 — 주세요', input: '어느 쪽으로 갈지 알려 주세요.' },
  { name: '요청 — let me know', input: 'let me know if you want changes.' },
  { name: '코드 블록 안', input: '```\n다음 스텝: 이건 코드 안\n```' },
  { name: '인용줄', input: '> 다음 스텝: 인용된 남의 말' },
  { name: '표 줄', input: '| 다음 스텝 | 착지 |' },
  { name: '제목', input: '## 다음 스텝' },
  { name: '«» 인용 속 약속어(문장 중간)', input: '답에 나온 «…하겠습니다» 는 원장 항목이 된다.' },
  { name: '큰따옴표 인용', input: 'OP 가 "내일 하겠습니다" 라고 적었다.' },
  { name: '인라인 코드 속 약속어', input: '`다음 스텝: x` 꼴은 패턴 예시다.' },
  { name: '부정 약속', input: '그 파일은 건드리지 않겠습니다.' },
  { name: '인사·수긍', input: '알겠습니다.' },
  { name: '바람', input: '오늘 안에 끝나면 좋겠습니다.' },
  { name: '선언했지만 완료', input: '다음 스텝: 시험 통과 완료.' },
];
