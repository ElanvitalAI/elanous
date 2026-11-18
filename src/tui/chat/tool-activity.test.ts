import { expect, test } from 'bun:test';
import { REDACTED, safeAgentDescription, safeAgentSummary, TOOL_RUNNING_GLYPH, TOOL_DONE_GLYPH, TOOL_FOLD_MIN_RUN, isToolActivityLine, safeToolTarget, toolActivityTarget, toolActivityLines, updateToolActivity, safeCommandSummary, interleavedTurnLines } from './tool-activity.js';

const R = TOOL_RUNNING_GLYPH;
const D = TOOL_DONE_GLYPH;

test('Write activity shows a basename and elapsed time before completion without exposing contents', () => {
  const target = toolActivityTarget('Write', { file_path: '/tmp/demo/ticketing.html', content: 'PRIVATE-document-body' });
  let rows = updateToolActivity([], { phase: 'start', id: 'write', name: 'Write', target }, 1000);
  expect(toolActivityLines(rows, 9500)).toEqual([`${R} Write(ticketing.html) 8s`]);
  rows = updateToolActivity(rows, { phase: 'finish', id: 'write', name: 'Write' }, 10000);
  expect(toolActivityLines(rows, 20000)).toEqual([`${D} Write(ticketing.html) 9s`]);
  expect(JSON.stringify(rows)).not.toContain('PRIVATE-document-body');
  expect(JSON.stringify(rows)).not.toContain('/tmp/demo');
});

test('private targets, unknown internal tool names and shell arguments stay hidden', () => {
  expect(safeToolTarget('/private/secrets.json')).toBe('(private file)');
  expect(toolActivityTarget('Bash', { command: 'PRIVATE-command', path: '/tmp/anything' })).toBe('(private command)');
  const rows = updateToolActivity([], { phase: 'start', id: 'private', name: 'PRIVATE-tool-diagnostic', target: 'PRIVATE-file' }, 0);
  expect(toolActivityLines(rows, 1000)).toEqual([`${R} Tool 1s`]);
  expect(safeToolTarget('C:\\demo\\ticketing.html')).toBe('ticketing.html');
});

test('snapshot preserves running-call elapsed time and removes stale calls', () => {
  const started = updateToolActivity([], { phase: 'start', id: 'read', name: 'Read', target: 'guide.md' }, 1000);
  const snapshot = updateToolActivity(started, { phase: 'snapshot', calls: [{ id: 'read', name: 'Read', target: 'guide.md' }] }, 4000);
  expect(toolActivityLines(snapshot, 6000)).toEqual([`${R} Read(guide.md) 5s`]);
  expect(updateToolActivity(snapshot, { phase: 'snapshot', calls: [] }, 7000)).toEqual([]);
});

test('actual native and capability names remain detailed while shell values and home paths are hidden', () => {
  expect(toolActivityTarget('write_file', { path: '/Users/synthetic/demo/page.html' })).toBe('page.html');
  const command = safeCommandSummary('bun test /Users/synthetic/project/demo.test.ts --token=fixture-sensitive');
  expect(command).toBe('bun test ./demo.test.ts …');
  expect(safeCommandSummary('bun test /Users/synthetic/project/demo.test.ts')).toBe('bun test ./demo.test.ts');
  expect(safeCommandSummary('echo "fixture-sensitive"')).toBe(`echo ${REDACTED}`);
  expect(safeCommandSummary('cd /Users/synthetic')).not.toContain('synthetic');
  expect(safeToolTarget('/home/synthetic')).toBe('~');
  expect(safeCommandSummary('curl https://example.test/path')).toBe(`curl ${REDACTED}`);
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
    `${D} read_file(a.md) 2s`,
    `${R} Bash(bun test) 3s`,
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
    expect(target).toBe('(private file)');
    const wire = JSON.stringify({ phase: 'start', id: 'synthetic', name: 'Read', target });
    expect(wire).not.toContain(filename);
    expect(wire).not.toContain('synthetic-private-body');
    const rows = updateToolActivity([], JSON.parse(wire), 0);
    expect(toolActivityLines(rows, 1000)).toEqual([`${R} Read((private file)) 1s`]);
    expect(safeCommandSummary('cat /synthetic/' + filename)).not.toContain(filename);
    const snapshot = updateToolActivity([], { phase: 'snapshot',
      calls: [{ id: 'snapshot', name: 'Read', target: filename }] }, 0);
    expect(toolActivityLines(snapshot, 1000)).toEqual([`${R} Read((private file)) 1s`]);
  }
  expect(safeToolTarget('C:\\synthetic\\.npmrc')).toBe('(private file)');
  expect(toolActivityTarget('Write', { file_path: '/synthetic/ticketing.ts' })).toBe('ticketing.ts');
  expect(safeCommandSummary('bun test /synthetic/ticketing.test.ts')).toBe('bun test ./ticketing.test.ts');
});

