/** One measured PR in the landing queue. Radius is supplied by the train's classifier. */
export interface HotspotRadiusPr {
  readonly pr: string;
  readonly files: readonly string[];
  readonly radius: number;
  readonly priority?: 'S1' | 'normal';
}

/**
 * Keep unrelated groups in their original relative order. PRs connected through shared files form
 * one hotspot; within it S1 lands first, then wider measured radius, then FIFO.
 * The caller must supply measured radii rather than silently treating unknown as zero.
 */
export function orderHotspotPrsByRadius<T extends HotspotRadiusPr>(queue: readonly T[]): T[] {
  const seenPrs = new Set<string>();
  for (const row of queue) {
    if (!/^\d+$/.test(row.pr) || seenPrs.has(row.pr)) throw new Error(`invalid hotspot PR: ${row.pr}`);
    seenPrs.add(row.pr);
    if (!Number.isFinite(row.radius) || row.radius < 0) throw new Error(`unmeasured hotspot radius: ${row.pr}`);
    if (row.priority !== undefined && row.priority !== 'S1' && row.priority !== 'normal') {
      throw new Error(`invalid hotspot priority: ${row.pr}`);
    }
    if (row.files.some(file => !file || file.startsWith('/'))) throw new Error(`invalid hotspot file: ${row.pr}`);
  }

  const parents = queue.map((_, index) => index);
  const root = (index: number): number => {
    while (parents[index] !== index) index = parents[index]!;
    return index;
  };
  const firstByFile = new Map<string, number>();
  queue.forEach((row, index) => {
    for (const file of row.files) {
      const first = firstByFile.get(file);
      if (first === undefined) firstByFile.set(file, index);
      else parents[root(index)] = root(first);
    }
  });

  const members = new Map<number, number[]>();
  queue.forEach((_, index) => {
    const key = root(index);
    const group = members.get(key) ?? [];
    group.push(index);
    members.set(key, group);
  });
  const result: T[] = [];
  const emitted = new Set<number>();
  queue.forEach((_, index) => {
    const key = root(index);
    if (emitted.has(key)) return;
    emitted.add(key);
    const group = members.get(key)!;
    group.sort((left, right) => {
      const a = queue[left]!;
      const b = queue[right]!;
      return Number(b.priority === 'S1') - Number(a.priority === 'S1')
        || b.radius - a.radius || left - right;
    });
    result.push(...group.map(member => queue[member]!));
  });
  return result;
}
