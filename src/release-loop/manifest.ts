import type { ReleaseNoteFragment } from './release-note.js';

export interface ReleaseLanding {
  sha: string;
  title: string;
  prNumber?: number;
  changedFiles: string[];
  goalPath?: string;
  releaseTarget?: 'next' | 'later';
}

export interface ReleaseManifestInput {
  version: string;
  baseline: { ref: string; sha: string };
  cutoff: { sha: string };
  landings: ReleaseLanding[];
  notes?: Map<number, ReleaseNoteFragment>;
  runningGoalPaths: string[];
  publicCommandsBefore: string[];
  publicCommandsAfter: string[];
}

export interface ReleaseManifest {
  version: string;
  baseline: ReleaseManifestInput['baseline'];
  cutoff: ReleaseManifestInput['cutoff'];
  in: Array<{ sha: string; title: string; prNumber?: number; docs: 'present' | 'missing' | 'n/a'; line?: string; kind?: ReleaseNoteFragment['kind'] | 'unknown'; note?: 'missing' }>;
  deferred: Array<{ sha: string; reason: 'release-target-later' | 'run-in-flight' }>;
  escalate: Array<{ kind: 'command-removed'; command: string }>;
}

/** Classify the already-observed landings without reading git, run ledgers or the filesystem. */
export function buildReleaseManifest(input: ReleaseManifestInput): ReleaseManifest {
  const running = new Set(input.runningGoalPaths);
  const after = new Set(input.publicCommandsAfter);
  const result: ReleaseManifest = {
    version: input.version,
    baseline: { ...input.baseline },
    cutoff: { ...input.cutoff },
    in: [],
    deferred: [],
    escalate: [],
  };
  for (const landing of input.landings) {
    const fragment = landing.prNumber === undefined ? undefined : input.notes?.get(landing.prNumber);
    if (landing.goalPath && running.has(landing.goalPath)) {
      result.deferred.push({ sha: landing.sha, reason: 'run-in-flight' });
    // ⭐ 줄이 없으면 IN — 명시 `release-target: later` 만 미룬다(METHOD v115 ④ · 흡수 골은 머리에 later 를 «명시»한다).
    } else if (fragment?.target === 'later' || (!fragment && landing.releaseTarget === 'later')) {
      result.deferred.push({ sha: landing.sha, reason: 'release-target-later' });
    } else {
      const docs = fragment ? ('path' in fragment.docs ? 'present' : 'n/a')
        : landing.changedFiles.some((file) => file.startsWith('release/public/docs/')) ? 'present'
        : landing.changedFiles.some((file) => file.startsWith('src/cli/') || file === 'src/index.ts') ? 'missing'
        : 'n/a';
      result.in.push({ sha: landing.sha, title: landing.title, ...(landing.prNumber === undefined ? {} : { prNumber: landing.prNumber }), docs,
        ...(fragment ? { line: fragment.line, kind: fragment.kind } : input.notes ? { line: landing.title, kind: 'unknown', note: 'missing' as const } : {}),
      });
    }
  }
  for (const command of input.publicCommandsBefore) {
    if (!after.has(command)) result.escalate.push({ kind: 'command-removed', command });
  }
  return result;
}
