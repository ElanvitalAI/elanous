import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as instanceIdentity from '../instance-identity.js';
import { forgetExternalWriteProvenance, noteExternalWrite, notePtyAccessMode } from '../pty-shell/pty-write-provenance.js';
import * as ptyManifest from '../pty-shell/pty-manifest.js';
import * as runState from '../pty-shell/tui-run-state.js';
import { formatSidetabLines, loadSidetabRows, sidetabWidthForTerminal } from '../sidetab-core/model.js';
import type { PtyManifestRow } from '../pty-shell/pty-manifest.js';

const manifest: PtyManifestRow = {
  id: 'tui:control-sim', kind: 'tui', nickname: 'Codex', cmd: 'tui', ownerPid: 8, ptyPid: 9,
  instance: 'control-sim', startedAt: 1, alive: true, exitCode: null, snapshot: '', snapshotAt: 1,
  parentPid: 0, parentPtyId: '', parentKind: '', nestDepth: 0, sessionId: 'control-sim',
  updatedAt: 1, frame: '', frameAt: 1, runId: '', runIdSource: '', spaceId: '', closedAt: 0, codeSha: '',
};

describe('SIDETAB-AGENT-CONTROL-INDICATOR ux-sim', () => {
  afterEach(() => {
    mock.restore();
    forgetExternalWriteProvenance(manifest.id);
  });

  test('production loader shows control ownership without claiming an unobserved active mission', () => {
    spyOn(ptyManifest, 'listPtyManifestRows').mockReturnValue([manifest]);
    spyOn(instanceIdentity, 'resolveInstanceName').mockReturnValue('control-sim');
    spyOn(runState, 'describePtyRunState').mockReturnValue({
      turn: 'busy', build: null, installed: null, stale: null, staleReason: 'unknown',
    });
    const terminal = { cols: 90, rows: 28 };
    const width = sidetabWidthForTerminal(terminal.cols);
    const changes = [
      { accessMode: 'auto' as const, actor: 'agent' as const, badge: '🤖', title: '엘라누스 조작 중' },
      { accessMode: 'write' as const, actor: 'human' as const, badge: '👤', title: '세션 · PTY' },
      { accessMode: 'auto' as const, actor: 'agent' as const, badge: '🤖', title: '엘라누스 조작 중' },
    ];

    const frames = changes.map((change) => {
      notePtyAccessMode(manifest.id, change.accessMode);
      noteExternalWrite(manifest.id, change.actor);
      const rows = loadSidetabRows(true);
      const lines = formatSidetabLines(rows, 0, width, 8);
      return { terminal, lines, state: rows[0]?.controlState };
    });

    expect(frames.map((frame) => frame.state?.actor)).toEqual(['agent', 'human', 'agent']);
    expect(frames[0]?.lines[0]).toContain('🤖 엘라누스 조작 중');
    expect(frames[1]?.lines[0]).toContain('세션 · PTY');
    expect(frames[2]?.lines[0]).toContain('🤖 엘라누스 조작 중');
    expect(frames[0]?.lines[0]).not.toContain('미션 진행 중');
    expect(frames[2]?.lines[0]).not.toContain('미션 진행 중');
    expect(frames[0]?.lines[2]).toContain('› 🤖 busy Codex');
    expect(frames[1]?.lines[2]).toContain('› 👤 busy Codex');
    expect(frames[2]?.lines[2]).toContain('› 🤖 busy Codex');
    expect(frames[0]?.lines[0]).toContain('\u001b[1;36m');
    expect(frames[1]?.lines[0]).not.toContain('\u001b[1;36m');
    expect(frames[2]?.lines[0]).toContain('\u001b[1;36m');
    expect(frames.every((frame) => frame.terminal.cols === 90 && frame.terminal.rows === 28)).toBe(true);
    expect(frames.every((frame) => frame.lines.length === frames[0]!.lines.length)).toBe(true);
    expect(frames.every((frame) => frame.lines.every((line) => Bun.stringWidth(line) === width))).toBe(true);
  });
});
