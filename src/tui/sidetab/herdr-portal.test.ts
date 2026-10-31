import { describe, expect, test } from 'bun:test';
import { createHerdrSidetabPortal } from './herdr-portal.js';

function snapshot(panes: unknown[]): string {
  return JSON.stringify({ id: 'cli:api:snapshot', result: { panes } });
}

describe('Herdr sidetab portal adapter', () => {
  test('is inert outside a Herdr-managed pane', async () => {
    const calls: string[][] = [];
    const portal = createHerdrSidetabPortal({
      env: {},
      run: async (argv) => { calls.push([...argv]); return { code: 0, stdout: snapshot([]), stderr: '' }; },
    });
    expect(portal.enabled()).toBe(false);
    expect(await portal.refreshRows()).toEqual([]);
    await expect(portal.readPane('w1:p1')).rejects.toThrow('Herdr 관리 pane');
    expect(calls).toEqual([]);
  });

  test('keeps approval, verified/unverified completion and stopped states distinct; carries available cost', async () => {
    const portal = createHerdrSidetabPortal({
      env: { HERDR_ENV: '1' },
      isVerified: (pane) => pane.pane_id === 'w1:p2',
      run: async () => ({
        code: 0,
        stdout: snapshot([
          { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'codex', agent_status: 'blocked', terminal_title: 'Review' },
          { pane_id: 'w1:p2', workspace_id: 'w1', agent: 'claude', agent_status: 'done', terminal_title: 'Build', cost_usd: 1.25 },
          { pane_id: 'w1:p3', workspace_id: 'w1', agent: 'codex', agent_status: 'done', terminal_title: 'Tests' },
          { pane_id: 'w1:p4', workspace_id: 'w1', agent: 'claude', agent_status: 'stopped', terminal_title: 'Old task' },
          { pane_id: 'w1:p5', workspace_id: 'w1', agent: 'codex', agent_status: 'done', alive: false, terminal_title: 'Exited result' },
        ]),
        stderr: '',
      }),
    });
    const rows = await portal.refreshRows();
    expect(rows.map(({ id, badge, label }) => [id, badge, label])).toEqual([
      ['herdr:w1:p1', 'busy', expect.stringContaining('승인 필요')],
      ['herdr:w1:p2', 'idle', expect.stringContaining('검증 완료')],
      ['herdr:w1:p3', 'unknown', expect.stringContaining('미검증 완료')],
      ['herdr:w1:p4', 'exited', expect.stringContaining('멈춤')],
      ['herdr:w1:p5', 'unknown', expect.stringContaining('미검증 완료')],
    ]);
    expect(rows[1]?.label).toContain('비용 $1.25');
    expect(rows[2]?.label).toContain('비용 —');
  });

  test('uses explicit pane ids for observe and takeover input; preserves errors and existing snapshot on refresh failure', async () => {
    const calls: string[][] = [];
    let snapshotMode: 'ok' | 'exit' | 'bad-envelope' | 'bad-pane' = 'ok';
    const portal = createHerdrSidetabPortal({
      env: { HERDR_ENV: '1' },
      run: async (argv) => {
        calls.push([...argv]);
        if (argv[0] === 'api') {
          if (snapshotMode === 'exit') return { code: 1, stdout: '', stderr: 'snapshot down' };
          if (snapshotMode === 'bad-envelope') return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: '' };
          if (snapshotMode === 'bad-pane') return { code: 0, stdout: snapshot([{}]), stderr: '' };
          return { code: 0, stdout: snapshot([{ pane_id: 'w2:p7', agent_status: 'idle', terminal_title: 'Task' }]), stderr: '' };
        }
        if (argv[1] === 'read') return { code: 0, stdout: JSON.stringify({ result: { text: 'screen' } }), stderr: '' };
        return { code: 0, stdout: '{}', stderr: '' };
      },
    });
    await portal.refreshRows();
    snapshotMode = 'exit';
    const stale = await portal.refreshRows();
    expect(stale).toHaveLength(2);
    expect(stale[0]?.label).toContain('오래된 스냅샷');
    expect(stale[1]?.label).toContain('snapshot down');
    expect(portal.rows()).toHaveLength(2);
    snapshotMode = 'bad-envelope';
    expect((await portal.refreshRows()).at(-1)?.label).toContain('panes 배열');
    snapshotMode = 'bad-pane';
    expect((await portal.refreshRows()).at(-1)?.label).toContain('panes[0].pane_id');
    snapshotMode = 'ok';
    expect((await portal.refreshRows()).map((row) => row.label)).toEqual([expect.stringContaining('Task')]);
    expect(await portal.readPane('w2:p7')).toBe('screen');
    await portal.sendText('w2:p7', 'hello');
    await portal.sendKey('w2:p7', '\r');
    await portal.sendKey('w2:p7', '\x1b[A');
    await portal.sendKey('w2:p7', '\x7f');
    await expect(portal.sendKey('w2:p7', '\x1b[1;5A')).rejects.toThrow('escape key');
    expect(calls.slice(-5)).toEqual([
      ['pane', 'read', 'w2:p7', '--source', 'visible', '--format', 'ansi'],
      ['pane', 'send-text', 'w2:p7', 'hello'],
      ['pane', 'send-keys', 'w2:p7', 'enter'],
      ['pane', 'send-keys', 'w2:p7', 'up'],
      ['pane', 'send-keys', 'w2:p7', 'backspace'],
    ]);
    await expect(portal.sendText('w2:p7/../p8', 'bad')).rejects.toThrow('pane id');
  });
});