test('shell summaries show only the allow-list: command name, known sub-command, flag names, path basenames', () => {
  expect(safeCommandSummary('git status')).toBe('git status');
  expect(safeCommandSummary('bun test src/tui/x.test.ts --timeout 5000')).toBe(`bun test ./x.test.ts --timeout ${REDACTED}`);
  expect(safeCommandSummary('gh pr view 38032 --json state')).toBe(`gh pr ${REDACTED} ${REDACTED} --json ${REDACTED}`);
  // Everything else is the English mark: quotes, URLs, positional values, name=value, numbers, e-mail.
  for (const command of ['echo alice@example.com', 'echo "short value"', 'echo opaque.value', 'curl https://user:pw@host.test/x',
    'curl "https://h.test/p?api_key=abcd1234"']) {
    expect(safeCommandSummary(command)).toBe(`${command.split(' ')[0]} ${REDACTED}`);
  }
  expect(safeCommandSummary('mytool --password hunter2 run')).toBe(`mytool --password ${REDACTED} ${REDACTED}`);
  expect(safeCommandSummary('export OPENAI_API_KEY=sk-abcdefghijklmnop')).toBe(`export ${REDACTED}`);
  // Local path arguments keep only a safe basename.
  expect(safeCommandSummary('cat ./demo/page.html')).toBe('cat ./page.html');
  expect(safeCommandSummary('cat ../demo/page.html')).toBe('cat ./page.html');
  expect(safeCommandSummary('cat /synthetic/page.html')).toBe('cat ./page.html');
  // No Korean placeholder is left in a projected command.
  expect(safeCommandSummary('echo alice@example.com --token x')).not.toMatch(/[가-힣]/u);
});

test('the secret mark is stable under repeated projection', () => {
  for (const command of ['bun test /x/y/second.test.ts --token=abc', 'mytool --password hunter2 run', 'curl https://user:pw@host.test/x']) {
    const once = safeCommandSummary(command)!;
    expect(safeCommandSummary(once)).toBe(once);
  }
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
  expect(toolActivityLines(rows, 1000)).toEqual([`${R} Bash(bun test second.test.ts) 1s`]);
  expect(safeCommandSummary('echo alice@example.com')).toBe(`echo ${REDACTED}`);
  expect(safeCommandSummary('echo opaque.value')).toBe(`echo ${REDACTED}`);
});

test('private file placeholder remains atomic through repeated shell projection and final render', () => {
  for (const filename of ['.netrc', '.npmrc', '.pypirc']) {
    let target = safeCommandSummary('cat /synthetic/' + filename);
    expect(target).toBe('cat (private file)');
    target = safeCommandSummary(target);
    target = safeCommandSummary(target);
    expect(target).toBe('cat (private file)');
    const rows = updateToolActivity([], { phase: 'start', id: 'private-shell', name: 'Bash', target }, 0);
    expect(toolActivityLines(rows, 1000)).toEqual([`${R} Bash(cat (private file)) 1s`]);
    expect(JSON.stringify(rows)).not.toContain(filename);
  }
});

