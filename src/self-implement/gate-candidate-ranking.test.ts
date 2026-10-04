import { describe, expect, test } from 'bun:test';
import { rankGateCallerCandidates, type GateCallerCandidate } from './gate-candidate-ranking.js';

const candidate = (file: string, reasons: GateCallerCandidate['reasons'] = ['import']): GateCallerCandidate => ({ file, reasons });

describe('rankGateCallerCandidates', () => {
  test('touched test first, direct importers next, then two-hop importers, regardless of incoming order', () => {
    const touched = candidate('test/z.test.ts');
    const direct = candidate('test/y.test.ts');
    const distant = candidate('test/a.test.ts');
    const candidates = [distant, direct, touched];
    const importers = new Map([
      ['src/changed.ts', ['test/y.test.ts', 'src/consumer.ts']],
      ['src/consumer.ts', ['test/a.test.ts']],
    ]);

    expect(rankGateCallerCandidates(['src/changed.ts', touched.file], candidates, importers))
      .toEqual([touched, direct, distant]);
    expect(candidates).toEqual([distant, direct, touched]);
  });

  test('shortest distance across changed paths wins; cycles cannot promote a longer route', () => {
    const near = candidate('test/near.test.ts');
    const far = candidate('test/far.test.ts');
    const index = new Map([
      ['src/first.ts', ['src/bridge.ts']],
      ['src/bridge.ts', ['src/first.ts', 'test/near.test.ts', 'test/far.test.ts']],
      ['src/second.ts', ['test/near.test.ts']],
    ]);

    expect(rankGateCallerCandidates(['src/first.ts', 'src/second.ts'], [far, near], index))
      .toEqual([near, far]);
  });

  test('equal distances use numeric-aware path order, including candidates absent from the index', () => {
    const candidates = [candidate('test/other10.test.ts'), candidate('test/near10.test.ts'), candidate('test/other2.test.ts'), candidate('test/near2.test.ts')];
    const index = new Map([['src/changed.ts', ['test/near10.test.ts', 'test/near2.test.ts']]]);

    expect(rankGateCallerCandidates(['src/changed.ts'], candidates, index).map(({ file }) => file))
      .toEqual(['test/near2.test.ts', 'test/near10.test.ts', 'test/other2.test.ts', 'test/other10.test.ts']);
  });

  test('a route consumer named on a changed line ranks with touched tests, ahead of direct importers (GATE-CALLERS2)', () => {
    const importer = candidate('src/nexus/api/a.test.ts');
    const routeConsumer = candidate('test/z-route.test.ts', ['route']);
    const both = candidate('test/y.test.ts', ['import', 'route']);
    const index = new Map([['src/nexus/api/server.ts', ['src/nexus/api/a.test.ts', 'test/y.test.ts']]]);
    const ranked = rankGateCallerCandidates(['src/nexus/api/server.ts'], [importer, routeConsumer, both], index);

    expect(ranked).toEqual([both, routeConsumer, importer]);
    expect(routeConsumer.reasons).toEqual(['route']);
  });

  test('equal distances prefer the test nearest a changed file in the directory tree', () => {
    const far = candidate('apps/pwa/a.test.ts');
    const sibling = candidate('src/debug/z.test.ts');
    const cousin = candidate('src/agent/b.test.ts');
    const index = new Map([['src/debug/log.ts', [far.file, sibling.file, cousin.file]]]);

    expect(rankGateCallerCandidates(['src/debug/log.ts'], [far, cousin, sibling], index)).toEqual([sibling, cousin, far]);
  });
});
