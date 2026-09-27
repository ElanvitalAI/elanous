import { describe, expect, test } from 'bun:test';
import { parseAcpBootArgs } from './acp-server.js';
import { createDaemonBootToolCwdResolver } from './daemon-runtime.js';

describe('ACP boot tool cwd', () => {
  test('isolated ACP boot without a default cwd defers resolution to the session', () => {
    const previous = process.env.ELANOUS_TOOL_CWD;
    delete process.env.ELANOUS_TOOL_CWD;
    try {
      expect(createDaemonBootToolCwdResolver({ acpSessionCwd: true }, 'readonly').cwd).toBeUndefined();
      expect(createDaemonBootToolCwdResolver({ acpSessionCwd: true, toolCwd: '/tmp/default' }, 'readonly').cwd)
        .toBe('/tmp/default');
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_TOOL_CWD;
      else process.env.ELANOUS_TOOL_CWD = previous;
    }
  });

  test('reads --tool-cwd as a separate argument', () => {
    expect(parseAcpBootArgs(['--acp-server', '--tool-cwd', '/tmp/x']).toolCwd).toBe('/tmp/x');
  });

  test('flag wins over ELANOUS_TOOL_CWD without changing the environment', () => {
    const previous = process.env.ELANOUS_TOOL_CWD;
    process.env.ELANOUS_TOOL_CWD = '/tmp/y';
    try {
      expect(parseAcpBootArgs(['--acp-server', '--tool-cwd', '/tmp/x']).toolCwd).toBe('/tmp/x');
      expect(parseAcpBootArgs(['--acp-server', '--tool-cwd=/tmp/x']).toolCwd).toBe('/tmp/x');
      expect(process.env.ELANOUS_TOOL_CWD).toBe('/tmp/y');
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_TOOL_CWD;
      else process.env.ELANOUS_TOOL_CWD = previous;
    }
  });
});
