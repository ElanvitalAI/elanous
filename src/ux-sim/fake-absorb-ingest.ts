import type { AbsorbExtraction } from '../intake-plane/absorb-extract.js';

/** Deterministic simulation devices for the seven ABSORB ingest inputs. */
export type AbsorbKind = 'text' | 'web' | 'x' | 'youtube' | 'voice' | 'video' | 'photo';

export interface FakeScrapInput {
  id: string;
  memberId: string;
  kind: AbsorbKind;
  source: 'android-share' | 'android-record' | 'tui' | 'pwa' | 'telegram';
  raw: { text?: string; url?: string; mediaRef?: string; mime?: string };
}

export const FAKE_ABSORB_SCRAPS: readonly FakeScrapInput[] = [
  { id: 'scrap-text', memberId: 'member-a', kind: 'text', source: 'tui', raw: { text: 'Design a local-first lecture notebook' } },
  { id: 'scrap-web', memberId: 'member-a', kind: 'web', source: 'android-share', raw: { url: 'https://example.test/article' } },
  { id: 'scrap-x', memberId: 'member-a', kind: 'x', source: 'telegram', raw: { url: 'https://x.com/example/status/1' } },
  { id: 'scrap-youtube', memberId: 'member-a', kind: 'youtube', source: 'pwa', raw: { url: 'https://youtube.com/watch?v=fixture' } },
  { id: 'scrap-voice', memberId: 'member-a', kind: 'voice', source: 'android-record', raw: { mediaRef: 'scraps/voice-1', mime: 'audio/wav' } },
  { id: 'scrap-video', memberId: 'member-a', kind: 'video', source: 'android-share', raw: { mediaRef: 'scraps/video-1', mime: 'video/mp4' } },
  { id: 'scrap-photo', memberId: 'member-a', kind: 'photo', source: 'android-share', raw: { mediaRef: 'scraps/photo-1', mime: 'image/jpeg' } },
  { id: 'scrap-owner-b', memberId: 'member-b', kind: 'text', source: 'tui', raw: { text: 'private to member b' } },
];

export class FakeScrapInbox {
  readonly records = new Map<string, FakeScrapInput>();

  create(input: FakeScrapInput): FakeScrapInput {
    const existing = this.records.get(input.id);
    if (existing) return existing;
    this.records.set(input.id, structuredClone(input));
    return structuredClone(input);
  }

  list(memberId: string): FakeScrapInput[] {
    return [...this.records.values()].filter((record) => record.memberId === memberId).map((record) => structuredClone(record));
  }
}

export interface FakeExtractors {
  extract(input: FakeScrapInput): Promise<AbsorbExtraction>;
}

export function createFakeExtractors(options: { failKind?: AbsorbKind } = {}): FakeExtractors {
  return {
    async extract(input) {
      if (input.kind === options.failKind) throw new Error(`simulated ${input.kind} extractor failure`);
      if (input.kind === 'text') {
        const text = input.raw.text?.trim() ?? '';
        return { title: text.slice(0, 80) || 'Untitled note', body: text };
      }
      const labels: Record<Exclude<AbsorbKind, 'text'>, string> = {
        web: 'Web article', x: 'X post', youtube: 'YouTube transcript', voice: 'Voice transcript',
        video: 'Video transcript', photo: 'Photo OCR',
      };
      return { title: labels[input.kind], body: `fixture extraction for ${input.kind}`, ...(input.raw.url ? { originUrl: input.raw.url } : {}) };
    },
  };
}


