import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('real origin build reports flow through federation into per-host older-seat counts', () => {
  const home = mkdtempSync(join(tmpdir(), 'els-origin-count-'));
  try {
    const repo = join(home, 'elanous-hq', 'repo.git');
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { encoding: 'utf8', env: { ...process.env, HOME: home, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' } });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    mkdirSync(join(home, 'elanous-hq'), { recursive: true });
    git('init', '--bare', repo);
    const tree = git('--git-dir', repo, 'mktree');
    const old = git('--git-dir', repo, 'commit-tree', tree, '-m', 'old');
    const desired = git('--git-dir', repo, 'commit-tree', tree, '-p', old, '-m', 'new');
    const rail = join(home, 'elanous-hq', 'seat-state', 'OP', 'rail');
    mkdirSync(rail, { recursive: true });
    writeFileSync(join(rail, 'DESIRED.json'), JSON.stringify({ sha: desired }));
    const script = join(home, 'origin-fixture.ts');
    writeFileSync(script, `
import assert from 'node:assert/strict';
import { createElsCore } from ${JSON.stringify(join(import.meta.dir, 'core.ts'))};
import { emptyJournal } from ${JSON.stringify(join(import.meta.dir, 'space.ts'))};
import { routeElsHttp } from ${JSON.stringify(join(import.meta.dir, 'http.ts'))};
import { createFederation } from ${JSON.stringify(join(import.meta.dir, 'federation.ts'))};
import { updatePreview } from ${JSON.stringify(join(import.meta.dir, 'update-all.ts'))};
const old = ${JSON.stringify(old)}, desired = ${JSON.stringify(desired)};
function owner(seats) {
  let journal = emptyJournal(), n = 0;
  const core = createElsCore({ load: () => journal, save: j => { journal = j; },
    spawn: () => ({ id: 'pty' + ++n, pid: 100 + n, isAlive: () => true, write() {}, kill() {}, renderScreen: async () => '', onExit() {} }), mailBadges: () => new Map() });
  core.start(); const fg = new Map();
  for (const [seat, kind] of seats) { const p = JSON.parse(core.newPane({ ws: 'W', cwd: '/test/seats/' + seat, command: ['sh'] }).message); fg.set(p.pane, { kind, command: [kind], pid: 101 }); core.reportBuild(p.pane, old); }
  core.setForegrounds(fg); return core;
}
const local = owner([['TC','eln'], ['TC','eln']]);
const remote = owner([['TC','eln'], ['UX','codex']]);
try {
  const fed = createFederation({ localHost: 'mshq', askLocal: async () => local.list(), registry: { hosts: [{ name: 'node-b', baseUrl: 'http://127.0.0.1:1' }], rejected: [] },
    fetchJson: async () => { const r = await routeElsHttp(remote, 'node-b', 'GET', '/els/ls'); return { status: r.status, body: JSON.parse(r.body) }; } });
  let listing;
  for (let n=0; n<100; n++) { listing = JSON.parse((await fed.list()).message); if (listing.panes.every(p => p.build.age === 'older')) break; await new Promise(r => setTimeout(r, 25)); }
  assert.deepEqual(listing.panes.map(p => [p.host,p.seat,p.kind,p.build.age]), [['mshq','TC','eln','older'],['mshq','TC','eln','older'],['node-b','TC','eln','older'],['node-b','UX','codex','older']]);
  assert.equal(updatePreview(listing, '0.3.33', desired, desired), 'This Mac already has 0.3.33 (' + desired.slice(0,8) + '). 2 seats are still on an older build (this Mac 1 · node-b 1). Each switches to the new build when its current turn ends. Continue? [y/N] ');
  console.log('origin-to-federated-preview: local=1 remote=1 duplicates=deduped codex=excluded');
} finally { local.stopAll(); remote.stopAll(); }
`);
    const run = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 15000, env: { ...process.env, HOME: home } });
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' });
    expect(run.stdout.trim()).toBe('origin-to-federated-preview: local=1 remote=1 duplicates=deduped codex=excluded');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
