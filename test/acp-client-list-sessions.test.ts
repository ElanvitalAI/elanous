import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { AcpAgent } from '../src/acp/client.js';
import { AcpListSessionsUnsupportedError } from '../src/acp/capabilities.js';
import { debug } from '../src/debug/log.js';

type ListConnection = {
  listSessions: (request: { cursor?: string; cwd: string }) => Promise<unknown>;
};

function setConnection(agent: AcpAgent, connection: ListConnection): void {
  (agent as unknown as { connection: ListConnection }).connection = connection;
}

function recordCapabilities(agent: AcpAgent, list: boolean): void {
  (agent as unknown as {
    recordCapabilities: (capabilities: unknown, protocolVersion: number) => void;
  }).recordCapabilities({
    sessionCapabilities: list ? { list: {} } : {},
  }, 1);
}

describe('AcpAgent.listSessions', () => {
  afterEach(() => {
    spyOn(debug, 'log').mockRestore();
  });

  test('delegates one advertised cursor page with the request cwd and observes counts without session ids', async () => {
    const agent = new AcpAgent({ backendId: 'claude', cwd: '/workspace', log: () => {} });
    const response = {
      sessions: [{ sessionId: 'private-session-id', cwd: '/workspace' }],
      nextCursor: 'next-page',
    };
    const connection = { listSessions: async () => response };
    const listSessions = spyOn(connection, 'listSessions');
    const events: Array<{ category: string; event: string; data: unknown }> = [];
    const logSpy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
      events.push({ category, event, data });
    });
    setConnection(agent, connection);
    recordCapabilities(agent, true);

    await expect(agent.listSessions({ cursor: 'current-page' })).resolves.toBe(response);

    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(listSessions).toHaveBeenCalledWith({ cursor: 'current-page', cwd: '/workspace' });
    expect(events).toContainEqual({
      category: 'acp.client',
      event: 'session-list',
      data: { hasCursor: true, sessionCount: 1 },
    });
    logSpy.mockRestore();
  });

  test('uses an explicit request cwd instead of the agent cwd', async () => {
    const agent = new AcpAgent({ backendId: 'claude', cwd: '/agent-cwd' });
    const connection = { listSessions: async () => ({ sessions: [] }) };
    const listSessions = spyOn(connection, 'listSessions');
    setConnection(agent, connection);
    recordCapabilities(agent, true);

    await agent.listSessions({ cwd: '/request-cwd' });

    expect(listSessions).toHaveBeenCalledWith({ cursor: undefined, cwd: '/request-cwd' });
  });

  test('uses the agent cwd when the request omits cwd', async () => {
    const agent = new AcpAgent({ backendId: 'claude', cwd: '/agent-cwd' });
    const connection = { listSessions: async () => ({ sessions: [] }) };
    const listSessions = spyOn(connection, 'listSessions');
    setConnection(agent, connection);
    recordCapabilities(agent, true);

    await agent.listSessions();

    expect(listSessions).toHaveBeenCalledWith({ cursor: undefined, cwd: '/agent-cwd' });
  });

  test('rejects an unadvertised list capability with its dedicated error without calling the SDK', async () => {
    const agent = new AcpAgent({ backendId: 'claude', cwd: '/workspace' });
    const connection = { listSessions: async () => ({ sessions: [] }) };
    const listSessions = spyOn(connection, 'listSessions');
    setConnection(agent, connection);
    recordCapabilities(agent, false);

    await expect(agent.listSessions()).rejects.toBeInstanceOf(AcpListSessionsUnsupportedError);
    expect(listSessions).not.toHaveBeenCalled();
  });

  test('rejects before initialization with AcpAgent not started', async () => {
    const agent = new AcpAgent({ backendId: 'claude', cwd: '/workspace' });

    await expect(agent.listSessions()).rejects.toThrow('AcpAgent not started');
  });
});
