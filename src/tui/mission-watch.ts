export interface MissionWatchSnapshot {
  message: string;
  outcome: 'pending' | 'complete' | 'error';
}

export function startMissionWatch(options: {
  poll: () => Promise<MissionWatchSnapshot>;
  onUpdate(message: string): void;
  onComplete(isActive: () => boolean): Promise<void>;
  onError(message: string): void;
  intervalMs?: number;
}): { cancel(): void; done: Promise<void> } {
  let active = true;
  const done = (async () => {
    let previous = '';
    while (active) {
      let snapshot: MissionWatchSnapshot;
      try { snapshot = await options.poll(); }
      catch (error) {
        if (active) options.onError(error instanceof Error ? error.message : String(error));
        return;
      }
      if (!active) return;
      if (snapshot.message !== previous) {
        options.onUpdate(snapshot.message);
        previous = snapshot.message;
      }
      if (snapshot.outcome === 'error') {
        options.onError(snapshot.message);
        return;
      }
      if (snapshot.outcome === 'complete') {
        try { await options.onComplete(() => active); }
        catch (error) { if (active) options.onError(error instanceof Error ? error.message : String(error)); }
        return;
      }
      await Bun.sleep(options.intervalMs ?? 1_200);
    }
  })();
  return { cancel: () => { active = false; }, done };
}
