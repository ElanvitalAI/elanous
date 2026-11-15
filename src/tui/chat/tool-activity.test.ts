import { expect, test } from 'bun:test';
import { safeToolTarget, toolActivityTarget, toolActivityLines, updateToolActivity, safeCommandSummary } from './tool-activity.js';

test('Write activity shows a basename and elapsed time before completion without exposing contents', () => {
  const target = toolActivityTarget('Write', { file_path: '/tmp/demo/ticketing.html', content: 'PRIVATE-document-body' });
  let rows = updateToolActivity([], { phase: 'start', id: 'write', name: 'Write', target }, 1000);
  expect(toolActivityLines(rows, 9500)).toEqual(['활동 · Write · ticketing.html · 실행 중 · 8초']);
  rows = updateToolActivity(rows, { phase: 'finish', id: 'write', name: 'Write' }, 10000);
  expect(toolActivityLines(rows, 20000)).toEqual(['활동 · Write · ticketing.html · 완료 · 9초']);
  expect(JSON.stringify(rows)).not.toContain('PRIVATE-document-body');
  expect(JSON.stringify(rows)).not.toContain('/tmp/demo');
});

test('private targets, unknown internal tool names and shell arguments stay hidden', () => {
  expect(safeToolTarget('/private/secrets.json')).toBe('(비공개 파일)');
  expect(toolActivityTarget('Bash', { command: 'PRIVATE-command', path: '/tmp/anything' })).toBe('(비공개 명령)');
  const rows = updateToolActivity([], { phase: 'start', id: 'private', name: 'PRIVATE-tool-diagnostic', target: 'PRIVATE-file' }, 0);
  expect(toolActivityLines(rows, 1000)).toEqual(['활동 · 도구 · 실행 중 · 1초']);
  expect(safeToolTarget('C:\\demo\\ticketing.html')).toBe('ticketing.html');
});

test('snapshot preserves running-call elapsed time and removes stale calls', () => {
  const started = updateToolActivity([], { phase: 'start', id: 'read', name: 'Read', target: 'guide.md' }, 1000);
  const snapshot = updateToolActivity(started, { phase: 'snapshot', calls: [{ id: 'read', name: 'Read', target: 'guide.md' }] }, 4000);
  expect(toolActivityLines(snapshot, 6000)).toEqual(['활동 · Read · guide.md · 실행 중 · 5초']);
  expect(updateToolActivity(snapshot, { phase: 'snapshot', calls: [] }, 7000)).toEqual([]);
});

test('actual native and capability names remain detailed while shell values and home paths are hidden', () => {
  expect(toolActivityTarget('write_file', { path: '/Users/synthetic/demo/page.html' })).toBe('page.html');
  const command = safeCommandSummary('bun test /Users/synthetic/project/demo.test.ts --token=fixture-sensitive');
  expect(command).toBe('(비공개 명령)');
  expect(safeCommandSummary('bun test /Users/synthetic/project/demo.test.ts')).toBe('bun test ./demo.test.ts');
  expect(safeCommandSummary('echo "fixture-sensitive"')).toBe('echo [인자]');
  expect(safeCommandSummary('cd /Users/synthetic')).not.toContain('synthetic');
  expect(safeToolTarget('/home/synthetic')).toBe('~');
  expect(safeCommandSummary('curl https://example.test/path')).not.toContain('example.test');
  const rows = updateToolActivity([], { phase: 'start', id: 'publish', name: 'app.publish@1' }, 0);
  expect(toolActivityLines(rows, 1000)[0]).toContain('app.publish@1');
});

test('completion keeps start order and snapshots preserve completed log rows within the bounded tail', () => {
  let rows = updateToolActivity([], { phase: 'start', id: 'a', name: 'read_file', target: 'a.md' }, 0);
  rows = updateToolActivity(rows, { phase: 'start', id: 'b', name: 'Bash', target: 'bun test' }, 1000);
  rows = updateToolActivity(rows, { phase: 'finish', id: 'a', name: 'read_file' }, 2000);
  expect(rows.map(row => row.id)).toEqual(['a', 'b']);
  rows = updateToolActivity(rows, { phase: 'snapshot', calls: [{ id: 'b', name: 'Bash' }] }, 3000);
  expect(toolActivityLines(rows, 4000)).toEqual([
    '활동 · read_file · a.md · 완료 · 2초',
    '활동 · Bash · bun test · 실행 중 · 3초',
  ]);
  // Source: OP47767 recent twelve-line log bound.
  for (let i = 0; i < 20; i++) rows = updateToolActivity(rows, { phase: 'start', id: 'extra-' + i, name: 'Read' }, i);
  expect(rows).toHaveLength(12);
  expect(rows[0]?.id).toBe('extra-8');
});

