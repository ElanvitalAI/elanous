import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { extractMermaidBlocks, parseMermaidBlocks, replaceFailedMermaidBlocks } from './mermaid-parse.js';

const original = readFileSync(new URL('./fixtures/arch-render-ux-0439ec6f.md', import.meta.url), 'utf8');
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const quoted = (code: string): string => code.replace(/ : (포함|예매)(?=\n|$)/gu, ' : "$1"');

test('unchanged UX fixture exposes the ERD grammar failure and two unquoted-label policy failures', async () => {
  expect(sha(original)).toBe('0439ec6fcc6de53626599e336ded2bc6e617eba773da67b415d68105c1f2c875');
  const blocks = extractMermaidBlocks(original);
  expect(blocks.map(block => block.kind)).toEqual(['flowchart', 'erDiagram', 'sequenceDiagram']);
  expect(await parseMermaidBlocks(blocks)).toEqual([
    { index: 0, kind: 'flowchart', sourceSha256: blocks[0]!.sourceSha256, code: 'MERMAID_LABEL_POLICY_ERROR' },
    { index: 1, kind: 'erDiagram', sourceSha256: blocks[1]!.sourceSha256, code: 'MERMAID_PARSE_ERROR' },
    { index: 2, kind: 'sequenceDiagram', sourceSha256: blocks[2]!.sourceSha256, code: 'MERMAID_LABEL_POLICY_ERROR' },
  ]);
});

test('valid Mermaid syntax still rejects unquoted Korean labels and accepts quoted labels and comments', async () => {
  const markdown = [
    '```mermaid\nflowchart LR\n U[관람객]-->API\n```',
    '```mermaid\nsequenceDiagram\n participant U as 관람객\n U->>API: 예약 요청\n```',
    '```mermaid\nflowchart LR\n U["관람객"]-->API\n %% 한국어 설명\n```',
    '```mermaid\nsequenceDiagram\n participant U as "관람객"\n U->>API: "예약 요청"\n```',
  ].join('\n');
  const blocks = extractMermaidBlocks(markdown);
  expect(await parseMermaidBlocks(blocks)).toEqual(blocks.slice(0, 2).map(block => ({
    index: block.index, kind: block.kind, sourceSha256: block.sourceSha256,
    code: 'MERMAID_LABEL_POLICY_ERROR',
  })));
});

test('Mermaid-accepted quoted Unicode identifiers still violate the ASCII identifier contract', async () => {
  for (const code of [
    'sequenceDiagram\n participant "관람객"\n "관람객"->>API: hi',
    'erDiagram\n "관람객" ||--o{ SEAT : has',
    'erDiagram\n "관람객: VIP" ||--o{ SEAT : has',
  ]) {
    const block = extractMermaidBlocks(`\`\`\`mermaid\n${code}\n\`\`\``)[0]!;
    expect(await parseMermaidBlocks([block])).toEqual([{
      index: 0, kind: block.kind, sourceSha256: block.sourceSha256, code: 'MERMAID_LABEL_POLICY_ERROR',
    }]);
  }
});

test.each(['--x', '-->>', '-)', '--)', '->>', '->', '-x', '-->>+'])(
  'Mermaid sequence arrow %s rejects a quoted Unicode endpoint identifier', async arrow => {
    const block = extractMermaidBlocks(`\`\`\`mermaid\nsequenceDiagram\n A${arrow}"관람객": hi\n\`\`\``)[0]!;
    expect(await parseMermaidBlocks([block])).toEqual([{
      index: 0, kind: 'sequenceDiagram', sourceSha256: block.sourceSha256,
      code: 'MERMAID_LABEL_POLICY_ERROR',
    }]);
  },
);

test('sequence colon IDs fail while quoted display labels and captions remain valid', async () => {
  const colonId = extractMermaidBlocks('```mermaid\nsequenceDiagram\n A--x"관람객: VIP": hi\n```')[0]!;
  expect(await parseMermaidBlocks([colonId])).toEqual([{
    index: 0, kind: 'sequenceDiagram', sourceSha256: colonId.sourceSha256,
    code: 'MERMAID_LABEL_POLICY_ERROR',
  }]);
  const allowed = extractMermaidBlocks('```mermaid\nsequenceDiagram\n participant U as "관람객: VIP"\n U--xAPI: "오류"\n```');
  expect(await parseMermaidBlocks(allowed)).toEqual([]);
  const caption = extractMermaidBlocks('```mermaid\nsequenceDiagram\n alt "예매 실패":\n A->>B: "오류"\n end\n```');
  expect(await parseMermaidBlocks(caption)).toEqual([]);
  const activation = extractMermaidBlocks('```mermaid\nsequenceDiagram\n activate "관람객"\n A->>B: hi\n```')[0]!;
  expect(await parseMermaidBlocks([activation])).toEqual([{
    index: 0, kind: 'sequenceDiagram', sourceSha256: activation.sourceSha256,
    code: 'MERMAID_LABEL_POLICY_ERROR',
  }]);
});

