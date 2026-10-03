import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const repo = process.cwd();

function probe(): { refs: string[]; listing: string; liveRef: boolean; epermRef: boolean; tombstone: boolean; reapedTombstone: boolean; reapedClosedAt: number; rejected: string[]; silent: string; toctou: string; liveSilentReap: string } {
  const state = mkdtempSync(join(tmpdir(), 'elanous-pty-list-liveness-'));
  const script = `
    import { Database } from 'bun:sqlite';
    import { getPtyManifest, listPtyManifestByRun, markPtyManifestClosed, ptyManifestDbPath, upsertPtyManifest } from ${JSON.stringify(`${repo}/src/pty-shell/pty-manifest.ts`)};
    import { readLivePtyAddressBook, runPtyKey, runPtyList, runPtyResize, runPtyText } from ${JSON.stringify(`${repo}/src/cli/pty-takeover-cli.ts`)};
    const now = Date.now();
    const liveOwner = Bun.spawn(['sleep', '5']);
    upsertPtyManifest({ id: 'dead-owner', kind: 'tui', cmd: 'elanous', startedAt: now, now });
    upsertPtyManifest({ id: 'live-owner', kind: 'tui', cmd: 'elanous', startedAt: now, now });
    upsertPtyManifest({ id: 'eperm-owner', kind: 'tui', cmd: 'elanous', startedAt: now, now });
    upsertPtyManifest({ id: 'closed-run', kind: 'tui', cmd: 'elanous', startedAt: now, now });
    markPtyManifestClosed('closed-run', 0, now);
    const db = new Database(ptyManifestDbPath());
    db.run('UPDATE pty_manifest SET owner_pid=?, run_id=? WHERE id=?', [99999999, 'dead-run', 'dead-owner']);
    db.run('UPDATE pty_manifest SET owner_pid=? WHERE id=?', [liveOwner.pid, 'live-owner']);
    db.run('UPDATE pty_manifest SET owner_pid=? WHERE id=?', [88888888, 'eperm-owner']);
    db.run('UPDATE pty_manifest SET owner_pid=?, run_id=? WHERE id=?', [99999999, 'closed-run-id', 'closed-run']);
    db.close();
    const originalKill = process.kill;
    let toctouOwnerDead = false;
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 88888888) throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
      if (pid === 77777777) { if (toctouOwnerDead) throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); return true; }
      return originalKill(pid, signal);
    }) as typeof process.kill;
    const listingBook = readLivePtyAddressBook();
    const listing = runPtyList().message;
    const refs = listingBook.refs.map((ref) => ref.id);
    const seedDeadOwner = (id: string) => {
      upsertPtyManifest({ id, kind: 'tui', cmd: 'elanous', startedAt: now, now });
      const seedDb = new Database(ptyManifestDbPath());
      seedDb.run('UPDATE pty_manifest SET owner_pid=? WHERE id=?', [99999999, id]);
      seedDb.close();
    };
    const commandDeps = {
      getPty: () => undefined,
      requestPtyTakeover: () => false,
      requestRemote: async () => ({ status: 'owner-unreachable' as const }),
      readAddressBook: readLivePtyAddressBook,
      log() {},
    };
    seedDeadOwner('dead-text');
    const deadText = await runPtyText('dead-text', 'x', false, commandDeps);
    seedDeadOwner('dead-key');
    const deadKey = await runPtyKey('dead-key', 'enter', 1, commandDeps);
    seedDeadOwner('dead-resize');
    const deadResize = await runPtyResize('dead-resize', 80, 24, commandDeps);
    // ⭐ TOCTOU — owner 는 ref 해석 시점엔 살아 있고(pid 77777777·toctouOwnerDead=false) 요청 도중 죽는다.
    //   해석은 통과 → requestRemote 가 owner-unreachable 반환 → mapResult 가 재-reap → dead-owner 메시지.
    const seedToctou = (id: string) => {
      upsertPtyManifest({ id, kind: 'tui', cmd: 'elanous', startedAt: now, now });
      const seedDb = new Database(ptyManifestDbPath());
      seedDb.run('UPDATE pty_manifest SET owner_pid=? WHERE id=?', [77777777, id]);
      seedDb.close();
    };
    const toctouDeps = {
      getPty: () => undefined,
      requestPtyTakeover: () => false,
      requestRemote: async () => { toctouOwnerDead = true; return { status: 'owner-unreachable' as const }; },
      readAddressBook: readLivePtyAddressBook,
      log() {},
    };
    seedToctou('toctou-owner');
    const toctou = (await runPtyText('toctou-owner', 'x', false, toctouDeps)).message;
    // ⭐ 대조 — owner 가 요청 내내 살아 있으면(toctouOwnerDead 리셋) 재-reap 이 false-positive 안 내고 unreachable 유지.
    toctouOwnerDead = false;
    const liveReapDeps = {
      getPty: () => undefined,
      requestPtyTakeover: () => false,
      requestRemote: async () => ({ status: 'owner-unreachable' as const }),
      readAddressBook: readLivePtyAddressBook,
      log() {},
    };
    seedToctou('live-reap-owner');
    const liveSilentReap = (await runPtyText('live-reap-owner', 'x', false, liveReapDeps)).message;
    process.kill = originalKill;
    liveOwner.kill();
    const silentDeps = {
      getPty: () => undefined,
      requestPtyTakeover: () => false,
      requestRemote: async () => ({ status: 'owner-unreachable' as const }),
      listRefs: () => [{ id: 'live-owner', kind: 'tui', source: 'remote' as const, alive: true }],
      log() {},
    };
    const silent = await runPtyText('live-owner', 'x', false, silentDeps);
    const rejected = [deadText, deadKey, deadResize];
    console.log(JSON.stringify({
      refs,
      listing,
      liveRef: refs.includes('live-owner'),
      epermRef: refs.includes('eperm-owner'),
      tombstone: listPtyManifestByRun('closed-run-id').some((row) => row.id === 'closed-run' && !row.alive),
      // ⚠️ The row that REAPING touched, not one closed beforehand. The
      // previous assertion only watched \`closed-run\`, which reaping never
      // sees, so a reaper that DELETEs instead of tombstoning passed — and
      // it did delete, destroying the post-hoc join this field exists to
      // protect. A guard must observe the path it guards.
      reapedTombstone: listPtyManifestByRun('dead-run').some((row) => row.id === 'dead-owner' && !row.alive),
      // ⚠️ \`alive=false\` alone is not the tombstone contract. A reaper that
      // lays the row down but leaves \`closed_at\` at 0 produces a row that
      // reads as "closed at the epoch", and the grace-TTL purge then treats
      // it as ancient and removes it on the next sweep — the same data loss
      // by a slower route. Assert the stamp, not just the flag.
      reapedClosedAt: listPtyManifestByRun('dead-run').find((row) => row.id === 'dead-owner')?.closedAt ?? 0,
      rejected: rejected.map((result) => result.message),
      silent: silent.message,
      toctou,
      liveSilentReap,
    }));
  `;
  try {
    const result = Bun.spawnSync(['bun', '--eval', script], { cwd: repo, env: { ...process.env, ELANOUS_STATE_DIR: state } });
    expect(result.exitCode).toBe(0);
    return JSON.parse(new TextDecoder().decode(result.stdout));
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
}

describe('elanous pty list liveness', () => {
  test('reaps dead owners before listing, retains live owners and closed tombstones, and refuses the hidden ref', () => {
    const result = probe();
    expect(result.refs).not.toContain('dead-owner');
    expect(result.listing).not.toContain('dead-owner');
    expect(result.liveRef).toBe(true);
    expect(result.epermRef).toBe(true);
    expect(result.tombstone).toBe(true);
    // reap must lay the row down, not remove it: \`elanous self run <runId>\` still joins it.
    expect(result.reapedTombstone).toBe(true);
    // closed_at must be stamped, or the grace-TTL purge reads the row as ancient.
    expect(result.reapedClosedAt).toBeGreaterThan(0);
    expect(result.rejected).toHaveLength(3);
    for (const message of result.rejected) expect(message).toContain('has exited');
    expect(result.silent).toContain('owner for live-owner is unreachable');
    for (const message of result.rejected) expect(message).not.toBe(result.silent);
    // TOCTOU: owner alive at resolve, dies during the request → mapResult re-reaps → dead-owner message.
    expect(result.toctou).toContain('owner for toctou-owner has exited');
    expect(result.toctou).not.toContain('is unreachable');
    // Re-reap must not false-positive: owner alive throughout → unreachable, never "has exited".
    expect(result.liveSilentReap).toContain('owner for live-reap-owner is unreachable');
    expect(result.liveSilentReap).not.toContain('has exited');
  });
});
