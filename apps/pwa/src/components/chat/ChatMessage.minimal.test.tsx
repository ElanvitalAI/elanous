import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatMessageView } from './ChatMessage';
import type { ChatMessage } from '@/lib/chat-runtime';

const base = { id: 'fake-stream', role: 'assistant' as const, timestamp: 0 };

function render(message: ChatMessage): string {
  return renderToStaticMarkup(<ChatMessageView message={message} minimal />);
}

describe('minimal chat fake stream', () => {
  it('shows DEPLOY-1 receipt status and publishes a safe result link only after published', () => {
    const url = 'https://demo--alice.elanous.app/';
    const simulated = render({ ...base, text: '배포 중…', streaming: true, blocks: [
      { kind: 'tool_use', id: 'd1', name: 'app_deploy', status: 'running' },
      { kind: 'deploy_result', toolId: 'd1', result: { status: 'simulated' } },
    ] });
    expect(simulated.split('<details')[0]).toContain('data-elanous-deploy-status="simulated"');
    expect(simulated.split('<details')[0]).not.toContain('href=');
    const published = render({ ...base, text: '배포 완료', blocks: [
      { kind: 'tool_use', id: 'd1', name: 'app_deploy', status: 'done' },
      { kind: 'deploy_result', toolId: 'd1', result: { status: 'published', publicUrl: url } },
    ] });
    expect(published.split('<details')[0]).toContain(`href="${url}"`);
    expect(published.split('<details')[0]).toContain('data-elanous-deploy-status="published"');
    const rejected = render({ ...base, text: '게시하지 않았습니다', blocks: [
      { kind: 'deploy_result', toolId: 'd1', result: { status: 'rejected' } },
    ] });
    expect(rejected.split('<details')[0]).not.toContain('href=');
  });
  it('keeps interim text, tool calls, progress, and debug behind details', () => {
    const html = render({ ...base, text: '검색 중…', streaming: true, blocks: [
      { kind: 'text', text: '검색 중…' },
      { kind: 'tool_use', id: 'tool-1', name: 'Search', status: 'running' },
      { kind: 'agent_status', blockId: 'status-1', agentId: 'agent', status: 'running' },
      { kind: 'tool_progress', blockId: 'progress-1', stream: 'stdout', lines: ['debug output'], done: false },
      { kind: 'debug_session', blockId: 'debug-1', lines: [] },
    ] });
    expect(html).toMatch(/<summary[^>]*>자세히<\/summary>/);
    expect(html.split('<details')[0]).not.toContain('검색 중');
    expect(html.split('<details')[0]).not.toContain('Search');
    expect(html.split('<details')[0]).not.toContain('debug output');
  });

  it('shows the final answer and result card while keeping tool calls folded', () => {
    const html = render({ ...base, text: '배포했습니다: https://example.test', blocks: [
      { kind: 'tool_use', id: 'tool-1', name: 'Deploy', status: 'done' },
      { kind: 'text', text: '배포했습니다: https://example.test' },
    ] });
    expect(html.split('<details')[0]).toContain('배포했습니다');
    expect(html.split('<details')[0]).not.toContain('Deploy');
    expect(html).toMatch(/<summary[^>]*>자세히<\/summary>/);
  });

  it('shows a tool result card before the answer completes', () => {
    const card = '```elanous-card\n{"kind":"coo-admin","items":[{"title":"배포 주소","due":null,"daysLeft":null,"state":"done","owner":"OP","url":"https://example.test"}]}\n```';
    const html = render({ ...base, text: '배포 중…', streaming: true, blocks: [
      { kind: 'text', text: '배포 중…' },
      { kind: 'tool_use', id: 'deploy', name: 'Deploy', status: 'done' },
      { kind: 'text', text: card },
    ] });
    expect(html.split('<details')[0]).toContain('data-elanous-card-kind="coo-admin"');
    expect(html.split('<details')[0]).toContain('https://example.test');
    expect(html.split('<details')[0]).not.toContain('배포 중');
  });

  it('shows a card from a text-only streaming placeholder', () => {
    const card = '```elanous-card\n{"kind":"coo-admin","items":[{"title":"배포 주소","due":null,"daysLeft":null,"state":"done","owner":"OP"}]}\n```';
    const html = render({ ...base, text: `확인 중…\n${card}`, streaming: true });
    expect(html.split('<details')[0]).toContain('data-elanous-card-kind="coo-admin"');
    expect(html.split('<details')[0]).not.toContain('확인 중');
  });

  it('shows a shared card only once when cumulative text and a result block both contain it', () => {
    const card = '```elanous-card\n{"kind":"coo-admin","items":[{"title":"배포 주소","due":null,"daysLeft":null,"state":"done","owner":"OP"}]}\n```';
    const html = render({ ...base, text: `확인 중…\n${card}`, streaming: true, blocks: [
      { kind: 'text', text: `확인 중…\n${card}` },
      { kind: 'text', text: card },
    ] });
    expect(html.split('<details')[0].match(/data-elanous-card-kind="coo-admin"/g)).toHaveLength(1);
  });

  it('keeps prose before the last tool call folded after the final answer', () => {
    const text = '배포 확인 중…\n완료: https://example.test';
    const html = render({ ...base, text, finalTextStart: '배포 확인 중…\n'.length, blocks: [
      { kind: 'text', text },
      { kind: 'tool_use', id: 'deploy', name: 'Deploy', status: 'done' },
    ] });
    expect(html.split('<details')[0]).toContain('완료:');
    expect(html.split('<details')[0]).not.toContain('배포 확인 중');
    expect(html).toContain('배포 확인 중');
  });

  it('keeps interrupted partial prose folded and gives a concise outcome', () => {
    const html = render({ ...base, text: '부분 답변', incomplete: true, meta: { stopReason: 'aborted' } });
    expect(html.split('<details')[0]).toContain('응답 중단됨');
    expect(html.split('<details')[0]).not.toContain('부분 답변');
    expect(html).toContain('부분 답변');
  });

  it('keeps ordinary tool result text available in details', () => {
    const html = render({ ...base, text: '최종 답', blocks: [
      { kind: 'text', text: '최종 답' },
      { kind: 'text', text: '원시 결과 42' },
    ] });
    expect(html.split('<details')[0]).toContain('최종 답');
    expect(html.split('<details')[0]).not.toContain('원시 결과 42');
    expect(html).toContain('원시 결과 42');
  });

  it('keeps a card from pre-tool cumulative prose after the final answer', () => {
    const card = '```elanous-card\n{"kind":"coo-admin","items":[{"title":"배포 주소","due":null,"daysLeft":null,"state":"done","owner":"OP","url":"https://example.test"}]}\n```\n';
    const text = `${card}완료했습니다`;
    const html = render({ ...base, text, finalTextStart: card.length, blocks: [
      { kind: 'text', text },
      { kind: 'tool_use', id: 'check', name: 'Check', status: 'done' },
    ] });
    expect(html.split('<details')[0]).toContain('완료했습니다');
    expect(html.split('<details')[0]).toContain('data-elanous-card-kind="coo-admin"');
    expect(html.split('<details')[0]).not.toContain('```elanous-card');
  });

  it('retains a card from an interrupted cumulative response', () => {
    const card = '```elanous-card\n{"kind":"coo-admin","items":[{"title":"배포 주소","due":null,"daysLeft":null,"state":"done","owner":"OP"}]}\n```';
    const html = render({ ...base, text: card, incomplete: true, meta: { stopReason: 'aborted' }, blocks: [{ kind: 'text', text: card }] });
    expect(html.split('<details')[0]).toContain('data-elanous-card-kind="coo-admin"');
    expect(html.split('<details')[0]).not.toContain('```elanous-card');
  });

  it('shows user speech as written', () => {
    const html = render({ ...base, role: 'user', text: 'Search를 실행해 줘' });
    expect(html).toContain('Search를 실행해 줘');
    expect(html).not.toContain('<details');
  });
});
