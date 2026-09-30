// PR-S1V.5 (sprint 21-Parallel-Voice · 2026-04-29) — Voice cost tracker
// tests.
//
// Covers:
//   1. recordStt computes USD via VOICE_COSTS table.
//   2. recordTts computes USD via VOICE_COSTS table.
//   3. getMonthSummary filters to the current calendar month so a
//      replay of an old event doesn't inflate "this month" totals.
//   4. JSONL persist + replay — restart sees the same totals.
//   5. Subscribers fire after persist (and only after).

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createVoiceCostTracker,
  defaultVoiceCostEventPath,
  type VoiceCostEvent,
} from '../src/voice/cost-tracker.js';
import { costForStt } from '../src/models/voice-costs.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../src/elanous-config-dir.js';
import { effectiveInstanceRoot } from '../src/instance/resolve.js';
import { voiceCostSegment } from '../src/status/bar.js';

function tmpEventPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'voice-cost-tracker-'));
  const path = join(dir, 'voice-cost-events.jsonl');
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('PR-S1V.5 · voice cost-tracker · recordStt', () => {
  test('USD matches VOICE_COSTS table', () => {
    const { path, cleanup } = tmpEventPath();
    const t = createVoiceCostTracker({ eventPath: path, now: () => 1714521600000 });
    try {
      const ev = t.recordStt({ providerId: 'openai-whisper', durationMs: 30_000 });
      expect(ev.kind).toBe('stt');
      expect(ev.usd).toBe(costForStt({ providerId: 'openai-whisper', durationMs: 30_000 }));
      // 30s · $0.006/min · = $0.003
      expect(ev.usd).toBeCloseTo(0.003, 6);
    } finally {
      cleanup();
    }
  });

  test('elevenlabs-scribe computes 50% premium over Whisper', () => {
    const { path, cleanup } = tmpEventPath();
    const t = createVoiceCostTracker({ eventPath: path });
    try {
      const ev = t.recordStt({ providerId: 'elevenlabs-scribe', durationMs: 60_000 });
      // 1 min · $0.0125/min · = $0.0125
      expect(ev.usd).toBeCloseTo(0.0125, 6);
    } finally {
      cleanup();
    }
  });
});

