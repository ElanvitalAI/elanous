/**
 * 마법사 «원형» — 사람이 말로 자주 시키는 일의 뼈대 셋. graphs/** 의 운영 템플릿(개발·출시 루프)은
 * «모아서 요약해 보내기» 같은 말과 낱말이 안 겹쳐 엉뚱한 기반(lecture-note)을 골랐다(10-08 라이브 실측).
 * 원형은 기반 후보 «맨 앞»에 서고, 키워드가 겹치는 만큼 점수를 얻는다.
 */
export interface WizardArchetype { id: string; description: string; keywords: string[]; text: string }

export const WIZARD_ARCHETYPES: readonly WizardArchetype[] = [
  {
    id: 'wizard-collect-summarize-send',
    description: '모아서 요약해 보내기 — 검색·수집 → 요약 → 텔레그램/알림 발송 (브리핑·다이제스트·동향)',
    keywords: ['뉴스', '모아', '수집', '검색', '찾아', '요약', '정리', '보내', '알려', '텔레그램', '브리핑', '동향', '소식', 'news', 'digest', 'summary'],
    text: `graph_id: wizard-collect-summarize-send
loop:
  title: 모아서 요약해 보내기
  description: 검색으로 모은 내용을 요약해 텔레그램으로 보낸다
  trigger:
    cron: "0 8 * * *"
version: 1
entry_node: collect
terminal_nodes: [done, failed]
nodes:
  - { node_id: collect, kind: agent, recipe: 'cmd:collect', max_visits: 1 }  # 수집 | web-search | 검색어
  - { node_id: summarize, kind: agent, recipe: 'cmd:summarize', max_visits: 1 }  # 요약 | summarize | 핵심 5줄 한국어
  - { node_id: send, kind: agent, recipe: 'cmd:send', max_visits: 1 }  # 텔레그램 발송 | telegram-send
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }  # 완료
  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }  # 실패
edges:
  - { from: collect, on: outcome, map: { ok: summarize, fail: failed } }
  - { from: summarize, on: outcome, map: { ok: send, fail: failed } }
  - { from: send, on: outcome, map: { ok: done, fail: failed } }
`,
  },
  {
    id: 'wizard-review-merge',
    description: 'PR 리뷰 후 머지 — 리뷰 → must-fix 없으면 승인 뒤 머지 (있으면 멈추고 알림)',
    keywords: ['pr', '리뷰', '머지', '병합', '풀리퀘', 'must', 'fix', 'review', 'merge'],
    text: `graph_id: wizard-review-merge
loop:
  title: PR 리뷰 후 머지
  description: PR 을 리뷰하고 must-fix 가 없으면 머지한다
  trigger:
    events: [pr-opened]
version: 1
entry_node: review
terminal_nodes: [done, failed]
nodes:
  - { node_id: review, kind: judge, recipe: 'cmd:review', max_visits: 1 }  # PR 리뷰 | gh-pr-review
  - { node_id: approve-merge, kind: hitl, recipe: 'approval:approve-merge', max_visits: 1 }  # 머지 승인 | approval
  - { node_id: merge, kind: git, recipe: 'cmd:merge', max_visits: 1 }  # PR 머지 | gh-pr-merge
  - { node_id: notify, kind: agent, recipe: 'cmd:notify', max_visits: 1 }  # must-fix 알림 | notify-me | PR 에 must-fix 가 있어 머지하지 않았다
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }  # 완료
  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }  # 실패
edges:
  - { from: review, on: outcome, map: { ok: approve-merge, must-fix: notify, fail: failed } }
  - { from: approve-merge, on: outcome, map: { ok: merge, fail: failed } }
  - { from: merge, on: outcome, map: { ok: done, fail: failed } }
  - { from: notify, on: outcome, map: { ok: done, fail: failed } }
`,
  },
  {
    id: 'wizard-research-approve-publish',
    description: '조사해 정리하고 승인 뒤 게시 — 조사 → 표/초안 정리 → 사람 승인 → 게시',
    keywords: ['조사', '가격', '경쟁', '표', '정리', '승인', '올려', '게시', '노션', '초안', '블로그', '보고서'],
    text: `graph_id: wizard-research-approve-publish
loop:
  title: 조사해 정리하고 승인 뒤 게시
  description: 조사한 내용을 표로 정리하고 사람 승인 뒤 게시한다
  trigger:
    events: [manual]
version: 1
entry_node: research
terminal_nodes: [done, failed]
nodes:
  - { node_id: research, kind: agent, recipe: 'cmd:research', max_visits: 1 }  # 조사 | web-search | 조사 주제
  - { node_id: tabulate, kind: agent, recipe: 'cmd:tabulate', max_visits: 1 }  # 표로 정리 | llm | 결과를 마크다운 표로 정리
  - { node_id: approve, kind: hitl, recipe: 'approval:approve', max_visits: 1 }  # 게시 승인 | approval
  - { node_id: publish, kind: agent, recipe: 'cmd:publish', max_visits: 1 }  # 게시 | custom | 게시처에 올리기
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }  # 완료
  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }  # 실패
edges:
  - { from: research, on: outcome, map: { ok: tabulate, fail: failed } }
  - { from: tabulate, on: outcome, map: { ok: approve, fail: failed } }
  - { from: approve, on: outcome, map: { ok: publish, fail: failed } }
  - { from: publish, on: outcome, map: { ok: done, fail: failed } }
`,
  },
];
