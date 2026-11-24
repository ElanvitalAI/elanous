import type { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDocsIndex, defaultDocsSystemRoots, docsFind, DOCS_FIND_TOP_N, type DocsFindHit } from '../knowledge/docs-system-map.js';
import { hybridQueryKnowledge, knowledgeDbPath, openKnowledgeDb } from '../domains/knowledge.js';

export function registerSelfDocsFindCommand(selfCmd: Command): void {
  selfCmd.command('find <query>')
    .description('내부 문서 지도에서 current 상위 5개 찾기 — 필요 절만 읽기')
    .option('--audience <audience>', 'internal 또는 public 결과만')
    .option('--json', '구조화 결과')
    .action(async (query: string, options: { audience?: string; json?: boolean }) => {
      const roots = defaultDocsSystemRoots();
      const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
      const packagedIndex = resolve(root, 'docs-index.jsonl');
      let entries;
      if (existsSync(packagedIndex)) {
        entries = readFileSync(packagedIndex, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      } else {
        entries = buildDocsIndex({ roots });
      }
      const audience = options.audience === 'public' || options.audience === 'internal' ? options.audience : undefined;
      let hits = docsFind(entries, query, { audience });
      // Reuse the installed docs search engine (BM25 + vector RRF); deterministic index search is the fail-soft path.
      if (existsSync(knowledgeDbPath())) {
        const db = openKnowledgeDb();
        try {
          const ranked = await hybridQueryKnowledge(db, query, { k: DOCS_FIND_TOP_N * 2, domain: 'elanous', kind: 'docs' });
          const byPath = new Map(entries.map((entry) => [entry.path, entry]));
          const engineHits: DocsFindHit[] = [];
          for (const result of ranked) {
            const source = result.source_ref?.replaceAll('\\', '/');
            if (!source) continue;
            const entry = [...byPath.values()].find((candidate) => source === candidate.path || source.endsWith(`/${candidate.path}`));
            if (!entry || entry.status !== 'current' || (audience && entry.audience !== audience) || engineHits.some((hit) => hit.entry.path === entry.path)) continue;
            engineHits.push({ entry, badge: entry.audience === 'public' ? '[공개]' : '[내부]', score: result.rrf, section: result.text.split(/\r?\n/).find((line) => line.trim().startsWith('#'))?.replace(/^#+\s*/, '') ?? null });
          }
          if (engineHits.length) {
            const enginePaths = new Set(engineHits.map((hit) => hit.entry.path));
            hits = [...engineHits, ...hits.filter((hit) => !enginePaths.has(hit.entry.path))].slice(0, DOCS_FIND_TOP_N);
          }
        } finally { db.close(); }
      }
      if (options.json) console.log(JSON.stringify(hits, null, 2));
      else if (hits.length === 0) console.log('(매치 없음)');
      else for (const hit of hits) console.log(`${hit.badge} ${hit.entry.layer} ${hit.entry.title} — ${hit.section ?? hit.entry.oneLine} (${hit.entry.path})`);
    });
}