describe('PR-S1V.5 · voice cost-tracker · recordTts', () => {
  test('USD matches char count × per-char rate', () => {
    const { path, cleanup } = tmpEventPath();
    const t = createVoiceCostTracker({ eventPath: path });
    try {
      const ev = t.recordTts({ providerId: 'elevenlabs-tts-flash-v2.5', charCount: 1_000_000 });
      expect(ev.kind).toBe('tts');
      expect(ev.usd).toBeCloseTo(20, 4); // $20 per 1M chars
    } finally {
      cleanup();
    }
  });

  test('macos-say has zero cost', () => {
    const { path, cleanup } = tmpEventPath();
    const t = createVoiceCostTracker({ eventPath: path });
    try {
      const ev = t.recordTts({ providerId: 'macos-say', charCount: 5000 });
      expect(ev.usd).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe('PR-S1V.5 · voice cost-tracker · monthly summary', () => {
  test('filters out events outside the current month', () => {
    const { path, cleanup } = tmpEventPath();
    const aprTs = new Date('2026-04-15T12:00:00Z').getTime();
    const mayTs = new Date('2026-05-02T08:00:00Z').getTime();
    let now = aprTs;
    const t = createVoiceCostTracker({ eventPath: path, now: () => now });
    try {
      // April events
      t.recordStt({ providerId: 'openai-whisper', durationMs: 60_000 }); // $0.006
      t.recordStt({ providerId: 'openai-whisper', durationMs: 60_000 }); // $0.006

      // May events
      now = mayTs;
      t.recordStt({ providerId: 'openai-whisper', durationMs: 30_000 }); // $0.003

      const aprView = (() => { now = aprTs; return t.getMonthSummary(); })();
      now = mayTs;
      const mayView = t.getMonthSummary();
      now = aprTs;
      const aprView2 = t.getMonthSummary();

      expect(aprView.monthYYYYMM).toBe('2026-04');
      expect(aprView.totalUsd).toBeCloseTo(0.012, 6);
      expect(aprView.sttDurationSec).toBeCloseTo(120, 6);

      expect(mayView.monthYYYYMM).toBe('2026-05');
      expect(mayView.totalUsd).toBeCloseTo(0.003, 6);
      expect(mayView.sttDurationSec).toBeCloseTo(30, 6);

      expect(aprView2.totalUsd).toBeCloseTo(0.012, 6);
    } finally {
      cleanup();
    }
  });

  test('process summary covers every event regardless of month', () => {
    const { path, cleanup } = tmpEventPath();
    let now = new Date('2026-04-15T12:00:00Z').getTime();
    const t = createVoiceCostTracker({ eventPath: path, now: () => now });
    try {
      t.recordStt({ providerId: 'openai-whisper', durationMs: 60_000 });
      now = new Date('2026-05-02T08:00:00Z').getTime();
      t.recordStt({ providerId: 'openai-whisper', durationMs: 30_000 });
      const all = t.getProcessSummary();
      expect(all.totalUsd).toBeCloseTo(0.009, 6);
      expect(all.sttDurationSec).toBeCloseTo(90, 6);
    } finally {
      cleanup();
    }
  });
});

describe('PR-S1V.5 · voice cost-tracker · JSONL persist + replay', () => {
  test('events persist across instance restarts', () => {
    const { path, cleanup } = tmpEventPath();
    try {
      const now = new Date('2026-04-15T12:00:00Z').getTime();
      const t1 = createVoiceCostTracker({ eventPath: path, now: () => now });
      t1.recordStt({ providerId: 'openai-whisper', durationMs: 60_000, sessionId: 'sess-a' });
      t1.recordTts({ providerId: 'elevenlabs-tts-flash-v2.5', charCount: 500 });

      // Second tracker instance reads the same file — process restart sim.
      const t2 = createVoiceCostTracker({ eventPath: path, now: () => now });
      const sum = t2.getMonthSummary();
      expect(sum.sttUsd).toBeCloseTo(0.006, 6);
      expect(sum.ttsUsd).toBeCloseTo(0.01, 6);
      expect(sum.totalUsd).toBeCloseTo(0.016, 6);
    } finally {
      cleanup();
    }
  });

  test('JSONL is append-only, one event per line', () => {
    const { path, cleanup } = tmpEventPath();
    try {
      const t = createVoiceCostTracker({ eventPath: path });
      t.recordStt({ providerId: 'openai-whisper', durationMs: 1000 });
      t.recordStt({ providerId: 'openai-whisper', durationMs: 2000 });
      const raw = readFileSync(path, 'utf-8').trim().split('\n');
      expect(raw.length).toBe(2);
      const ev0 = JSON.parse(raw[0]!) as VoiceCostEvent;
      const ev1 = JSON.parse(raw[1]!) as VoiceCostEvent;
      expect(ev0.kind).toBe('stt');
      expect(ev1.kind).toBe('stt');
      if (ev0.kind === 'stt' && ev1.kind === 'stt') {
        expect(ev0.durationMs).toBe(1000);
        expect(ev1.durationMs).toBe(2000);
      }
    } finally {
      cleanup();
    }
  });

  test('disablePersist suppresses disk writes', () => {
    const { path, cleanup } = tmpEventPath();
    try {
      const t = createVoiceCostTracker({ eventPath: path, disablePersist: true });
      t.recordStt({ providerId: 'openai-whisper', durationMs: 1000 });
      expect(existsSync(path)).toBe(false);
      // Yet in-memory total is correct.
      expect(t.getProcessSummary().sttUsd).toBeCloseTo(0.0001, 6);
    } finally {
      cleanup();
    }
  });

  test('corrupt JSONL lines are skipped on replay', () => {
    const { path, cleanup } = tmpEventPath();
    try {
      const t1 = createVoiceCostTracker({ eventPath: path });
      t1.recordStt({ providerId: 'openai-whisper', durationMs: 60_000 });
      // Append a corrupt line.
      const fs = require('node:fs') as typeof import('node:fs');
      fs.appendFileSync(path, 'this is not json\n', 'utf-8');
      // Append another valid event.
      const t2 = createVoiceCostTracker({ eventPath: path });
      t2.recordStt({ providerId: 'openai-whisper', durationMs: 60_000 });
      const t3 = createVoiceCostTracker({ eventPath: path });
      // 2 valid events seen, corrupt skipped.
      expect(t3.getProcessSummary().sttDurationSec).toBeCloseTo(120, 6);
    } finally {
      cleanup();
    }
  });
});

describe('PR-S1V.5 · voiceCostSegment renderer', () => {
  test('returns empty when usd is 0 / negative / non-finite', () => {
    expect(voiceCostSegment(0)).toBe('');
    expect(voiceCostSegment(-1)).toBe('');
    expect(voiceCostSegment(Number.NaN)).toBe('');
    expect(voiceCostSegment(Number.POSITIVE_INFINITY)).toBe('');
  });

  test('formats sub-cent values as <$0.01', () => {
    const out = voiceCostSegment(0.0001);
    expect(out).toContain('<$0.01');
    expect(out).toContain('🎙');
    expect(out).toContain('/mo');
  });

  test('formats round dollars with 2 decimals', () => {
    expect(voiceCostSegment(0.42)).toContain('$0.42/mo');
    expect(voiceCostSegment(12.345)).toContain('$12.35/mo'); // rounds half-up via toFixed
  });
});

describe('chore · defaultVoiceCostEventPath honours --config-dir', () => {
  test('defaults to the resolved instance root/voice-cost-events.jsonl', () => {
    resetElanousConfigDir();
    const path = defaultVoiceCostEventPath();
    expect(path).toBe(join(effectiveInstanceRoot(), 'voice-cost-events.jsonl'));
  });

  test('setElanousConfigDir reroutes the path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cost-tracker-cfgdir-'));
    try {
      setElanousConfigDir(dir);
      expect(defaultVoiceCostEventPath()).toBe(join(dir, 'voice-cost-events.jsonl'));
    } finally {
      resetElanousConfigDir();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ELANOUS_DAEMON_DIR env support was removed in PR #2534 (2026-05-13).
  // Use setElanousConfigDir() / --config-dir instead — covered by the
  // 'setElanousConfigDir overrides default' test above.
});

describe('PR-S1V.5 · voice cost-tracker · subscribers', () => {
  test('subscribe fires after each event', () => {
    const { path, cleanup } = tmpEventPath();
    try {
      const t = createVoiceCostTracker({ eventPath: path });
      const events: VoiceCostEvent[] = [];
      const dispose = t.subscribe((ev) => events.push(ev));
      t.recordStt({ providerId: 'openai-whisper', durationMs: 1000 });
      t.recordTts({ providerId: 'macos-say', charCount: 10 });
      expect(events.length).toBe(2);
      expect(events[0]?.kind).toBe('stt');
      expect(events[1]?.kind).toBe('tts');
      dispose();
      t.recordStt({ providerId: 'openai-whisper', durationMs: 1000 });
      expect(events.length).toBe(2); // disposer prevented a third notify
    } finally {
      cleanup();
    }
  });

  test('subscriber that throws does not break other subscribers', () => {
    const { path, cleanup } = tmpEventPath();
    try {
      const t = createVoiceCostTracker({ eventPath: path });
      const seen: string[] = [];
      t.subscribe(() => { throw new Error('boom'); });
      t.subscribe(() => { seen.push('ok'); });
      t.recordStt({ providerId: 'openai-whisper', durationMs: 1000 });
      expect(seen).toEqual(['ok']);
    } finally {
      cleanup();
    }
  });
});
