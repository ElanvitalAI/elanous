import { expect, spyOn, test } from 'bun:test';
import { debug } from '../../debug/log.js';
import { recordToolCatalog } from './tool-catalog-observability.js';

test('tool catalog observation preserves complete membership evidence', () => {
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    recordToolCatalog('session-1', 'daemon-tools', { name: 'toolSurface' }, [
      { name: 'Read', description: '', parameters: {} },
      { name: 'Write', description: '', parameters: {} },
    ]);

    expect(log).toHaveBeenCalledWith('capability.resolve', 'tool-catalog-assembled', {
      sessionId: 'session-1',
      surface: 'daemon-tools',
      assembler: 'toolSurface',
      toolCount: 2,
      tools: ['Read', 'Write'],
    }, {
      compact: { arrayMax: Number.MAX_SAFE_INTEGER, stringMax: Number.MAX_SAFE_INTEGER },
    });
  } finally {
    log.mockRestore();
  }
});
