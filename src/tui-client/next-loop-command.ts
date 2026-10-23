import { createLoopScheduler, type LoopScheduler } from '../dashboard/loop-scheduler.js';
import type { InternalTurnGate } from '../dashboard/input/internal-turn.js';

export interface NextLoopCommand {
  run(raw: string): string[];
  dispose(): void;
}

export interface NextLoopCommandOptions {
  schedule?: (callback: () => void, intervalMs: number) => { unsubscribe(): void };
}

function parseInterval(raw: string): { intervalMs: number; label: string } | null {
  const match = /^(\d+)(s|sec|초|m|min|분|h|시간)?$/i.exec(raw.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = (match[2] ?? 'm').toLowerCase();
  const intervalMs = unit === 's' || unit === 'sec' || unit === '초' ? amount * 1_000
    : unit === 'h' || unit === '시간' ? amount * 3_600_000
    : amount * 60_000;
  // Node/Bun timers clamp delays above 2^31-1ms and can then fire almost immediately.
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 2_147_483_647) return null;
  const label = unit === 's' || unit === 'sec' || unit === '초' ? `${amount}초`
    : unit === 'h' || unit === '시간' ? `${amount}시간`
    : `${amount}분`;
  return { intervalMs, label };
}

/** Next TUI's `/loop` surface; H2 decides whether each scheduled turn may open. */
export function createNextLoopCommand(
  gate: InternalTurnGate,
  log: (event: 'fired' | 'rejected', data: Record<string, unknown>) => void,
  options: NextLoopCommandOptions = {},
): NextLoopCommand {
  let scheduler: LoopScheduler | null = null;
  const stop = (): boolean => {
    if (!scheduler?.isRunning()) return false;
    scheduler.stop();
    scheduler = null;
    return true;
  };
  return {
    run(raw) {
      const [interval = '', ...promptParts] = raw.trim().split(/\s+/);
      const sub = interval.toLowerCase();
      if (!interval || sub === 'help') {
        return ['usage: /loop <간격> <프롬프트> · /loop stop', '간격: 30s · 5m · 1h · 맨숫자=분 — TUI가 쉴 때 프롬프트를 발사합니다'];
      }
      if (sub === 'stop') return [stop() ? '⏹ /loop 정지 — 더 이상 발사하지 않습니다' : '/loop: 실행 중인 루프가 없습니다'];
      const parsed = parseInterval(interval);
      const prompt = promptParts.join(' ').trim();
      if (!parsed || !prompt) return ['사용법: /loop <간격> <프롬프트> · /loop stop'];
      stop();
      scheduler = createLoopScheduler({
        intervalMs: parsed.intervalMs,
        isIdle: () => true,
        ...(options.schedule ? { schedule: options.schedule } : {}),
        fire: () => {
          const result = gate.startTurnIfIdle(prompt, { origin: 'scheduled', reason: '/loop' });
          if (result.opened) log('fired', { turnId: result.turnId });
          else log('rejected', { reason: result.reason });
        },
      });
      scheduler.start();
      return [`↻ /loop 시작 — ${parsed.label}마다: ${prompt}`];
    },
    dispose: stop,
  };
}
