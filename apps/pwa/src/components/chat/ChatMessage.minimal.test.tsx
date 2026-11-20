import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatMessageView } from './ChatMessage';
import type { ChatMessage } from '@/lib/chat-runtime';

const base = { id: 'fake-stream', role: 'assistant' as const, timestamp: 0 };

function render(message: ChatMessage): string {
  return renderToStaticMarkup(<ChatMessageView message={message} minimal />);
}
/** The folded details' label as text (tags dropped). */
const summaryText = (html: string) => (html.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1] ?? '').replace(/<[^>]+>/g, '');

describe('minimal chat fake stream', () => {
  it('streaming early answer lands in the body; the capsule holds only the process (MOB-1 P1)', () => {
    const html = render({ ...base, text: '초기 답: 메모리 호황 지속.', streaming: true, finalTextStart: 0, blocks: [
      { kind: 'text', text: '초기 답: 메모리 호황 지속.' },
      { kind: 'tool_use', id: 't1', name: 'web_search', status: 'running', startedAt: 0 },
    ] });
    const [body, capsule = ''] = html.split('<details');
    expect(body).toContain('초기 답: 메모리 호황 지속.');
    expect(capsule).not.toContain('초기 답');
    expect(capsule).toContain('web_search');
  });
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
    expect(summaryText(html)).toBe('⋯1 step· Search');
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
    expect(summaryText(html)).toBe('▸1 step');
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

  it('shows a card from a text-only streaming placeholder; without a known segment start (SSE) the prose stays folded', () => {
    const card = '```elanous-card\n{"kind":"coo-admin","items":[{"title":"배포 주소","due":null,"daysLeft":null,"state":"done","owner":"OP"}]}\n```';
    const html = render({ ...base, text: `확인 중…\n${card}`, streaming: true });
    expect(html.split('<details')[0]).toContain('data-elanous-card-kind="coo-admin"');
    expect(html.split('<details')[0]).not.toContain('확인 중');
  });

  it('shows the answer as it is written when the runtime gives the segment start (ACP, from the first delta)', () => {
    const html = render({ ...base, text: '바다는 넓고', streaming: true, finalTextStart: 0 });
    expect(html.split('<details')[0]).toContain('바다는 넓고');
  });

  it('streams the text after the last tool call while narration before it stays in the capsule', () => {
    const text = '파일을 찾아볼게요.\n세 개 있습니다: a, b';
    const html = render({ ...base, text, streaming: true, finalTextStart: '파일을 찾아볼게요.\n'.length, blocks: [
      { kind: 'text', text },
      { kind: 'tool_use', id: 'ls', name: 'list_files', status: 'done' },
    ] });
    expect(html.split('<details')[0]).toContain('세 개 있습니다');
    expect(html.split('<details')[0]).not.toContain('파일을 찾아볼게요');
    expect(html).toContain('파일을 찾아볼게요');
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

  it('folds the agent\'s steps into one «n steps» capsule under the final answer (WEB-CHAT-ENCAPSULATED-STEPS)', () => {
    const tools = ['Read', 'Grep', 'Edit'].map((name, index) => ({ kind: 'tool_use' as const, id: `t${index}`, name, status: 'done' as const, args: { path: `src/${name}.ts` } }));
    const html = render({ ...base, text: '중간 설명\n최종 답입니다.', finalTextStart: 6, blocks: [
      { kind: 'text', text: '중간 설명' }, ...tools, { kind: 'agent_plan', blockId: 'plan-1', ref: 'plan', steps: [{ text: 'edit', status: 'done' }] },
    ] } as ChatMessage);
    const [answer, capsule] = html.split('<details');
    // The final answer is outside the capsule; the steps are not.
    expect(answer).toContain('최종 답입니다.');
    for (const name of ['Read', 'Grep', 'Edit', '중간 설명']) expect(answer).not.toContain(name);
    expect(capsule).toContain('data-elanous-steps-capsule=""');
    expect(capsule).toContain('data-elanous-step-count="3"');
    expect(summaryText(html)).toBe('▸3 steps');
    // Folded by default; inside it, every step in order first, then the interim text and the plan.
    expect(capsule.split('>')[0]).not.toContain(' open');
    const inside = capsule.split('</summary>')[1] ?? '';
    expect([...inside.matchAll(/data-elanous-tool-name="([^"]+)"/g)].map((match) => match[1])).toEqual(['Read', 'Grep', 'Edit']);
    const lastStep = inside.indexOf('data-elanous-tool-name="Edit"');
    expect(inside.indexOf('중간 설명')).toBeGreaterThan(lastStep);
    expect(inside.indexOf('data-elanous-block-kind="agent_plan"')).toBeGreaterThan(lastStep);
  });

  it('names the step running now while the answer streams, and keeps «자세히» when there were no tool steps', () => {
    const live = render({ ...base, text: '확인 중…', streaming: true, blocks: [
      { kind: 'tool_use', id: 'a', name: 'Read', status: 'done' },
      { kind: 'tool_use', id: 'b', name: 'Bash', status: 'running' },
    ] });
    expect(summaryText(live)).toBe('⋯2 steps· Bash');
    const plain = render({ ...base, text: '최종 답', finalTextStart: 0, blocks: [{ kind: 'agent_status', blockId: 's', agentId: 'agent', status: 'done' }] } as ChatMessage);
    expect(summaryText(plain)).toBe('자세히');
    expect(plain).not.toContain('data-elanous-steps-capsule');
  });

  it('keeps the raw debug log one fold deeper inside the steps capsule', () => {
    const html = render({ ...base, text: '최종 답', finalTextStart: 0, blocks: [
      { kind: 'tool_use', id: 'a', name: 'Read', status: 'done' },
      { kind: 'debug_session', blockId: 'debug-1', lines: [{ seq: 1, category: 'chat.tool-result', event: 'Read' }] },
    ] } as unknown as ChatMessage);
    const capsule = html.split('data-elanous-steps-capsule')[1] ?? '';
    // Inside the capsule the step comes before a closed «Debug log (1)» fold that holds the raw lines.
    expect(capsule.indexOf('data-elanous-tool-name="Read"')).toBeLessThan(capsule.indexOf('data-elanous-debug-log'));
    const debug = capsule.split('data-elanous-debug-log')[1] ?? '';
    expect(debug.split('>')[0]).not.toContain(' open');
    expect(debug).toMatch(/<summary[^>]*>Debug log \(<!-- -->1<!-- -->\)<\/summary>|<summary[^>]*>Debug log \(1\)<\/summary>/);
    expect(debug).toContain('chat.tool-result');
  });
});