// Source: NEXT-TUI-FRICTION-AUDIT-1115 item6; floor-to-zero hid a real subsecond call.
test('subsecond calls show a duration bound and completed times remain frozen', () => {
  const running = updateToolActivity([], { phase: 'start', id: 'quick', name: 'Read' }, 0);
  for (const elapsed of [0, 1, 999]) {
    expect(toolActivityLines(running, elapsed)).toEqual([`${R} Read`]);
  }
  expect(toolActivityLines(running, 1000)).toEqual([`${R} Read 1s`]);
  const completed = updateToolActivity(running, { phase: 'finish', id: 'quick', name: 'Read' }, 999);
  expect(toolActivityLines(completed, 20000)).toEqual([`${D} Read`]);
});

test('NEXT-TUI-TOOL-LOG-NOT-PINNED: tool rows sit at their text offset in one chronological flow', () => {
  const rows = [{ id: 'b', name: 'Read', target: 'b.txt', startedAt: 0, finishedAt: 0 },
    { id: 'a', name: 'Write', target: 'a.txt', startedAt: 0 }];
  const text = 'first\nsecond\n';
  const lines = interleavedTurnLines(rows, new Map([['a', 6], ['b', 6]]), text, 0, (chunk) => ['T:' + chunk.trim()]);
  // Same offset keeps start order; text before the tools renders above, after them below.
  expect(lines).toEqual(['T:first', `${D} Read(b.txt)`, `${R} Write(a.txt)`, 'T:second']);
  // A tool without a recorded offset started after the text seen so far; an offset past a redacted preview is clamped.
  expect(interleavedTurnLines(rows, new Map([['b', 99]]), 'only\n', 0, (chunk) => ['T:' + chunk.trim()]))
    .toEqual(['T:only', `${D} Read(b.txt)`, `${R} Write(a.txt)`]);
});

test('consecutive finished calls of one tool fold into one «Name ×N» row; running rows and other tools do not fold', () => {
  const finished = (id: string, name: string, target: string) => ({ id, name, target, startedAt: 0, finishedAt: 0 });
  const run = Array.from({ length: TOOL_FOLD_MIN_RUN }, (_, index) => finished(`r${index}`, 'Read', `f${index}.ts`));
  expect(toolActivityLines(run, 1000)).toEqual([`${D} Read ×${TOOL_FOLD_MIN_RUN} · last f${TOOL_FOLD_MIN_RUN - 1}.ts`]);
  // One short of the threshold stays as individual rows.
  expect(toolActivityLines(run.slice(1), 1000)).toEqual(run.slice(1).map((row) => `${D} Read(${row.target})`));
  // A running call at the end of a run is never folded into it; a different tool breaks the run.
  const mixed = [...run, { id: 'w', name: 'Write', target: 'o.ts', startedAt: 0 }];
  expect(toolActivityLines(mixed, 1000)).toEqual([`${D} Read ×${TOOL_FOLD_MIN_RUN} · last f${TOOL_FOLD_MIN_RUN - 1}.ts`, `${R} Write(o.ts) 1s`]);
});

test('classic-style rows are English, glyph-led, and drop sub-second times', () => {
  const [row] = toolActivityLines([{ id: 'a', name: 'Read', target: 'msg-wake.ts', startedAt: 0, finishedAt: 400 }], 400);
  expect(row).toBe(`${D} Read(msg-wake.ts)`);
  expect(isToolActivityLine(row!)).toBe(true);
  expect(isToolActivityLine('활동 · Read')).toBe(false);
  expect(row).not.toMatch(/[가-힣]/u);
});

