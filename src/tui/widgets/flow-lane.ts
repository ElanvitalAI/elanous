/**
 * FlowLane — real work items as dots moving left → right through one pipeline stage. Density = the queue the
 * snapshot reports; speed = the stage's measured throughput (cells advanced per snapshot); the frame only
 * interpolates between two snapshots. A blocked stage piles its backlog against the right wall as «▓».
 */
export interface FlowLaneProps {
  /** Items in the stage right now. */
  readonly items: number;
  /** Cells an item advances per snapshot (from the measured rate; 0 = nothing moves). */
  readonly speed: number;
  readonly blocked?: boolean;
  /** Snapshot index — the base position, so consecutive snapshots continue the motion. */
  readonly tick: number;
  readonly frame: number;
  readonly frames?: number;
}

export function renderFlowLane(props: FlowLaneProps, width: number): string {
  const w = Math.max(1, width);
  const cellsArr: string[] = Array.from({ length: w }, () => '─');
  const items = Math.max(0, Math.floor(props.items));
  if (props.blocked) {
    const pile = Math.min(w, items);
    for (let i = 0; i < pile; i++) cellsArr[w - 1 - i] = '▓';
    const moving = Math.max(0, Math.min(items - pile, w - pile));
    placeDots(cellsArr, moving, w - pile, props);
    return cellsArr.join('');
  }
  placeDots(cellsArr, Math.min(items, w), w, props);
  return cellsArr.join('');
}

function placeDots(cellsArr: string[], count: number, span: number, props: FlowLaneProps): void {
  if (count <= 0 || span <= 0) return;
  const frames = props.frames ?? 4;
  const shift = Math.floor(Math.max(0, props.speed) * (props.tick + props.frame / frames));
  const step = span / count;
  for (let i = 0; i < count; i++) {
    const at = (Math.floor(i * step) + shift) % span;
    cellsArr[at] = '•';
  }
}
