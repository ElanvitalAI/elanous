import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APPROVE_OPTION, CRITPATH_WAITING_EXIT, approvalRef, approvalState, runCritpath, type ApprovalBinding, type ApprovalRecord, type CritpathDeps, type CritpathLedger, type CritpathOptions, type PreparedRelease } from './critpath.js';

const VERSION = '9.9.9';
const CUT = 'a'.repeat(40);
const OTHER_CUT = 'b'.repeat(40);
const TGZ_SHA1 = 'c'.repeat(40);
const PUBLIC_COMMIT = 'd'.repeat(40);

let root: string;
let notes: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'critpath-test-'));
  notes = join(root, 'notes.md');
  writeFileSync(notes, '# elanous v9.9.9\n\nPublic notes.\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const notesSha = () => createHash('sha256').update(readFileSync(notes)).digest('hex');
const binding = (over: Partial<ApprovalBinding> = {}): ApprovalBinding => ({ version: VERSION, cutSha: CUT, notesSha256: notesSha(), ...over });
const approved = (b: ApprovalBinding): ApprovalRecord => ({ id: 'D-OK', refs: [approvalRef(b)], status: 'decided', choice: APPROVE_OPTION, decidedBy: { kind: 'human' } });

function opts(over: Partial<CritpathOptions> = {}): CritpathOptions {
  return { version: VERSION, notesFile: notes, cutCommit: CUT, out: join(root, 'prepared'), ledgerPath: join(root, 'critpath.json'), ...over };
}

/** Fake world: records every call; nothing touches the network or a real registry. */
function world(state: { prepared?: boolean; release?: boolean; npm?: { visible: boolean; shasum?: string }; records?: ApprovalRecord[]; failAt?: string; npmResult?: { ok: boolean; npm?: string; summary: string };
  /** --branch mode: what origin/release/<v> points to now · the ref/commit an existing prepare recorded · what a fresh prepare checks out. */
  branchHead?: string; prepSourceRef?: string; prepCommit?: string; prepareYields?: string } = {}) {
  const calls: string[] = [];
  const s = { prepared: false, release: false, npm: { visible: false } as { visible: boolean; shasum?: string }, records: [] as ApprovalRecord[], publishedNotes: [] as string[], ...state };
  const prep = (sourceCommit: string): PreparedRelease => ({ dir: join(root, 'prepared'), version: VERSION, tag: `v${VERSION}`, publicRepo: 'Example/elanous', sourceRef: s.prepSourceRef ?? CUT, sourceCommit,
    publicCommit: PUBLIC_COMMIT, tgz: join(root, 'prepared', 'dist', 'elanous.tgz'), tgzSha1: TGZ_SHA1, e2eOk: true, checksumsOk: true });
  const boom = (step: string) => { if (s.failAt === step) throw new Error(`${step} exploded`); };
  const deps: CritpathDeps = {
    readPrepared: () => (s.prepared ? prep(s.prepCommit ?? CUT) : null),
    resolveBranch: () => { calls.push('resolve branch'); return s.branchHead ?? CUT; },
    prepare: async ({ source }) => {
      calls.push('prepare'); boom('prepare'); s.prepared = true;
      s.prepSourceRef = source; s.prepCommit = s.prepareYields ?? s.branchHead ?? CUT;
      return prep(s.prepCommit);
    },
    githubReleaseExists: () => s.release,
    publish: async ({ yes, notesFile }) => { calls.push(yes ? 'publish --yes' : 'publish preview'); s.publishedNotes.push(notesFile); boom('publish'); if (yes) s.release = true; },
    npmRegistry: async () => s.npm,
    npmDryRun: () => { calls.push('npm --dry-run'); return { ok: true, detail: 'ok' }; },
    npmPublish: async () => {
      calls.push('npm publish'); boom('npm');
      const r = s.npmResult ?? { ok: true, npm: 'published', summary: 'npm visible' };
      if (r.ok && r.npm !== 'staged-not-visible') s.npm = { visible: true, shasum: TGZ_SHA1 };
      return r;
    },
    verify: async () => { calls.push('verify'); boom('verify'); return { ok: true, summary: 'verify ok' }; },
    approvalRecords: () => s.records,
    requestApproval: (b) => { calls.push('request approval'); s.records.push({ id: 'D-NEW', refs: [approvalRef(b)], status: 'open' }); return { id: 'D-NEW' }; },
    now: () => new Date('2026-11-19T00:00:00Z'),
    log: () => {},
  };
  return { deps, calls, s };
}

const ledger = (): CritpathLedger => JSON.parse(readFileSync(join(root, 'critpath.json'), 'utf8')) as CritpathLedger;

describe('release critpath', () => {
  test('without an approval record it stops before publish, raises one card and publishes nothing', async () => {
    const w = world();
    const r = await runCritpath(opts(), w.deps);
    expect(r.status).toBe('waiting-approval');
    expect(r.exitCode).toBe(CRITPATH_WAITING_EXIT);
    expect(r.resume).toContain('automatic critpath publication remains disabled');
    expect(w.calls).toEqual(['prepare', 'request approval']);
    expect(ledger().entries.map((e) => `${e.step}:${e.outcome}`)).toEqual(['prepare:ok', 'approval:waiting-approval']);
    expect(ledger().binding).toEqual(binding());
    // A second run while the card is open does not raise another card.
    const again = await runCritpath(opts(), w.deps);
    expect(again.status).toBe('waiting-approval');
    expect(w.calls.filter((c) => c === 'request approval')).toEqual(['request approval']);
  });

  test('a matching human marker remains unverified and cannot run publish or npm', async () => {
    const w = world({ records: [approved(binding())] });
    const r = await runCritpath(opts(), w.deps);
    expect(r.status).toBe('waiting-approval');
    expect(r.exitCode).toBe(CRITPATH_WAITING_EXIT);
    expect(r.approval).toEqual({ state: 'unverified', id: 'D-OK' });
    expect(w.calls).toEqual(['prepare']);
    expect(ledger().entries.map((e) => `${e.step}:${e.outcome}`)).toEqual(['prepare:ok', 'approval:waiting-approval']);
    expect(ledger().entries.every((e) => e.cmd && e.at)).toBe(true);
  });

  test('a record for another cut or another notes body does not count', async () => {
    for (const other of [binding({ cutSha: OTHER_CUT }), binding({ notesSha256: 'e'.repeat(64) })]) {
      rmSync(join(root, 'critpath.json'), { force: true });
      const w = world({ records: [approved(other)] });
      const r = await runCritpath(opts(), w.deps);
      expect(r.status).toBe('waiting-approval');
      expect(w.calls).not.toContain('publish --yes');
      expect(w.calls).not.toContain('npm publish');
    }
  });

  test('an auto or declined decision is not approval', async () => {
    const auto = world({ records: [{ ...approved(binding()), decidedBy: { kind: 'auto' } }] });
    expect(approvalState(auto.s.records, binding()).state).toBe('declined');
    const r = await runCritpath(opts(), auto.deps);
    expect(r.status).toBe('failed');
    expect(r.step).toBe('approval');
    expect(auto.calls).not.toContain('publish --yes');
  });

  test('an unverified marker still blocks a publish failure path', async () => {
    const w = world({ records: [approved(binding())], failAt: 'publish' });
    const r = await runCritpath(opts(), w.deps);
    expect(r.status).toBe('waiting-approval');
    expect(r.step).toBe('approval');
    expect(w.calls).toEqual(['prepare']);
  });

  test('re-entry skips done steps: prepared folder, existing release, same-shasum npm', async () => {
    const w = world({ prepared: true, release: true, npm: { visible: true, shasum: TGZ_SHA1 } });
    const r = await runCritpath(opts(), w.deps);
    expect(r.status).toBe('done');
    expect(w.calls).toEqual(['verify']);
    expect(ledger().entries.map((e) => `${e.step}:${e.outcome}`)).toEqual(['prepare:skipped', 'publish:skipped', 'npm:skipped', 'verify:ok']);
    const again = await runCritpath(opts(), w.deps);
    expect(again.status).toBe('done');
    expect(w.calls).toEqual(['verify']);
  });

  test('npm with a different shasum is never republished', async () => {
    const w = world({ prepared: true, release: true, npm: { visible: true, shasum: 'f'.repeat(40) }, records: [approved(binding())] });
    const r = await runCritpath(opts(), w.deps);
    expect(r.status).toBe('failed');
    expect(r.step).toBe('npm');
    expect(w.calls).toEqual([]);
  });

  test('npm E409 recovery still waits for approval proof', async () => {
    const w = world({ prepared: true, release: true, records: [approved(binding())], npmResult: { ok: false, summary: 'npm failed: E409 Conflict' } });
    w.deps.npmPublish = async () => { w.calls.push('npm publish'); w.s.npm = { visible: true, shasum: TGZ_SHA1 }; return { ok: false, summary: 'npm failed: E409 Conflict' }; };
    const r = await runCritpath(opts(), w.deps);
    expect(r.status).toBe('waiting-approval');
    expect(w.calls).toEqual([]);
  });

  test('unverified approval cannot stage npm on re-entry', async () => {
    const w = world({ records: [approved(binding())], npmResult: { ok: true, npm: 'staged-not-visible', summary: 'staged' } });
    expect((await runCritpath(opts(), w.deps)).status).toBe('waiting-approval');
    expect((await runCritpath(opts(), w.deps)).status).toBe('waiting-approval');
    expect(w.calls.filter((c) => c === 'npm publish')).toEqual([]);
  });

  test('--dry-run prepares and previews only: no publish, no npm publish, no approval card', async () => {
    const w = world();
    const r = await runCritpath(opts({ dryRun: true }), w.deps);
    expect(r.status).toBe('dry-run');
    expect(r.approval?.state).toBe('none');
    expect(w.calls).toEqual(['prepare', 'publish preview', 'npm --dry-run']);
    expect(r.remaining?.join('\n')).toContain('deploy-pages.ts');
  });

  test('waiver reason must pass the public known-issues text rule', async () => {
    for (const bad of ['The crash was fixed upstream.', 'This is no longer a problem.', 'See PR 123 for context.', 'Tracked in scripts/foo.ts here.']) {
      const w = world();
      await expect(runCritpath(opts({ waiveReason: bad }), w.deps)).rejects.toThrow('unsafe public waiver reason');
      expect(w.calls).toEqual([]);
    }
    const ok = world();
    const r = await runCritpath(opts({ waiveReason: 'Some installer paths remain unverified in this release.' }), ok.deps);
    expect(r.status).toBe('waiting-approval');
    expect(ledger().waiveReason).toBe('Some installer paths remain unverified in this release.');
  });

  test('a prepared folder from another cut is refused, not reused', async () => {
    const w = world({ prepared: true });
    const r = await runCritpath(opts({ cutCommit: OTHER_CUT }), w.deps);
    expect(r.status).toBe('failed');
    expect(r.step).toBe('prepare');
    expect(w.calls).toEqual([]);
  });

  test('--branch: the branch moved after prepare (recover/append) → stops at prepare, no reuse, publishes nothing', async () => {
    // Prepared + approved at CUT; then a fix was appended and origin/release/<v> now points to OTHER_CUT.
    const branch = `release/${VERSION}`;
    const w = world({ prepared: true, prepSourceRef: `origin/${branch}`, prepCommit: CUT, branchHead: OTHER_CUT, records: [approved(binding())] });
    const logs: string[] = [];
    w.deps.log = (l) => logs.push(l);
    const r = await runCritpath(opts({ cutCommit: undefined, branch }), w.deps);
    expect(r.status).toBe('failed');
    expect(r.exitCode).toBe(1);
    expect(r.step).toBe('prepare');
    expect(w.calls).toEqual(['resolve branch']);
    const entry = ledger().entries.at(-1);
    expect(entry).toMatchObject({ step: 'prepare', outcome: 'fail' });
    expect(entry?.detail).toContain(`branch moved: prepared ${CUT} · branch now ${OTHER_CUT} — re-prepare`);
    expect(entry?.detail).toContain(`elanous release critpath --version ${VERSION} --notes-file ${notes} --branch ${branch}`);
    expect(ledger().entries.some((e) => e.outcome === 'skipped')).toBe(false);
    expect(ledger().binding).toBeUndefined();
    expect(logs.join('\n')).toContain('branch moved');
  });

  test('--branch: the branch moved during prepare → stops, publishes nothing', async () => {
    const w = world({ branchHead: CUT, prepareYields: OTHER_CUT, records: [approved(binding())] });
    const r = await runCritpath(opts({ cutCommit: undefined, branch: `release/${VERSION}` }), w.deps);
    expect(r.status).toBe('failed');
    expect(r.step).toBe('prepare');
    expect(w.calls).toEqual(['resolve branch', 'prepare']);
    expect(ledger().entries.at(-1)?.detail).toContain(`branch moved: prepared ${OTHER_CUT} · branch now ${CUT}`);
  });

  test('--branch: the branch unchanged → the prepare is reused as before', async () => {
    const branch = `release/${VERSION}`;
    const w = world({ prepared: true, prepSourceRef: `origin/${branch}`, prepCommit: CUT, branchHead: CUT, release: true, npm: { visible: true, shasum: TGZ_SHA1 } });
    const r = await runCritpath(opts({ cutCommit: undefined, branch }), w.deps);
    expect(r.status).toBe('done');
    expect(w.calls).toEqual(['resolve branch', 'verify']);
    expect(ledger().entries.map((e) => `${e.step}:${e.outcome}`)).toEqual(['prepare:skipped', 'publish:skipped', 'npm:skipped', 'verify:ok']);
  });

  test('--branch: the approval binding uses the resolved commit, and an approval for the old commit does not count', async () => {
    const branch = `release/${VERSION}`;
    const w = world({ branchHead: OTHER_CUT, records: [approved(binding())] });
    const r = await runCritpath(opts({ cutCommit: undefined, branch }), w.deps);
    expect(r.status).toBe('waiting-approval');
    expect(w.calls).toEqual(['resolve branch', 'prepare', 'request approval']);
    expect(ledger().binding).toEqual(binding({ cutSha: OTHER_CUT }));
    expect(w.s.records.at(-1)?.refs).toEqual([approvalRef(binding({ cutSha: OTHER_CUT }))]);
    // A matching but unverified marker still cannot publish.
    w.s.records.push(approved(binding({ cutSha: OTHER_CUT })));
    const again = await runCritpath(opts({ cutCommit: undefined, branch }), w.deps);
    expect(again.status).toBe('waiting-approval');
    expect(again.approval?.state).toBe('unverified');
    expect(w.calls.filter((c) => c === 'prepare')).toEqual(['prepare']);
    expect(w.calls).not.toContain('publish --yes');
  });

  test('explicit dry-run preview reads a pinned copy of the notes bytes', async () => {
    const w = world({ records: [approved(binding())] });
    const approvedSha = notesSha();
    expect((await runCritpath(opts({ dryRun: true }), w.deps)).status).toBe('dry-run');
    const pinned = w.s.publishedNotes.at(-1) ?? '';
    expect(pinned).not.toBe(notes);
    expect(createHash('sha256').update(readFileSync(pinned)).digest('hex')).toBe(approvedSha);
  });

  test('exactly one of --cut-commit or --branch release/<v>', async () => {
    const w = world();
    await expect(runCritpath(opts({ cutCommit: undefined }), w.deps)).rejects.toThrow('exactly one');
    await expect(runCritpath(opts({ cutCommit: undefined, branch: 'release/other' }), w.deps)).rejects.toThrow('--branch must be');
  });
});

describe('release critpath auto-publish on green (owner opt-in)', () => {
  /** The world above plus the owner switch and the four green facts; decide() closes the open card as an AUTO decision. */
  function autoWorld(f: { mode?: 'off' | 'on-green'; red?: number; holds?: string[]; branchHead?: string } = {}) {
    const w = world({ branchHead: f.branchHead });
    const decided: Array<{ id: string; reason: string }> = [];
    const notices: string[] = [];
    const lines: string[] = [];
    w.deps.log = (line) => lines.push(line);
    w.deps.autoPublish = {
      mode: () => f.mode ?? 'on-green',
      redCount: () => f.red ?? 0,
      openHolds: () => f.holds ?? [],
      decide: (id, reason) => {
        decided.push({ id, reason });
        const card = w.s.records.find((r) => r.id === id)!;
        Object.assign(card, { status: 'decided', choice: 'a', decidedBy: { kind: 'auto', agent: 'release-auto' } });
      },
      notify: (body) => notices.push(body),
    };
    return { ...w, decided, notices, lines };
  }
  const at = (iso: string) => () => new Date(iso);

  test('switch off: a green dry run still waits for a human card, publishes nothing', async () => {
    const w = autoWorld({ mode: 'off' });
    await runCritpath(opts({ dryRun: true }), w.deps);
    const r = await runCritpath(opts(), w.deps);
    expect(r.status).toBe('waiting-approval');
    expect(r.exitCode).toBe(75);
    expect(w.decided).toEqual([]);
    expect(w.calls).not.toContain('publish --yes');
    expect(w.calls).not.toContain('npm publish');
    expect(w.notices).toEqual([]);
  });

  test('switch on + all green: AUTO decision on the card, then publish → npm → verify, then an after-the-fact report', async () => {
    const w = autoWorld();
    const dry = await runCritpath(opts({ dryRun: true }), w.deps);
    expect(dry.status).toBe('dry-run');
    expect(ledger().dryRunPass).toEqual({ cutSha: CUT, notesSha256: notesSha(), tgzSha1: TGZ_SHA1, at: '2026-11-19T00:00:00.000Z' });
    w.deps.now = at('2026-11-19T05:59:00Z');
    const r = await runCritpath(opts(), w.deps);
    expect(r.status).toBe('done');
    expect(w.decided.map((d) => d.id)).toEqual(['D-NEW']);
    expect(w.decided[0]!.reason).toContain('checklist 🔴 0');
    expect(w.decided[0]!.reason).toContain('no open HOLD');
    expect(w.calls.slice(-4)).toEqual(['request approval', 'publish --yes', 'npm publish', 'verify']);
    expect(ledger().entries.find((e) => e.step === 'approval')).toMatchObject({ outcome: 'ok', detail: 'card D-NEW · AUTO release-auto' });
    expect(w.notices).toHaveLength(1);
    expect(w.notices[0]).toStartWith('auto-published v9.9.9 · cut aaaaaaaaaaaa · checks ');
  });

  test('an AUTO record without the switch is not approval', async () => {
    const w = autoWorld();
    await runCritpath(opts({ dryRun: true }), w.deps);
    w.s.records.push({ id: 'D-AUTO', refs: [approvalRef(binding())], status: 'decided', choice: 'a', decidedBy: { kind: 'auto', agent: 'release-auto' } });
    expect(approvalState(w.s.records, binding())).toEqual({ state: 'auto', id: 'D-AUTO' });
    w.deps.autoPublish!.mode = () => 'off';
    const r = await runCritpath(opts(), w.deps);
    expect(r.status).toBe('waiting-approval');
    expect(w.calls).not.toContain('publish --yes');
  });

  const red: Array<[string, Parameters<typeof autoWorld>[0], string | null, string]> = [
    ['checklist has a 🔴', { red: 1 }, null, 'checklist 🔴 1'],
    ['dry run older than 6 h', {}, '2026-11-19T06:00:01Z', 'dry run stale'],
    // release/9.9.9 moved after the --cut-commit dry run (set after the dry run below).
    ['cut branch head moved', {}, null, 'cut branch head moved: release/9.9.9 bbbbbbbbbbbb ≠ prepared aaaaaaaaaaaa'],
    ['open HOLD decision', { holds: ['D-HOLD-1'] }, null, 'open HOLD decision D-HOLD-1'],
  ];
  for (const [name, facts, later, reason] of red) {
    test(`one red check keeps the human wait with the skip reason: ${name}`, async () => {
      const w = autoWorld(facts);
      await runCritpath(opts({ dryRun: true }), w.deps);
      if (later) w.deps.now = at(later);
      if (name === 'cut branch head moved') w.s.branchHead = OTHER_CUT;
      const r = await runCritpath(opts(), w.deps);
      expect(r.status).toBe('waiting-approval');
      expect(r.exitCode).toBe(75);
      expect(w.decided).toEqual([]);
      expect(w.calls).not.toContain('publish --yes');
      expect(w.calls).not.toContain('npm publish');
      expect(w.notices).toEqual([]);
      const skip = w.lines.find((l) => l.startsWith('· release.auto-publish skipped {'));
      expect(skip).toBeDefined();
      expect(skip).toContain(reason);
    });
  }

  test('no dry run for this cut + notes: waits with the skip reason', async () => {
    const w = autoWorld();
    const r = await runCritpath(opts(), w.deps);
    expect(r.status).toBe('waiting-approval');
    expect(w.lines.find((l) => l.startsWith('· release.auto-publish skipped {'))).toContain('no green dry run recorded');
  });

  test('--branch head unreadable: switch on waits rc 75 with branch-read-failed; switch off still fails as before', async () => {
    const on = autoWorld();
    on.deps.resolveBranch = () => { throw new Error('ssh: connect to host github.com port 22: Operation timed out'); };
    const r = await runCritpath(opts({ cutCommit: undefined, branch: 'release/9.9.9' }), on.deps);
    expect(r.status).toBe('waiting-approval');
    expect(r.exitCode).toBe(75);
    expect(on.lines).toContain('· release.auto-publish skipped {branch-read-failed: ssh: connect to host github.com port 22: Operation timed out}');
    expect(on.calls).not.toContain('prepare');
    expect(on.calls).not.toContain('publish --yes');
    expect(on.decided).toEqual([]);
    const off = autoWorld({ mode: 'off' });
    off.deps.resolveBranch = () => { throw new Error('ssh: connect to host github.com port 22: Operation timed out'); };
    const r2 = await runCritpath(opts({ cutCommit: undefined, branch: 'release/9.9.9' }), off.deps);
    expect(r2.status).toBe('failed');
    expect(r2.exitCode).toBe(1);
    expect(r2.step).toBe('prepare');
  });

  test('notes changed after the dry run: waits (dry run was for another cut/notes)', async () => {
    const w = autoWorld();
    await runCritpath(opts({ dryRun: true }), w.deps);
    writeFileSync(notes, '# elanous v9.9.9\n\nEdited after the dry run.\n');
    const r = await runCritpath(opts(), w.deps);
    expect(r.status).toBe('waiting-approval');
    expect(w.lines.find((l) => l.startsWith('· release.auto-publish skipped {'))).toContain('dry run was for another cut/notes');
  });
});
