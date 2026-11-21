import { clampFontSize } from '../../lib/term-focus';

type Point = { clientX: number; clientY: number };
type Points = ArrayLike<Point>;

function distance(points: Points): number {
  return Math.hypot(points[0].clientX - points[1].clientX, points[0].clientY - points[1].clientY);
}

/** Ignore jitter and apply at most one font-size step per gesture. */
export function createPinchZoom() {
  let initial: { distance: number; size: number; result: number | null } | null = null;
  return {
    start(points: Points, size: number): boolean {
      const d = points.length === 2 ? distance(points) : 0;
      initial = Number.isFinite(d) && d > 0 ? { distance: d, size, result: null } : null;
      return initial !== null;
    },
    move(points: Points): number | null {
      if (!initial || points.length !== 2) { initial = null; return null; }
      if (initial.result !== null) return null;
      const d = distance(points);
      if (!Number.isFinite(d)) return null;
      const ratio = d / initial.distance;
      if (ratio > 0.9 && ratio < 1.1) return null;
      initial.result = clampFontSize(initial.size + (ratio >= 1.1 ? 1 : -1));
      return initial.result;
    },
    cancel(): void { initial = null; },
  };
}

/** Track contacts that started in this host, including its descendants. */
export function createPaneTouches() {
  const owned = new Set<number>();
  return (event: TouchEvent): Touch[] => {
    // Synthetic legacy events may omit changedTouches; browsers always supply it.
    if (!event.changedTouches) return Array.from(event.touches);
    if (event.type === 'touchstart') {
      for (const touch of Array.from(event.changedTouches)) owned.add(touch.identifier);
    } else if (event.type === 'touchend' || event.type === 'touchcancel') {
      for (const touch of Array.from(event.changedTouches)) owned.delete(touch.identifier);
    }
    const active = Array.from(event.touches).filter((touch) => owned.has(touch.identifier));
    const activeIds = new Set(active.map((touch) => touch.identifier));
    for (const id of owned) if (!activeIds.has(id)) owned.delete(id);
    return active;
  };
}
