/** Script timing and pre-recorded failover map for the 11-04 demo. */
export const DEMO1104_STAGE_CONFIG = {
  failoverDeadlineMs: 5_000,
  acts: [
    { id: 'prologue', title: '프롤로그', targetStartSec: 0, targetEndSec: 40, highlightVideoId: null },
    { id: 'act-1', title: '아침 브리핑', targetStartSec: 40, targetEndSec: 90, highlightVideoId: 'V1' },
    { id: 'act-2', title: '깊이 파기', targetStartSec: 90, targetEndSec: 210, highlightVideoId: 'V2' },
    { id: 'act-3', title: '맡기기', targetStartSec: 210, targetEndSec: 240, highlightVideoId: 'V3' },
    { id: 'act-4', title: '끝까지 처리', targetStartSec: 240, targetEndSec: 420, highlightVideoId: 'V4' },
    { id: 'act-5', title: '스스로 만든다', targetStartSec: 420, targetEndSec: 510, highlightVideoId: 'V5' },
    { id: 'act-6', title: '이어진다', targetStartSec: 510, targetEndSec: 570, highlightVideoId: 'V6' },
    { id: 'epilogue', title: '에필로그', targetStartSec: 570, targetEndSec: 600, highlightVideoId: null },
  ],
  lanes: [
    { id: 'secretary', title: '업무 비서', startsAtAct: 'prologue' },
    { id: 'maker', title: '만드는 엘라누스', startsAtAct: 'prologue' },
  ],
} as const;

export type DemoActId = typeof DEMO1104_STAGE_CONFIG.acts[number]['id'];
export type DemoLaneId = typeof DEMO1104_STAGE_CONFIG.lanes[number]['id'];
