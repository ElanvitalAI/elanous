import { describe, expect, test } from 'bun:test';

import type { SearchModalHandle } from '../src/chat/search/modal.js';
import { openDashboardFolderAttachModal } from '../src/dashboard/folder-attach-modal-runtime.js';

describe('openDashboardFolderAttachModal', () => {
  test('accept path attaches token and settles once', async () => {
    const tokens: string[] = [];
    let accepted!: (item: { absPath: string }) => void;
    let disposed = 0;
    let draws = 0;

    openDashboardFolderAttachModal('/tmp/folder', (token) => { tokens.push(token); }, {
      termSize: () => ({ cols: 120, rows: 40 }),
      createFolderPickerModal: async (opts) => {
        accepted = opts.onAccept;
        return { surface: { id: 'picker-1' } } as unknown as SearchModalHandle;
      },
      attachFilePathToken: async (absPath) => `[picked:${absPath}] `,
      pushModal: () => ({ dispose: () => { disposed += 1; } }),
      getTheme: () => ({}) as any,
      draw: () => { draws += 1; },
    });

    await Promise.resolve();
    accepted?.({ absPath: '/tmp/folder/a.txt' });
    await Promise.resolve();
    await Promise.resolve();

    expect(tokens).toEqual(['[picked:/tmp/folder/a.txt] ']);
    expect(disposed).toBe(1);
    expect(draws).toBe(1);
  });

  test('cancel settles empty token and create failure also settles empty token', async () => {
    const first: string[] = [];
    let cancel!: () => void;
    let disposed = 0;

    openDashboardFolderAttachModal('/tmp/folder', (token) => { first.push(token); }, {
      termSize: () => ({ cols: 80, rows: 24 }),
      createFolderPickerModal: async (opts) => {
        cancel = opts.onCancel;
        return { surface: { id: 'picker-2' } } as unknown as SearchModalHandle;
      },
      attachFilePathToken: async () => '[unused] ',
      pushModal: () => ({ dispose: () => { disposed += 1; } }),
      getTheme: () => ({}) as any,
      draw: () => {},
    });

    await Promise.resolve();
    cancel?.();
    await Promise.resolve();
    expect(first).toEqual(['']);
    expect(disposed).toBe(1);

    const second: string[] = [];
    openDashboardFolderAttachModal('/tmp/folder', (token) => { second.push(token); }, {
      termSize: () => ({ cols: 80, rows: 24 }),
      createFolderPickerModal: async () => { throw new Error('boom'); },
      attachFilePathToken: async () => '[unused] ',
      pushModal: () => null,
      getTheme: () => ({}) as any,
      draw: () => {},
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(second).toEqual(['']);
  });
});
