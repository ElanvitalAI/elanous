// OP-LONG-SESSION-COMPACT (O4) — what is still open survives a compaction: the summary asks for it, and a promise that
// lives only in a tool call (ScheduleWakeup reason · `eln msg post`) reaches the summarizer at all.
import { describe, expect, test } from 'bun:test';
import { buildCompactTranscript, getCompactSystemPrompt } from '../../src/compact/index.js';
import { COMPACT_TOOL_CALL_ARGS_MAX } from '../../src/compact/summarize.js';
import type { LLMMessage } from '../../src/llm.js';

describe('O4 — the compaction summary keeps open work and promises', () => {
  test('the summary template asks for in-progress work and open commitments (what · to whom · by when)', () => {
    const prompt = getCompactSystemPrompt();
    expect(prompt).toContain('## In progress / next steps');
    expect(prompt).toContain('## Commitments');
    expect(prompt).toContain('what · to whom (the user, a seat, a PR) · by when');
    expect(prompt.indexOf('## Accomplished')).toBeLessThan(prompt.indexOf('## In progress / next steps'));
  });

  test('a promise made only through tool calls reaches the summarizer; tool results stay out', () => {
    const history: LLMMessage[] = [
      { role: 'user', content: 'C3 끝나면 TC 에 보고하고 03:30 에 다시 점검해' },
      { role: 'assistant', content: [
        { type: 'text', text: '예약하고 보고합니다.' },
        { type: 'tool_use', id: 't1', name: 'ScheduleWakeup', input: { reason: 'JUD-B 03:30 capsule check', at: '03:30' } },
        { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'eln msg post --from TC-H-CC-4 --to TC --kind report --body "C3 PR #38589 ready"' } },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'scheduled w1 '.repeat(500) }] },
    ];
    const transcript = buildCompactTranscript(history);
    expect(transcript).toContain('ASSISTANT: 예약하고 보고합니다.\n[tool ScheduleWakeup] {"reason":"JUD-B 03:30 capsule check","at":"03:30"}');
    expect(transcript).toContain('[tool Bash] {"command":"eln msg post --from TC-H-CC-4 --to TC --kind report --body \\"C3 PR #38589 ready\\""}');
    expect(transcript).not.toContain('scheduled w1');
  });

  test('a long tool argument is cut at the cap with an ellipsis', () => {
    const transcript = buildCompactTranscript([{ role: 'assistant', content: [
      { type: 'tool_use', id: 't', name: 'Write', input: { content: 'x'.repeat(5_000) } },
    ] }]);
    const line = transcript.replace('ASSISTANT: ', '');
    // 출처: #38604 — the rendered line is the tool tag plus at most the cap of argument text plus the ellipsis
    expect(line.length).toBe('[tool Write] '.length + COMPACT_TOOL_CALL_ARGS_MAX + 1);
    expect(line.endsWith('…')).toBe(true);
  });

  test('JUD #38613 ⓒ — secrets in tool arguments never reach the summarizer (it is written to disk)', () => {
    const transcript = buildCompactTranscript([{ role: 'assistant', content: [
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'curl -H "Authorization: Bearer abcdefghijklmnop1234" https://api.example.test/v1' } },
      { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'GH_TOKEN=abcd1234efgh5678wxyz gh pr view 1' } },
      { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'git clone https://deploy:hunter2plainpass@git.example.test/repo.git' } },
    ] }]);
    expect(transcript).not.toContain('abcdefghijklmnop1234');
    expect(transcript).not.toContain('abcd1234efgh5678wxyz');
    expect(transcript).not.toContain('hunter2plainpass');
    expect(transcript).toContain('[tool Bash] {"command":"curl -H \\"Authorization: Bearer ***\\" https://api.example.test/v1"}');
    expect(transcript).toContain('https://***@git.example.test/repo.git');
  });

  test('JUD #38613 ⓒ-2 — a secret at the start of a later line of a multi-line command (export · heredoc) is redacted too', () => {
    const openaiLike = ['sk', 'x'.repeat(24)].join('-'); // built at run time: no key-shaped literal in this file
    const transcript = buildCompactTranscript([{ role: 'assistant', content: [
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'set -e\nSERVICE_TOKEN=abcd1234efgh5678wxyz ./deploy.sh\nexport DEPLOY_API_KEY=qwer5678tyui1234zz' } },
      { type: 'tool_use', id: 't2', name: 'Bash', input: { command: `cat > .env <<'EOF'\n${openaiLike}\nEOF` } },
    ] }]);
    expect(transcript).not.toContain('abcd1234efgh5678wxyz');
    expect(transcript).not.toContain('qwer5678tyui1234zz');
    expect(transcript).not.toContain('x'.repeat(24));
    expect(transcript).toContain('SERVICE_TOKEN=***');
    expect(transcript).toContain('DEPLOY_API_KEY=***');
  });
});
