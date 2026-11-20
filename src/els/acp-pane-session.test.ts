import { expect, test } from 'bun:test';
import { createAcpPaneSessions, type AcpPanePeer } from './acp-pane-session.js';
import { AcpAgent } from '../acp/client.js';

test('separate panes open separate sessions and route streamed replies', async () => {
  const stopped: string[] = [];
  const seen: string[] = [];
  const sessions = createAcpPaneSessions((pane) => ({
    start: async () => {}, newSession: async () => `session-${pane}`,
    prompt: async (id, blocks, update) => { update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${id}:${blocks[0]?.type === 'text' ? blocks[0].text : ''}` } }); return { stopReason: 'end_turn' }; },
    stop: async () => { stopped.push(pane); },
  }));
  await Promise.all([sessions.open('a'), sessions.open('b')]);
  await sessions.prompt('a', 'hello', u => { if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') seen.push(u.content.text); });
  await sessions.prompt('b', 'world', u => { if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') seen.push(u.content.text); });
  expect(seen).toEqual(['session-a:hello', 'session-b:world']);
  await sessions.close('a');
  expect(stopped).toEqual(['a']);
  await sessions.close('b');
});

test('failed startup releases the peer and can be retried', async () => {
  let starts = 0;
  let stops = 0;
  const sessions = createAcpPaneSessions(() => ({
    start: async () => { if (++starts === 1) throw new Error('refused'); },
    newSession: async () => 'session', prompt: async () => ({ stopReason: 'end_turn' }),
    stop: async () => { stops++; },
  }));
  await expect(sessions.open('a')).rejects.toThrow('refused');
  expect(stops).toBe(1);
  await sessions.open('a');
  await sessions.close('a');
  expect(stops).toBe(2);
});

test('close during startup stops the peer without leaving an open pane', async () => {
  let finish!: () => void;
  const ready = new Promise<void>(resolve => { finish = resolve; });
  let stops = 0;
  const sessions = createAcpPaneSessions(() => ({
    start: async () => { await ready; }, newSession: async () => 'session',
    prompt: async () => ({ stopReason: 'end_turn' }), stop: async () => { stops++; },
  }));
  const opening = sessions.open('a');
  const closing = sessions.close('a');
  finish();
  await opening;
  await closing;
  expect(stops).toBe(1);
  await expect(sessions.prompt('a', 'after close', () => {})).rejects.toThrow('pane is not open');
});

test('duplicate opens and closed panes do not create or send to another peer', async () => {
  let created = 0;
  const sessions = createAcpPaneSessions(() => {
    created++;
    return { start: async () => {}, newSession: async () => 'one',
      prompt: async () => ({ stopReason: 'end_turn' }), stop: async () => {} };
  });
  await sessions.open('a');
  await expect(sessions.open('a')).rejects.toThrow('pane already open');
  await sessions.close('a');
  await expect(sessions.prompt('a', 'no', () => {})).rejects.toThrow('pane is not open');
  expect(created).toBe(1);
});

test('real ACP stdio handshake, sessions, streaming and shutdown', async () => {
  const program = `let b=''; process.stdin.on('data', c => { b+=c; let i; while ((i=b.indexOf('\\n'))>=0) {
    const m=JSON.parse(b.slice(0,i)); b=b.slice(i+1); let result;
    if(m.method==='initialize') result={protocolVersion:1,agentCapabilities:{}};
    else if(m.method==='session/new') result={sessionId:'peer-session'};
    else if(m.method==='session/prompt') { process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'peer reply'}}}})+'\\n'); result={stopReason:'end_turn'}; }
    if(result) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
  }});`;
  const sessions = createAcpPaneSessions(() => new AcpAgent({ backendId: 'fixture', cwd: process.cwd(), env: {}, log: () => {},
    backendSpec: { id: 'fixture', label: 'fixture', command: process.execPath, args: ['-e', program], npmPackage: '', npmVersion: '' } }));
  const replies: string[] = [];
  try {
    await sessions.open('pane');
    const result = await sessions.prompt('pane', 'hello', u => { if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') replies.push(u.content.text); });
    expect(result.stopReason).toBe('end_turn');
    expect(replies).toEqual(['peer reply']);
  } finally { await sessions.close('pane'); }
});

test('late updates from a closed pane cannot reach a reopened pane', async () => {
  let late!: Parameters<AcpPanePeer['prompt']>[2];
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let created = 0;
  const sessions = createAcpPaneSessions(() => {
    const id = ++created;
    return { start: async () => {}, newSession: async () => `session-${id}`,
      prompt: async (_session, _blocks, update) => { if (id === 1) { late = update; await pending; } return { stopReason: 'end_turn' }; },
      stop: async () => {} };
  });
  const seen: string[] = [];
  await sessions.open('pane');
  const turn = sessions.prompt('pane', 'first', () => { seen.push('old'); });
  await Promise.resolve();
  await sessions.close('pane');
  await sessions.open('pane');
  late({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } });
  finish();
  await turn;
  expect(seen).toEqual([]);
  await sessions.close('pane');
});

test('a failed stop keeps the pane reserved and permits a cleanup retry', async () => {
  let stops = 0;
  const sessions = createAcpPaneSessions(() => ({
    start: async () => {}, newSession: async () => 'session',
    prompt: async () => ({ stopReason: 'end_turn' }),
    stop: async () => { if (++stops === 1) throw new Error('stop failed'); },
  }));
  await sessions.open('pane');
  await expect(sessions.close('pane')).rejects.toThrow('stop failed');
  await expect(sessions.open('pane')).rejects.toThrow('pane already open');
  await expect(sessions.prompt('pane', 'do not send', () => {})).rejects.toThrow('pane is not open');
  await sessions.close('pane');
  expect(stops).toBe(2);
  await sessions.open('pane');
  await sessions.close('pane');
});

test('startup and cleanup failure reserve the pane until cleanup succeeds', async () => {
  let stops = 0;
  const sessions = createAcpPaneSessions(() => ({
    start: async () => { throw new Error('start failed'); }, newSession: async () => 'unused',
    prompt: async () => ({ stopReason: 'end_turn' }),
    stop: async () => { if (++stops === 1) throw new Error('cleanup failed'); },
  }));
  await expect(sessions.open('pane')).rejects.toThrow('start failed');
  await expect(sessions.open('pane')).rejects.toThrow('pane already open');
  await expect(sessions.prompt('pane', 'do not send', () => {})).rejects.toThrow('pane is not open');
  await sessions.close('pane');
  expect(stops).toBe(2);
});

test('close racing with failed startup retries a failed cleanup', async () => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let stops = 0;
  const sessions = createAcpPaneSessions(() => ({
    start: async () => { await waiting; throw new Error('start failed'); }, newSession: async () => 'unused',
    prompt: async () => ({ stopReason: 'end_turn' }),
    stop: async () => { if (++stops === 1) throw new Error('cleanup failed'); },
  }));
  const opening = sessions.open('pane');
  const closing = sessions.close('pane');
  release();
  await expect(opening).rejects.toThrow('start failed');
  await closing;
  expect(stops).toBe(2);
});
