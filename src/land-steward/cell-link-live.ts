// LAND-CELL-LINK-ALWAYS — live ports of the post-merge cell-link sweep (src/land-graph/main-cell-link.ts): gh merged list ·
// the release in play (release.graph.version) · `evidence add` · auto-cell `checklist add` (CELLLESS-PR-AUTO-CELL) · the 판정 집사's done-when · mail as `land-graph`.
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DoneWhen, MergedPr, SweepDeps } from '../land-graph/main-cell-link.js';

interface GhMerged { number: number; title: string; body?: string; headRefName?: string; headRefOid?: string; mergedAt: string; files?: Array<{ path: string }>; author?: { login?: string } }

export function liveSweepDeps(stateRoot: string, o: { dry?: boolean; since?: string } = {}): SweepDeps {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { ghInvocation, resolveLandRepo } = require('../cli/land-graph-cli.js') as typeof import('../cli/land-graph-cli.js');
  const { readBoardPointer } = require('../ops-dashboard/current-version.js') as typeof import('../ops-dashboard/current-version.js');
  const { listChecklist } = require('../release-loop/checklist.js') as typeof import('../release-loop/checklist.js');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const repo = resolveLandRepo({ defaultRoot: join(homedir(), 'elanous-hq', 'repo.git') });
  return {
    now: () => new Date(), stateRoot, ...(o.dry ? { dry: true } : {}), ...(o.since ? { since: o.since } : {}),
    listMerged(since) {
      const inv = ghInvocation(['pr', 'list', '--state', 'merged', '--base', 'main', '--search', `merged:>=${since.slice(0, 19)}Z`, '--limit', '200',
        '--json', 'number,title,body,headRefName,headRefOid,mergedAt,files,author'], repo);
      const r = spawnSync(process.env.LAND_GRAPH_GH ?? 'gh', inv.args, { encoding: 'utf8', timeout: 90_000, maxBuffer: 64 * 1024 * 1024, ...(inv.cwd ? { cwd: inv.cwd } : {}) });
      if (r.status !== 0) throw new Error(`gh pr list exit ${r.status}: ${(r.stderr ?? '').trim().slice(0, 160)}`);
      return (JSON.parse(r.stdout) as GhMerged[]).map((p): MergedPr => ({
        number: p.number, head: p.headRefOid ?? '', base: 'main', draft: false, state: 'MERGED', title: p.title, author: p.author?.login ?? '',
        files: (p.files ?? []).map(f => f.path), body: p.body ?? '', mergedAt: p.mergedAt, ...(p.headRefName ? { headRef: p.headRefName } : {}),
      }));
    },
    checklist() {
      const version = readBoardPointer();
      return version ? { version, items: listChecklist(version).items } : null;
    },
    attach(version, cell, pr) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const features = require('../release-loop/feature-store.js') as typeof import('../release-loop/feature-store.js');
      const snap = listChecklist(version);
      features.evidenceAdd(cell, version, `#${pr}`, 'land-graph', snap.released, snap.dev);
    },
    register(version, input) {
      // CELLLESS-PR-AUTO-CELL — the same addItem path as `eln release checklist add` (validation · cross-release id check),
      // recorded as land-graph.
      const { addItem } = require('../release-loop/checklist.js') as typeof import('../release-loop/checklist.js'); // eslint-disable-line @typescript-eslint/no-require-imports
      const prev = process.env.ELANOUS_TRACK;
      process.env.ELANOUS_TRACK = 'land-graph';
      try { addItem(version, input); } finally { if (prev === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = prev; }
    },
    autoCellPolicy() {
      const { loadAutoCellPolicy } = require('../land-graph/auto-cell.js') as typeof import('../land-graph/auto-cell.js'); // eslint-disable-line @typescript-eslint/no-require-imports
      return loadAutoCellPolicy();
    },
    doneWhen(_version, cell): DoneWhen {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { liveContext } = require('../judge-butler/live.js') as typeof import('../judge-butler/live.js');
      const { judgeCell } = require('../judge-butler/done-when.js') as typeof import('../judge-butler/done-when.js');
      /* eslint-enable @typescript-eslint/no-require-imports */
      const ctx = liveContext();
      try {
        const c = ctx.view.cells.find(x => x.id === cell);
        if (!c) return null;
        const v = judgeCell(c, ctx.view.prFacts);
        return v.kind === 'missing' ? { kind: 'missing', missing: v.missing } : { kind: v.kind };
      } finally { ctx.close(); }
    },
    post(to, body) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { openMsgStore } = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
      const store = openMsgStore();
      try { store.post({ from: 'land-graph', to, kind: 'info', body } as Parameters<typeof store.post>[0]); } finally { store.close(); }
    },
  };
}