/** Scene 2 fixture: real catalog-owned world and runGraph; business/API adapters remain fake. */
export async function runScene2PwaWorld(options: { root: string; runId: string; failExtraction?: boolean }) {
  const { mkdirSync, writeFileSync, appendFileSync } = await import('node:fs');
  const { join, resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { getTestStateRoot, setTestStateRoot } = await import('../nexus/paths.js');
  const { createSimWorld } = await import('./world-store.js');
  const { runGraph } = await import('../graph-runner/runner.js');
  const prior = getTestStateRoot();
  const root = resolve(options.root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  setTestStateRoot(root);
  try {
    // No catalogForTesting override: a stale current snapshot must fail before any graph work.
    const world = createSimWorld('demo1114-s2-pwa');
    const inbox = new FakeScrapInbox();
    const extractor = createFakeExtractors(options.failExtraction ? { failKind: 'web' } : {});
    const memberId = 'scene2-member';
    const scrapId = `${options.runId}:scrap`;
    const briefingId = `${options.runId}:briefing`;
    const events: Array<{ runId: string; event: string; scrapId: string; briefingId?: string; message?: string }> = [];
    const briefings: Array<{ id: string; memberId: string; day: string; runId: string; topics: Array<{ title: string; summary: string; scrapIds: string[] }> }> = [];
    let extraction: import('../intake-plane/absorb-extract.js').AbsorbExtraction | undefined;
    const emit = (event: string, extra: { briefingId?: string; message?: string } = {}) => {
      const row = { runId: options.runId, event, scrapId, ...extra };
      events.push(row);
      appendFileSync(join(world.stateDir, 'scene2-events.jsonl'), JSON.stringify(row) + '\n');
      return row;
    };
    writeFileSync(join(world.fixturesDir, 'recipes.yaml'), ['scrap', 'extract', 'brief'].map(stage => `${stage}:\n  command: "fixture:${stage}"`).join('\n'));
    // Keep recipes beside the graph in this owned world; never write into the source checkout.
    const sourceGraph = resolve(dirname(fileURLToPath(import.meta.url)), '../../scenarios/ux-sim/demo1114-s2-pwa-graph.yaml');
    const { copyFileSync } = await import('node:fs');
    const graph = join(world.fixturesDir, 'graph.yaml');
    copyFileSync(sourceGraph, graph);
    emit('utterance');
    const result = await runGraph(graph, { runId: options.runId, input: { fixtureOnly: true, memberId }, deps: {
      root: world.stateDir,
      runBash: async command => {
        const stage = command.trim().replace(/^fixture:/, '');
        try {
          if (stage === 'scrap') inbox.create({ id: scrapId, memberId, kind: 'web', source: 'pwa', raw: { url: 'https://example.invalid/scene2' } });
          else if (stage === 'extract') {
            const scrap = inbox.list(memberId).find(row => row.id === scrapId);
            if (!scrap) throw new Error('scrap missing');
            extraction = await extractor.extract(scrap);
          } else if (stage === 'brief') {
            if (!extraction) throw new Error('extraction missing; briefing forbidden');
            // Explicit fake API shape, not a bridge to the production member briefing store.
            briefings.push({ id: briefingId, memberId, day: '2026-11-14', runId: options.runId,
              topics: [{ title: extraction.title, summary: extraction.body, scrapIds: [scrapId] }] });
          } else throw new Error(`unknown fixture stage: ${stage}`);
          const row = emit(stage, stage === 'brief' ? { briefingId } : {});
          return { stdout: JSON.stringify({ outcome: 'ok', ...row }), stderr: '', exitCode: 0 };
        } catch (error) {
          const row = emit('extractor-failed', { message: String(error) });
          return { stdout: JSON.stringify({ outcome: 'fail', ...row }), stderr: String(error), exitCode: 1 };
        }
      },
    } });
    const receipt = { worldId: world.id, worldRoot: world.rootDir, runId: options.runId, result, events, briefings,
      boundary: 'catalog-owned fake world; production runGraph; fixture graph/inbox/extraction/API shape; installed LIVE yellow' };
    writeFileSync(join(world.stateDir, 'scene2-receipt.json'), JSON.stringify(receipt, null, 2));
    return receipt;
  } finally { setTestStateRoot(prior ?? null); }
}
