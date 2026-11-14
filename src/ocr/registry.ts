// OCR provider registry. Holds a name → provider map; pick() walks
// available providers and returns the highest-scoring match for
// caller requirements. Designed for one-time registration at boot
// (production wires Upstage; tests inject fakes).

import type { OcrProvider } from './provider.js';
import type { OcrRequirements } from './types.js';

export interface PickResult {
  provider: OcrProvider;
  /** Score the picker gave this provider against the caller's
   *  requirements. Surfaced for telemetry / debug logs. */
  score: number;
  /** All available providers + their scores, sorted descending.
   *  Useful for "why was this picked?" debugging. */
  ranking: { provider: OcrProvider; score: number }[];
}

export class OcrRegistry {
  private providers = new Map<string, OcrProvider>();

  /** Register a provider. Idempotent — same name overwrites (so
   *  tests can stub). */
  register(p: OcrProvider): void {
    this.providers.set(p.name, p);
  }

  /** Drop a provider by name. Returns true when removed. */
  unregister(name: string): boolean {
    return this.providers.delete(name);
  }

  /** Look up a provider by exact name. Caller is responsible for
   *  checking `isAvailable()` before invoking `run()`. */
  get(name: string): OcrProvider | undefined {
    return this.providers.get(name);
  }

  /** All registered providers (regardless of availability). */
  list(): OcrProvider[] {
    return [...this.providers.values()];
  }

  /** Pick the best AVAILABLE provider for the given requirements.
   *  Returns null when:
   *  - No providers are registered, OR
   *  - All providers' `isAvailable()` returned false, OR
   *  - All providers were excluded by hard filters (cost ceiling /
   *    requireAsync).
   *
   *  Two providers with equal scores break ties by registration
   *  order (insertion order in the underlying Map).
   *
   *  The returned `ranking` covers ALL available providers (not
   *  just the winner) so callers can log a debug summary or fall
   *  back to the runner-up if the winner's `run()` fails at
   *  runtime. */
  async pick(requirements: OcrRequirements = {}): Promise<PickResult | null> {
    const ranking: { provider: OcrProvider; score: number }[] = [];
    for (const p of this.providers.values()) {
      let available: boolean;
      try { available = await p.isAvailable(); }
      catch { continue; } // One failed credential backend must not hide other OCR providers.
      if (!available) continue;
      const score = p.matchScore(requirements);
      if (score === null) continue;  // hard-filtered
      ranking.push({ provider: p, score });
    }
    if (ranking.length === 0) return null;
    ranking.sort((a, b) => b.score - a.score);
    return {
      provider: ranking[0]!.provider,
      score: ranking[0]!.score,
      ranking,
    };
  }
}

/** Module-level default registry. Production callers register
 *  Upstage at boot; tests build their own registry to keep
 *  isolation. */
let defaultRegistry: OcrRegistry | undefined;

export function getDefaultOcrRegistry(): OcrRegistry {
  if (!defaultRegistry) defaultRegistry = new OcrRegistry();
  return defaultRegistry;
}

/** Test seam — replace the module singleton. Tests that don't
 *  want to share the production registry build their own and call
 *  `setDefaultOcrRegistry(testRegistry)` for the duration; pass
 *  `undefined` to restore lazy-init. */
export function setDefaultOcrRegistry(registry: OcrRegistry | undefined): void {
  defaultRegistry = registry;
}
