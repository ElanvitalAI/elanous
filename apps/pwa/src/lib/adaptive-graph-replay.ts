/** PWA replay envelope for graph-design-sim. The fixture keeps this shape until MVP-A emits frames. */
export interface AdaptiveGraphNode {
  id: string;
  label: string;
  state: 'active' | 'invalidated' | 'superseded';
  why?: string;
}

export interface AdaptiveGraphDiff {
  op: 'add' | 'remove' | 'replace';
  nodeId: string;
  from?: string;
  to?: string;
  why: string;
}

export interface AdaptiveConclusion {
  title: string;
  summary: string;
  forecast?: string;
  recommendation?: string;
  evidence?: string;
  counterEvidence?: string;
  sources?: { label: string; url: string }[];
}

export interface AdaptiveBloomQuestion {
  id: string;
  level: 4 | 5;
  text: string;
  sourceNodeId: string;
}

export interface AdaptiveGraphFrame {
  revision: string;
  at: string;
  label: string;
  nodes: AdaptiveGraphNode[];
  diff: AdaptiveGraphDiff[];
  conclusion?: AdaptiveConclusion;
  bloomQuestions?: AdaptiveBloomQuestion[];
}

export interface AdaptiveGraphReplay {
  runId: string;
  simulated: boolean;
  frames: AdaptiveGraphFrame[];
}

export function frameAt(replay: AdaptiveGraphReplay, index: number): AdaptiveGraphFrame | undefined {
  if (!Number.isInteger(index)) return undefined;
  return replay.frames[Math.max(0, Math.min(index, replay.frames.length - 1))];
}

export function changedNodeIds(frame: AdaptiveGraphFrame): Set<string> {
  return new Set(frame.diff.flatMap((change) => [change.nodeId, change.from, change.to].filter((id): id is string => Boolean(id))));
}