// Every leak the reviews found (#38033 rounds 1-3), now closed by construction: none of the secret texts may appear in the summary.
const LEAKS: Array<[string, string[]]> = [
  ['curl -u admin:pw https://x.test/a', ['admin', 'pw']],
  ['curl -uadmin:pw https://x.test', ['admin']],
  ['curl --user=a:b http://h', ['a:b']],
  ['docker login -u bob -p PW', ['bob', 'PW']],
  ['docker run -e DB_PASS=hunter2 -p 8080:80 nginx', ['hunter2']],
  ['redis-cli -a PW ping', ['PW']],
  ['sshpass -p PW ssh host', ['PW']],
  ['mysql -pPW db', ['PW']],
  ['mongosh -u root -p secret1', ['root', 'secret1']],
  ['aws configure set aws_secret_access_key AKIAXXXXXXXXXXXXXXXX', ['AKIAXXXXXXXXXXXXXXXX', 'aws_secret_access_key']],
  ['gh secret set TOKEN --body ghp_abcdefghijklmnopqrstu', ['ghp_abcdefghijklmnopqrstu', 'TOKEN']],
  ['export DB_PASS=hunter2', ['hunter2', 'DB_PASS']],
  ['DB_PASS=hunter2 bun test', ['hunter2', 'DB_PASS']],
  ['openssl enc -aes-256-cbc -pass pass:hunter2', ['hunter2']],
  ['http GET https://x.test Authorization:"Bearer abcd.efgh"', ['abcd.efgh', 'Bearer']],
  ['curl -H "Authorization: Basic dXNlcjpwYXNz" https://x.test', ['dXNlcjpwYXNz']],
  ['curl -H Authorization: Bearer sk-live-abc123 https://x.test', ['sk-live-abc123']],
  ['curl -H "Cookie: sessionid=abcd1234; theme=dark" https://x.test', ['abcd1234']],
  ['curl -H "X-Api-Key: tok_9f8e7d" https://x.test', ['tok_9f8e7d']],
  ['git remote add origin https://user:pw@host.test/r.git', ['user:pw']],
  ['echo hunter2 | tee out.txt', ['hunter2']],
];

test('allow-list summaries expose none of the secrets the reviews found, and stay stable when projected again', () => {
  for (const [command, secrets] of LEAKS) {
    const summary = safeCommandSummary(command) ?? '';
    for (const secret of secrets) expect(summary, command).not.toContain(secret);
    expect(safeCommandSummary(summary), command).toBe(summary);
  }
  const viaArgv = toolActivityTarget('Bash', { argv: ['curl', '-H', 'Authorization: Basic dXNlcjpwYXNz', 'https://x.test'] }) ?? '';
  expect(viaArgv).not.toContain('dXNlcjpwYXNz');
  expect(viaArgv.startsWith('curl')).toBe(true);
});

test('what stays readable is only structure the allow-list knows', () => {
  expect(safeCommandSummary('bun run build')).toBe('bun run build');
  expect(safeCommandSummary('bun run ./scripts/x.ts --flag')).toBe(`bun run ./x.ts --flag`);
  expect(safeCommandSummary('npm run deploy-prod')).toBe(`npm run ${REDACTED}`);
  expect(safeCommandSummary('git push -u origin main')).toBe(`git push -u ${REDACTED} ${REDACTED}`);
  expect(safeCommandSummary('mysql -p db')).toBe(`mysql -p ${REDACTED}`);
  expect(safeCommandSummary('docker run -p 8080:80 nginx')).toBe(`docker run -p ${REDACTED} ${REDACTED}`);
  expect(safeCommandSummary('herdr pane read w4:pH --lines 20')).toBe(`herdr pane ${REDACTED} ${REDACTED} --lines ${REDACTED}`);
  expect(safeCommandSummary('ls -la src/tui')).toBe(`ls ${REDACTED} ${REDACTED}`);
  expect(safeCommandSummary('ls -la ./src/tui')).toBe(`ls ${REDACTED} ./tui`);
  expect(safeCommandSummary('cd /Users/synthetic')).toBe(`cd ${REDACTED}`);
});