test('failed ERD body repair preserves valid blocks and all other document bytes', async () => {
  const before = extractMermaidBlocks(original);
  const corrected = quoted(before[1]!.code);
  const repaired = replaceFailedMermaidBlocks(original, [before[1]!], [{ index: 1, kind: 'erDiagram', code: corrected }]);
  expect(sha(repaired)).toBe('6403926d930542d542bc742dde5fd5cea859562ffc34a7f1114faa9ce77f0a95');
  expect(repaired.slice(0, before[1]!.begin)).toBe(original.slice(0, before[1]!.begin));
  expect(repaired.slice(before[1]!.begin + corrected.length)).toBe(original.slice(before[1]!.end));
  const after = extractMermaidBlocks(repaired);
  expect(after[0]!.sourceSha256).toBe(before[0]!.sourceSha256);
  expect(after[2]!.sourceSha256).toBe(before[2]!.sourceSha256);
  expect(await parseMermaidBlocks([after[1]!])).toEqual([]);
});

test('replacement count, index, grammar and second parse failure refuse advancement', async () => {
  const failed = extractMermaidBlocks(original)[1]!;
  const corrected = quoted(failed.code);
  expect(() => replaceFailedMermaidBlocks(original, [failed], [])).toThrow('MERMAID_REPLACEMENT_INVALID');
  expect(() => replaceFailedMermaidBlocks(original, [failed], [{ index: 0, kind: 'erDiagram', code: corrected }]))
    .toThrow('MERMAID_REPLACEMENT_INVALID');
  expect(() => replaceFailedMermaidBlocks(original, [failed], [{ index: 1, kind: 'flowchart', code: corrected }]))
    .toThrow('MERMAID_REPLACEMENT_INVALID');
  expect(() => replaceFailedMermaidBlocks(original, [failed], [{ index: 1, kind: 'erDiagram', code: 'flowchart LR\n A-->B' }]))
    .toThrow('MERMAID_REPLACEMENT_INVALID');
  const unchanged = replaceFailedMermaidBlocks(original, [failed], [{ index: 1, kind: 'erDiagram', code: failed.code }]);
  expect((await parseMermaidBlocks([extractMermaidBlocks(unchanged)[1]!])).map(issue => issue.index)).toEqual([1]);
});

test('repair rejects a closing fence that moves injected prose outside the failed diagram', async () => {
  const failed = extractMermaidBlocks(original)[1]!;
  const escaped = 'erDiagram\n RECORD {\n string id PK\n }\n```\nInjected prose\n```text\nplaceholder';
  const forged = original.slice(0, failed.begin) + escaped + original.slice(failed.end);
  const parsed = extractMermaidBlocks(forged);
  expect(parsed).toHaveLength(3);
  expect(parsed[1]!.code).not.toBe(escaped);
  expect(await parseMermaidBlocks([parsed[1]!])).toEqual([]);
  expect(() => replaceFailedMermaidBlocks(original, [failed], [{ index: 1, kind: 'erDiagram', code: escaped }]))
    .toThrow('MERMAID_REPLACEMENT_INVALID');
});

test('CRLF and indented Mermaid fences preserve unrelated prose', async () => {
  const crlf = original.replaceAll('\n', '\r\n');
  const failed = extractMermaidBlocks(crlf)[1]!;
  const result = replaceFailedMermaidBlocks(crlf, [failed], [{ index: 1, kind: 'erDiagram', code: quoted(failed.code.replaceAll('\r\n', '\n')) }]);
  expect(result.slice(0, failed.begin)).toBe(crlf.slice(0, failed.begin));
  expect((await parseMermaidBlocks([extractMermaidBlocks(result)[1]!]))).toEqual([]);
  const indented = 'Before\n  ```mermaid\n  erDiagram\n   A ||--o{ B : 포함\n  ```\nAfter';
  const block = extractMermaidBlocks(indented)[0]!;
  const fixed = replaceFailedMermaidBlocks(indented, [block], [{ index: 0, kind: 'erDiagram', code: quoted(block.code) }]);
  expect(fixed).toContain('\nAfter');
  expect(await parseMermaidBlocks(extractMermaidBlocks(fixed))).toEqual([]);
});

test('abort refuses parser work and does not return a success result', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(parseMermaidBlocks(extractMermaidBlocks(original), controller.signal))
    .rejects.toThrow('MERMAID_PARSE_ABORTED');
});

test('owned parser Worker times out when ready but not responding', async () => {
  const blocks = extractMermaidBlocks(original);
  await expect(parseMermaidBlocks([blocks[0]!], undefined, {
    workerUrl: new URL('./fixtures/mermaid-never-worker.ts', import.meta.url), deadlineMs: 30,
  })).rejects.toThrow('MERMAID_PARSE_TIMEOUT');
});

test('malformed Worker result protocol fails closed', async () => {
  for (const marker of ['PROTOCOL_BAD_BOOL', 'PROTOCOL_BAD_DIAG']) {
    const blocks = extractMermaidBlocks(`\`\`\`mermaid\nflowchart LR\n A-->${marker}\n\`\`\``);
    await expect(parseMermaidBlocks(blocks, undefined, {
      workerUrl: new URL('./fixtures/mermaid-never-worker.ts', import.meta.url),
    })).rejects.toThrow('MERMAID_PARSE_PROTOCOL_ERROR');
  }
});
