import { expect, test } from 'bun:test';
import { parseMcpConfig } from './mcp.js';

test('MCP config parser is available without importing the user config hub', () => {
  expect(parseMcpConfig({
    servers: [{ id: 'sim', command: ['sim-mcp'], authorizedTools: ['read', 'read', 42] }],
  })).toEqual({
    servers: [{ id: 'sim', transport: 'stdio', command: ['sim-mcp'], authorizedTools: ['read'] }],
  });
});