test('a word that only contains a slash is not a path — base64 credential tails never show (#38033 r1 mf1)', () => {
  const tails = ['bPxRfiCYEXAMPLEKEY', 'dXNlcjpwYXNzd29yZA', 'tok9f8e7d6c5b4a'];
  const commands = [
    `aws configure set aws_secret_access_key wJalrXUtnFEMI/K7MDENG/${tails[0]}`,
    `curl -H "Authorization: Bearer abc123/${tails[1]}" https://x.test`,
    `curl -H Authorization: Bearer abc123/${tails[1]} https://x.test`,
    `gh secret set TOKEN --body abc/${tails[2]}`,
    `mytool --token /${tails[2]}`,
    `curl -H Authorization: Bearer /${tails[1]} https://x.test`,
  ];
  for (const command of commands) {
    const summary = safeCommandSummary(command) ?? '';
    for (const tail of tails) expect(summary, command).not.toContain(tail);
    expect(safeCommandSummary(summary), command).toBe(summary);
  }
  // Real paths still show their basename: anchored paths and relative files with a known extension.
  expect(safeCommandSummary('cat /etc/hosts.txt')).toBe('cat ./hosts.txt');
  expect(safeCommandSummary('cat ./demo/page.html')).toBe('cat ./page.html');
  expect(safeCommandSummary('bun test src/tui/x.test.ts')).toBe('bun test ./x.test.ts');
  expect(safeCommandSummary('cat README.md')).toBe('cat ./README.md');
  expect(safeCommandSummary('cat abc/bPxRfiCYEXAMPLEKEY')).toBe(`cat ${REDACTED}`);
});

const AGENT_SUMMARY_LIMIT = 60;

test('Agent rows carry a short safe label and a one-line result, and never fold into «Agent ×N» (O8)', () => {
  expect(safeAgentDescription('probe A')).toBe('probe A');
  expect(safeAgentDescription('조사 하나')).toBe('조사 하나');
  // Anything outside letters, digits, spaces and . _ # - is no label; so is a long text or a secret-looking word.
  for (const bad of ['read /etc/passwd', 'use key=abc', 'a'.repeat(41), 'token sk-live-abcdef', 'ghp_abcdefghijklmn', 'abcdefgh1234 fix', 'say "hi"', '']) {
    expect(safeAgentDescription(bad), bad).toBeUndefined();
  }
  expect(toolActivityTarget('Agent', { description: 'probe A', prompt: 'SECRET-PROMPT-BODY' })).toBe('probe A');
  expect(toolActivityTarget('Agent', { prompt: 'no description' })).toBeUndefined();
  // One line, plain words; secret-looking and path/URL/e-mail-like words become the mark; long text is cut.
  expect(safeAgentSummary('Found it.\nsecond line stays out')).toBe('Found it.');
  expect(safeAgentSummary({ output: '  \n  The auth flow uses sk-live-abcdef1234 at https://x.test/a?b=c ' })).toBe(`The auth flow uses ${REDACTED} at ${REDACTED}`);
  expect(safeAgentSummary('x'.repeat(200))!.length).toBeLessThanOrEqual(AGENT_SUMMARY_LIMIT);
  expect(safeAgentSummary('')).toBeUndefined();
  expect(safeAgentSummary(undefined)).toBeUndefined();
  // Rows: a finished batch keeps one labelled row per child, each with its result.
  const events = ['A', 'B', 'C'].flatMap((name, index) => ([
    { phase: 'start' as const, id: `a${index}`, name: 'Agent', target: `probe ${name}` },
    { phase: 'finish' as const, id: `a${index}`, name: 'Agent', summary: `result ${name}` },
  ]));
  const rows = events.reduce((acc, event) => updateToolActivity(acc, event, 0), [] as ReturnType<typeof updateToolActivity>);
  const lines = toolActivityLines(rows, 0);
  expect(lines).toHaveLength(3);
  expect(lines.map((line) => line.replace(/ \d+s/, ''))).toEqual([`${TOOL_DONE_GLYPH} Agent(probe A) · result A`, `${TOOL_DONE_GLYPH} Agent(probe B) · result B`, `${TOOL_DONE_GLYPH} Agent(probe C) · result C`]);
  // The result line is re-projected on every hop: a transported row with a secret-looking summary stays hidden.
  const unsafe = updateToolActivity(updateToolActivity([], { phase: 'start', id: 'x', name: 'Agent', target: 'probe' }, 0),
    { phase: 'finish', id: 'x', name: 'Agent', summary: 'key sk-abcdefghijkl done' }, 0);
  expect(toolActivityLines(unsafe, 0)[0]).not.toContain('sk-abcdefghijkl');
});
