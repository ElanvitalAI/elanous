export interface ArchitectureMapEntry {
  id: string;
  title: string;
  oneLine: string;
  docs: string[];
  code: string[];
}

/** Four pillars, the observing floor and the execution foundation. Paths are repository-relative. */
export const ARCHITECTURE_MAP: readonly ArchitectureMapEntry[] = [
  {
    id: 'mission-fabric', title: '미션 패브릭', oneLine: '들어온 일을 미션으로 정하고 실행에 잇습니다.',
    docs: ['docs/manual/MANUAL-mission-fabric-integration-2026-09-03.md'],
    code: ['src/mission-loop/composite-cycle.ts', 'src/harness/mission-solve-loop.ts'],
  },
  {
    id: 'graph-engineering', title: '그래프 엔지니어링', oneLine: '실행의 노드와 경로를 그래프로 읽습니다.',
    docs: ['docs/manual/MANUAL-graph-operations-2026-09-10.md'],
    code: ['src/self-implement/graph-templates.ts', 'src/self-implement/graph-authority.ts'],
  },
  {
    id: 'pty-intelligence', title: 'PTY 인텔리전스', oneLine: '에이전트가 터미널의 실행과 관측을 연결합니다.',
    docs: ['docs/manual/MANUAL-external-agent-pty-missions-2026-08-11.md'],
    code: ['src/self-dev/dev-cli.ts'],
  },
  {
    id: 'loop-agent', title: '루프 에이전트', oneLine: '일을 반복 관측하고 다음 행동을 고릅니다.',
    docs: ['docs/manual/MANUAL-execution-and-landing-loops-2026-09-29.md'],
    code: ['src/harness/mission-solve-loop.ts', 'src/mission-loop/composite-cycle.ts'],
  },
  {
    id: 'observation', title: '바닥 · 관측·인지·힐링', oneLine: '본 것을 이해하고 스스로 고치는 바닥입니다.',
    docs: ['docs/manual/MANUAL-self-cognition-observability-2026-07-14.md'],
    code: ['src/self-implement/orchestrator.ts'],
  },
  {
    id: 'harness', title: '받침 · 하니스', oneLine: '구현과 검증이 지나가는 실행 받침입니다.',
    docs: ['docs/TECH-harness-execution-anatomy-current-state-2026-08-10.md'],
    code: ['src/self-implement/orchestrator.ts', 'src/self-dev/dev-cli.ts'],
  },
];