test('credential basenames stay private through tool calls, JSONL round trips and rendered activity', () => {
  const filenames = ['.netrc', '.npmrc', '.pypirc', 'private-key.pem', 'server.KEY', 'client.pem.bak',
    '.npmrc_backup', '.netrc_backup', '.pypirc_backup', 'private-key.pem_backup', 'server.key_backup',
    '.env', '.env.production', 'id_rsa.pub', 'id_ed25519', 'credentials.json', 'secrets.yaml', 'auth.json'];
  for (const filename of filenames) {
    const target = toolActivityTarget('Read', { file_path: '/synthetic/' + filename, content: 'synthetic-private-body' });
    expect(target).toBe('(비공개 파일)');
    const wire = JSON.stringify({ phase: 'start', id: 'synthetic', name: 'Read', target });
    expect(wire).not.toContain(filename);
    expect(wire).not.toContain('synthetic-private-body');
    const rows = updateToolActivity([], JSON.parse(wire), 0);
    expect(toolActivityLines(rows, 1000)).toEqual(['활동 · Read · (비공개 파일) · 실행 중 · 1초']);
    expect(safeCommandSummary('cat /synthetic/' + filename)).not.toContain(filename);
    const snapshot = updateToolActivity([], { phase: 'snapshot',
      calls: [{ id: 'snapshot', name: 'Read', target: filename }] }, 0);
    expect(toolActivityLines(snapshot, 1000)).toEqual(['활동 · Read · (비공개 파일) · 실행 중 · 1초']);
  }
  expect(safeToolTarget('C:\\synthetic\\.npmrc')).toBe('(비공개 파일)');
  expect(toolActivityTarget('Write', { file_path: '/synthetic/ticketing.ts' })).toBe('ticketing.ts');
  expect(safeCommandSummary('bun test /synthetic/ticketing.test.ts')).toBe('bun test ./ticketing.test.ts');
});

test('shell summaries hide arbitrary dotted values, emails and URLs while retaining local path basenames', () => {
  for (const value of ['alice@example.com', 'https://example.test/path', 'example.com', 'opaque.value']) {
    expect(safeCommandSummary('echo ' + value)).toBe('echo [인자]');
  }
  expect(safeCommandSummary('cat ./demo/page.html')).toBe('cat ./page.html');
  expect(safeCommandSummary('cat ../demo/page.html')).toBe('cat ./page.html');
  expect(safeCommandSummary('cat /synthetic/page.html')).toBe('cat ./page.html');
});
test('late completions outside the retained start-order tail cannot evict recent calls', () => {
  let rows: ReturnType<typeof updateToolActivity> = [];
  // OP47767 twelve retained calls; one extra start evicts the first.
  for (let i = 0; i < 13; i++) rows = updateToolActivity(rows,
    { phase: 'start', id: 'call-' + i, name: 'Read', target: 'page.html' }, i);
  const before = rows.map(row => ({ ...row }));
  rows = updateToolActivity(rows, { phase: 'finish', id: 'call-0', name: 'Read' }, 1000);
  expect(rows).toEqual(before);
  const startOrder = rows.map(row => row.id);
  for (const row of [...rows].reverse()) rows = updateToolActivity(rows,
    { phase: 'finish', id: row.id, name: 'Read' }, 2000);
  expect(rows.map(row => row.id)).toEqual(startOrder);
  expect(rows.every(row => row.finishedAt === 2000)).toBe(true);
});

test('safe local shell basename survives repeated transport projection without reopening dotted values', () => {
  const target = toolActivityTarget('Bash', { command: 'bun test /tmp/synthetic/second.test.ts' });
  expect(target).toBe('bun test ./second.test.ts');
  expect(safeCommandSummary(target)).toBe(target);
  const transported = JSON.parse(JSON.stringify({ phase: 'start', id: 'shell', name: 'Bash', target }));
  const rows = updateToolActivity([], transported, 0);
  expect(toolActivityLines(rows, 1000)).toEqual(['활동 · Bash · bun test second.test.ts · 실행 중 · 1초']);
  expect(safeCommandSummary('echo alice@example.com')).toBe('echo [인자]');
  expect(safeCommandSummary('echo opaque.value')).toBe('echo [인자]');
});

test('private file placeholder remains atomic through repeated shell projection and final render', () => {
  for (const filename of ['.netrc', '.npmrc', '.pypirc']) {
    let target = safeCommandSummary('cat /synthetic/' + filename);
    expect(target).toBe('cat (비공개 파일)');
    target = safeCommandSummary(target);
    target = safeCommandSummary(target);
    expect(target).toBe('cat (비공개 파일)');
    const rows = updateToolActivity([], { phase: 'start', id: 'private-shell', name: 'Bash', target }, 0);
    expect(toolActivityLines(rows, 1000)).toEqual(['활동 · Bash · cat (비공개 파일) · 실행 중 · 1초']);
    expect(JSON.stringify(rows)).not.toContain(filename);
  }
});

// Source: NEXT-TUI-FRICTION-AUDIT-1115 item6; floor-to-zero hid a real subsecond call.
test('subsecond calls show a duration bound and completed times remain frozen', () => {
  const running = updateToolActivity([], { phase: 'start', id: 'quick', name: 'Read' }, 0);
  for (const elapsed of [0, 1, 999]) {
    expect(toolActivityLines(running, elapsed)).toEqual(['활동 · Read · 실행 중 · <1초']);
  }
  expect(toolActivityLines(running, 1000)).toEqual(['활동 · Read · 실행 중 · 1초']);
  const completed = updateToolActivity(running, { phase: 'finish', id: 'quick', name: 'Read' }, 999);
  expect(toolActivityLines(completed, 20000)).toEqual(['활동 · Read · 완료 · <1초']);
});
