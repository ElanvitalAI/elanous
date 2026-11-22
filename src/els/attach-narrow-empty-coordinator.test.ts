import { expect, test } from 'bun:test';
import { createAttachApp } from './attach-app.js';

const plain = (text: string) => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');

for (const input of ['mouse', 'keyboard'] as const) {
  test(`narrow dropdown selects empty remote coordinator by ${input} without a fake pane`, async () => {
    const attached: string[] = [];
    const reads: string[] = [];
    const screens: string[] = [];
    let detached = 0;
    const app = createAttachApp({
      request: async () => ({ exitCode: 0, message: JSON.stringify({ workspaces: [{ id: 'local', name: 'local' }], panes: [{ address: 'local/t/p', workspace: 'local', pane: 'p', title: 'p', state: 'idle' }] }) }),
      attach: pane => { attached.push(pane); return { input() {}, resize() {}, scroll() {}, detach() { detached++; } }; },
      remote: {
        list: async () => ({ exitCode: 0, message: JSON.stringify({ hosts: [{ name: 'other', reach: 'up' }], panes: [], remoteWorkspaces: [{ host: 'other', id: 'chief', name: 'chief', role: 'coordinator', reach: 'up' }] }) }),
        read: async pane => { reads.push(pane); return { exitCode: 0, message: '' }; },
      },
      write: text => screens.push(text), size: () => ({ cols: 60, rows: 12 }), cwd: '/x', env: {},
      setInterval: () => 0, clearInterval() {}, pollMs: 1000, chatCommand: [], memory: { load: () => ({}), save() {} },
    });
    await app.start('p');
    await Bun.sleep(20);
    app.key('\u0002s');
    const lines = screens.at(-1)!.split('\r\n');
    const y = lines.findIndex(line => plain(line).toLowerCase().includes('🎼 ⇄other chief')) + 1;
    expect(y).toBeGreaterThan(1);
    if (input === 'mouse') app.key(`\u001b[<0;5;${y}M`);
    else { app.key('j'); app.key('\r'); }
    expect(detached).toBe(1);
    expect(attached).toEqual(['p']);
    expect(reads).toEqual([]);
    expect(plain(screens.at(-1)!)).toContain('빈 작업공간');
    app.key('\u0002s');
    expect(plain(screens.at(-1)!)).toContain('local');
    if (input === 'mouse') {
      const reopened = screens.at(-1)!.split('\r\n');
      const localY = reopened.findIndex(line => plain(line).includes('🛠 p')) + 1;
      expect(localY).toBeGreaterThan(1);
      app.key(`\u001b[<0;5;${localY}M`);
    } else { app.key('k'); app.key('\r'); }
    expect(attached).toEqual(['p', 'p']);
    expect(reads).toEqual([]);
    app.key('\u0002q');
  });
}
