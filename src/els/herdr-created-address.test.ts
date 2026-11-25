import { expect, test } from 'bun:test';
import { herdrCreated } from './herdr-shape.js';

test.each(['host1:w123/t456/p789', 'w123/t456/p789'])(
  'created JSON uses workspace ID without host prefix: %s', (address) => {
  const actual = herdrCreated({ address, pane: 'p789', ptyId: 'pty', cwd: '/tmp' });
  expect(actual).toEqual({ result: {
    workspace: { workspace_id: 'w123' },
    tab: { tab_id: 't456', workspace_id: 'w123' },
    root_pane: { pane_id: 'p789', tab_id: 't456', workspace_id: 'w123', cwd: '/tmp' },
    pane: { pane_id: 'p789', tab_id: 't456', workspace_id: 'w123', cwd: '/tmp' },
  } });
});
