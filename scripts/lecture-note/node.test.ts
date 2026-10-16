import { afterEach, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createRequire } from 'node:module';
import { parseGraphTemplateYaml } from '../../src/self-implement/graph-yaml.js';
import { decideGraphApproval, runGraph } from '../../src/graph-runner/runner.js';
import { debug } from '../../src/debug/log.js';
import { handleVaultGet } from '../../src/nexus/api/vault-api.js';
import { _resetObsidianCacheForTests } from '../../src/acp/fs-roots.js';
import { collect, draft, html, pdf, render, runStage } from './node.js';
import type { TranscriptionEngine } from '../../src/field-note/transcribe.js';

const fixtures: string[] = [];
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });
const folder = () => {
  const path = mkdtempSync(join(tmpdir(), 'lecture-note-test-'));
  fixtures.push(path);
  return path;
};

const graphPath = resolve(import.meta.dir, '../../graphs/lecture/lecture-note.yaml');

test('collect → draft → render without renderer → html → skipped pdf; only output subtree changes', async () => {
  const dir = folder();
  const summary = '# 강의 요약\n강의 순서와 원칙';
  writeFileSync(join(dir, 'summary.md'), summary);
  writeFileSync(join(dir, 'sketch.png'), 'image stays untouched');
  const out = join(dir, 'lecture-note');
  const opts = { toolsPath: '', ocr: async () => '사진 속 손필기 내용', llm: async (prompt: string) => {
    expect(prompt).toContain(summary);
    expect(prompt).toContain('사진 속 손필기 내용');
    expect(prompt).toContain('Mermaid 우선');
    return '# 강의 노트\n## 개념\n수식 \\( E = mc^2 \\)는 에너지다.\n> 강조 \\( x^2 + y^2 = z^2 \\)\n```mermaid\nflowchart TB\n A-->B\n```\n## 결론\n```mermaid\nflowchart LR\n B-->C\n```';
  } };
  expect((await collect(dir, opts)).inputs).toBe(2);
  expect(JSON.parse(readFileSync(join(out, 'inputs.json'), 'utf8')).map((i: { kind: string }) => i.kind).sort()).toEqual(['image', 'markdown']);
  expect((await draft(dir, opts)).diagrams).toBe(2);
  expect([...readFileSync(join(out, 'notes.md'), 'utf8').matchAll(/```mermaid/g)]).toHaveLength(2);
  const renderLog = spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(render(dir, opts)).toMatchObject({ diagrams: 2, rendered: 0 });
    expect(renderLog).toHaveBeenCalledWith('렌더러 없음: 2');
  } finally { renderLog.mockRestore(); }
  expect(html(dir, opts).html).toBe('yes');
  const page = readFileSync(join(out, 'notes.html'), 'utf8');
  expect([...page.matchAll(/<pre><code class="language-mermaid">/g)]).toHaveLength(2);
  expect(page).toContain('수식 \\( E = mc^2 \\)는 에너지다.');
  expect(page).toContain('<blockquote>\n<p>강조 \\( x^2 + y^2 = z^2 \\)</p>\n</blockquote>');
  expect(page).toContain('<div class="toc">');
  expect(page).toContain('href="#sec-1"');
  expect(page).not.toContain('<img src="diagram-');
  const pdfLog = spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(pdf(dir, opts)).toMatchObject({ outcome: 'skipped', pdf: 'skipped', inputs: 2, diagrams: 2, rendered: 0, html: 'yes' });
    expect(pdfLog).toHaveBeenCalledWith('PDF 엔진 없음 — HTML 이 산출물');
  } finally { pdfLog.mockRestore(); }
  expect(readdirSync(dir).sort()).toEqual(['lecture-note', 'sketch.png', 'summary.md']);
  expect(readFileSync(join(dir, 'sketch.png'), 'utf8')).toBe('image stays untouched');
  expect(readFileSync(join(dir, 'summary.md'), 'utf8')).toBe(summary);
  expect(readdirSync(out).sort()).toEqual(['inputs.json', 'notes.html', 'notes.md']);
});

test('graph collect transcribes audio chunks into inputs.json and draft creates summary and three tasks', async () => {
  const dir = folder();
  writeFileSync(join(dir, 'part.wav'), 'original audio remains untouched');
  writeFileSync(join(dir, 'slide.md'), '추가 강의 자료');
  const engine: TranscriptionEngine = { async transcribe(chunk) {
    return [{ startSeconds: 0, endSeconds: chunk.samples.length / chunk.sampleRate,
      text: chunk.startSeconds === 0 ? '예습하고 질문을 기록하세요' : '복습하세요', speaker: '강사' }];
  } };
  const options = { engine, vaultRoot: dir, toolsPath: '', decodeAudio: (_file: string, recordedAt: string) => ({
    samples: new Float32Array(16000 * 5), sampleRate: 16000, recordedAt,
  }), llm: async (prompt: string) => {
    expect(prompt).toContain('part.wav (audio)');
    expect(prompt).toContain('예습하고 질문을 기록하세요');
    expect(prompt).toContain('강사:');
    expect(prompt).toContain('할 일 셋');
    expect(prompt).toContain('추가 강의 자료');
    return '# 강의 노트\n## 요약\n강의에서는 예습과 복습을 강조했다.\n## 할 일 셋\n1. 예습하기\n2. 질문 기록하기\n3. 복습하기';
  } };
  expect((await runStage('collect', dir, options)).inputs).toBe(2);
  const inputs = JSON.parse(readFileSync(join(dir, 'lecture-note/inputs.json'), 'utf8')) as
    { name: string; kind: string; text: string }[];
  expect(inputs.map(({ name, kind }) => [name, kind])).toEqual([['part.wav', 'audio'], ['slide.md', 'markdown']]);
  expect(inputs[0]!.text).toContain('강사: 예습하고 질문을 기록하세요');
  expect((await runStage('draft', dir, options)).outcome).toBe('ok');
  const notes = readFileSync(join(dir, 'lecture-note/notes.md'), 'utf8');
  expect(notes).toContain('## 요약\n강의에서는 예습과 복습을 강조했다.');
  expect(notes).toContain('## 할 일 셋\n1. 예습하기\n2. 질문 기록하기\n3. 복습하기');
  expect(html(dir, options).html).toBe('yes');
  expect(readFileSync(join(dir, 'lecture-note/notes.html'), 'utf8')).toContain('질문 기록하기');
  expect(readFileSync(join(dir, 'part.wav'), 'utf8')).toBe('original audio remains untouched');
  expect(readdirSync(join(dir, 'lecture-notes'))).toHaveLength(1);
});

test('collect decodes a WAV fragment with the existing ffmpeg decoder before transcription', async () => {
  const dir = folder();
  const pcm = Buffer.alloc(16000 * 2);
  const wav = Buffer.alloc(44);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcm.length, 40);
  writeFileSync(join(dir, 'lecture.wav'), Buffer.concat([wav, pcm]));
  let decoded = false;
  await collect(dir, { vaultRoot: dir, engine: { transcribe: async (chunk) => {
    expect(chunk.sampleRate).toBe(16000);
    expect(chunk.samples).toHaveLength(16000);
    decoded = true;
    return [{ startSeconds: 0, endSeconds: 1, text: '전사 결과' }];
  } } });
  expect(decoded).toBe(true);
  expect(JSON.parse(readFileSync(join(dir, 'lecture-note/inputs.json'), 'utf8'))[0])
    .toMatchObject({ kind: 'audio', text: expect.stringContaining('전사 결과') });
});

test('collect preserves filename order while transcribing audio beside markdown', async () => {
  const dir = folder();
  writeFileSync(join(dir, 'a.md'), '자료');
  writeFileSync(join(dir, 'z.wav'), 'audio');
  const inputs = await collect(dir, {
    engine: { transcribe: async () => [{ startSeconds: 0, endSeconds: 1, text: '전사 내용' }] },
    decodeAudio: (_file, recordedAt) => ({ samples: new Float32Array(16000), sampleRate: 16000, recordedAt }),
  });
  expect(inputs.inputs).toBe(2);
  expect(JSON.parse(readFileSync(join(dir, 'lecture-note/inputs.json'), 'utf8')).map((item: { kind: string }) => item.kind))
    .toEqual(['markdown', 'audio']);
});

test('collect uses the configured batch STT provider when no engine is injected', async () => {
  const dir = folder();
  writeFileSync(join(dir, 'lecture.wav'), 'audio fixture');
  const previousKey = process.env.OPENAI_API_KEY;
  const previousDump = process.env.OPENAI_STT_DEBUG_DUMP;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_STT_DEBUG_DUMP = '0';
  let requests = 0;
  globalThis.fetch = (async (input, init) => {
    requests++;
    expect(String(input)).toEndWith('/v1/audio/transcriptions');
    expect((init?.headers as { Authorization: string }).Authorization).toBe('Bearer test-key');
    const form = init?.body as FormData;
    const audio = form.get('file') as File;
    expect(audio.name).toBe('audio.wav');
    expect(Buffer.from(await audio.arrayBuffer()).subarray(0, 4).toString()).toBe('RIFF');
    expect(form.get('language')).toBe('ko');
    return Response.json({ text: '강의 자료를 읽고 질문을 기록하세요' });
  }) as typeof fetch;
  try {
    await collect(dir, { decodeAudio: (_file, recordedAt) => ({ samples: new Float32Array(16000), sampleRate: 16000, recordedAt }) });
    expect(requests).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, 'lecture-note/inputs.json'), 'utf8'))[0])
      .toMatchObject({ kind: 'audio', text: expect.stringContaining('질문을 기록하세요') });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousDump === undefined) delete process.env.OPENAI_STT_DEBUG_DUMP;
    else process.env.OPENAI_STT_DEBUG_DUMP = previousDump;
  }
});

test('audio note in a vault course is published as a Markdown note for the existing PWA vault reader', async () => {
  const vault = folder();
  const course = join(vault, 'course');
  mkdirSync(course);
  writeFileSync(join(course, 'lecture.wav'), 'original audio');
  const options = {
    vaultRoot: vault,
    engine: { transcribe: async () => [{ startSeconds: 0, endSeconds: 0.4, text: '예습 복습', speaker: '강사' }] },
    decodeAudio: (_file: string, recordedAt: string) => ({ samples: new Float32Array(16000), sampleRate: 16000, recordedAt }),
    llm: async () => '# 강의 노트\n## 요약\n예습과 복습\n## 할 일 셋\n1. 예습\n2. 복습\n3. 질문 기록',
  };
  await collect(course, options);
  await draft(course, options);
  expect(readdirSync(vault)).toEqual(['course']);
  html(course, options);
  const entries = readdirSync(join(vault, 'lecture-notes'));
  expect(entries).toHaveLength(1);
  expect(entries[0]).toEndWith('.md');
  expect(readFileSync(join(vault, 'lecture-notes', entries[0]!), 'utf8'))
    .toBe(readFileSync(join(course, 'lecture-note/notes.md'), 'utf8'));
  const priorVault = process.env.OBSIDIAN_VAULT;
  process.env.OBSIDIAN_VAULT = vault;
  _resetObsidianCacheForTests();
  try {
    const listing = await handleVaultGet(new Request('http://localhost/v1/vault/list?cwd=' + encodeURIComponent(join(vault, 'lecture-notes'))), 'list');
    expect((await listing.json() as { entries: Array<{ name: string }> }).entries.map(e => e.name)).toContain(entries[0]!);
    const read = await handleVaultGet(new Request('http://localhost/v1/vault/read?path=' + encodeURIComponent(`lecture-notes/${entries[0]}`)), 'read');
    const markdown = (await read.json() as { content: string }).content;
    expect(markdown).toContain('## 요약\n예습과 복습');
    expect(markdown).toContain('## 할 일 셋\n1. 예습\n2. 복습\n3. 질문 기록');
    const fromPwa = createRequire(resolve(import.meta.dir, '../../apps/pwa/package.json'));
    const { createElement } = fromPwa('react') as { createElement: (component: unknown, props: { markdown: string }) => unknown };
    const { renderToStaticMarkup } = fromPwa('react-dom/server') as { renderToStaticMarkup: (element: unknown) => string };
    const { VaultMarkdown } = fromPwa(resolve(import.meta.dir, '../../apps/pwa/src/components/vault/VaultMarkdown.tsx')) as
      { VaultMarkdown: unknown };
    const view = renderToStaticMarkup(createElement(VaultMarkdown, { markdown }));
    expect(view).toContain('<h2');
    expect(view).toContain('요약</h2>');
    expect(view).toContain('예습과 복습');
    expect(view).toContain('할 일 셋</h2>');
    expect(view).toContain('<ol');
    for (const task of ['예습', '복습', '질문 기록']) {
      expect(view).toMatch(new RegExp(`<li[^>]*>${task}</li>`));
    }
  } finally {
    if (priorVault === undefined) delete process.env.OBSIDIAN_VAULT;
    else process.env.OBSIDIAN_VAULT = priorVault;
    _resetObsidianCacheForTests();
  }
  expect(readdirSync(course).sort()).toEqual(['lecture-note', 'lecture.wav']);
});

test('audio note from a course outside the vault is published without altering its source folder', async () => {
  const vault = folder();
  const course = folder();
  writeFileSync(join(course, 'lecture.wav'), 'audio stays');
  const options = {
    vaultRoot: vault,
    engine: { transcribe: async () => [{ startSeconds: 0, endSeconds: 0.4, text: '예습 복습' }] },
    decodeAudio: (_file: string, recordedAt: string) => ({ samples: new Float32Array(16000), sampleRate: 16000, recordedAt }),
    llm: async () => '# 노트\n## 요약\n강의\n## 할 일 셋\n1. 예습\n2. 복습\n3. 질문',
  };
  await collect(course, options);
  await draft(course, options);
  html(course, options);
  expect(readdirSync(join(vault, 'lecture-notes'))).toHaveLength(1);
  expect(readFileSync(join(course, 'lecture.wav'), 'utf8')).toBe('audio stays');
  html(course, options);
  expect(readdirSync(join(vault, 'lecture-notes'))).toHaveLength(1);
  const changed = { ...options, llm: async () => '# 노트\n## 요약\n다른 강의\n## 할 일 셋\n1. 예습\n2. 복습\n3. 질문' };
  await draft(course, changed);
  html(course, changed);
  expect(readdirSync(join(vault, 'lecture-notes'))).toHaveLength(2);
  expect(readdirSync(join(vault, 'lecture-notes')).map(name => readFileSync(join(vault, 'lecture-notes', name), 'utf8')))
    .toEqual(expect.arrayContaining([expect.stringContaining('## 요약\n강의'), expect.stringContaining('## 요약\n다른 강의')]));
});

test('audio notes publish at HTML stage after the existing approval boundary, not at draft', async () => {
  const vault = folder();
  const course = folder();
  writeFileSync(join(course, 'lecture.wav'), 'audio');
  await collect(course, {
    engine: { transcribe: async () => [{ startSeconds: 0, endSeconds: 1, text: '예습 복습' }] },
    decodeAudio: (_file, recordedAt) => ({ samples: new Float32Array(16000), sampleRate: 16000, recordedAt }),
  });
  await draft(course, {
    vaultRoot: vault,
    llm: async () => '# 노트\n## 요약\n예습 복습\n## 할 일 셋\n1. 예습\n2. 복습\n3. 질문',
  });
  expect(readdirSync(vault)).toEqual([]);
  html(course, { vaultRoot: vault });
  expect(readdirSync(join(vault, 'lecture-notes'))).toHaveLength(1);
});

test('approved audio note without summary or three tasks is not published to the PWA vault', async () => {
  const vault = folder();
  const course = folder();
  writeFileSync(join(course, 'lecture.wav'), 'audio');
  await collect(course, {
    engine: { transcribe: async () => [{ startSeconds: 0, endSeconds: 1, text: '예습 복습' }] },
    decodeAudio: (_file, recordedAt) => ({ samples: new Float32Array(16000), sampleRate: 16000, recordedAt }),
  });
  await draft(course, { llm: async () => '# 강의 노트\n## 요약\n예습 복습\n## 할 일 셋\n1. 예습\n2. 복습\n3. 질문' });
  writeFileSync(join(course, 'lecture-note/notes.md'), '# 강의 노트\n편집 후 빈 노트\n');
  expect(() => html(course, { vaultRoot: vault })).toThrow('요약·할 일 셋');
  expect(readdirSync(vault)).toEqual([]);
});

test('audio note publication does not replace a preexisting vault note', async () => {
  const vault = folder();
  const course = folder();
  writeFileSync(join(course, 'fragment.wav'), 'audio');
  await collect(course, {
    engine: { transcribe: async () => [{ startSeconds: 0, endSeconds: 1, text: '예습 복습' }] },
    decodeAudio: (_file, recordedAt) => ({ samples: new Float32Array(16000), sampleRate: 16000, recordedAt }),
  });
  await draft(course, { llm: async () => '# 노트\n## 요약\n예습 복습\n## 할 일 셋\n1. 예습\n2. 복습\n3. 질문' });
  html(course, { vaultRoot: vault });
  const note = join(vault, 'lecture-notes', readdirSync(join(vault, 'lecture-notes'))[0]!);
  writeFileSync(note, 'someone edited this note');
  expect(() => html(course, { vaultRoot: vault })).toThrow('vault 노트 해시 충돌');
  expect(readFileSync(note, 'utf8')).toBe('someone edited this note');
});

test('audio note publication rejects a symlinked vault root', async () => {
  const realVault = folder();
  const linkParent = folder();
  const linkedVault = join(linkParent, 'vault');
  symlinkSync(realVault, linkedVault);
  const course = folder();
  writeFileSync(join(course, 'fragment.wav'), 'audio');
  await collect(course, {
    engine: { transcribe: async () => [{ startSeconds: 0, endSeconds: 1, text: '예습 복습' }] },
    decodeAudio: (_file, recordedAt) => ({ samples: new Float32Array(16000), sampleRate: 16000, recordedAt }),
  });
  await draft(course, { llm: async () => '# 노트\n## 요약\n예습 복습\n## 할 일 셋\n1. 예습\n2. 복습\n3. 질문' });
  expect(() => html(course, { vaultRoot: linkedVault })).toThrow('vault 루트가 안전하지 않다');
  expect(readdirSync(realVault)).toEqual([]);
});

test('audio note publication rejects a symlinked vault destination', async () => {
  const vault = folder();
  const elsewhere = folder();
  const course = folder();
  symlinkSync(elsewhere, join(vault, 'lecture-notes'));
  writeFileSync(join(course, 'fragment.wav'), 'audio');
  await collect(course, {
    decodeAudio: (_file, recordedAt) => ({ samples: new Float32Array(16000), sampleRate: 16000, recordedAt }),
    engine: { transcribe: async () => [{ startSeconds: 0, endSeconds: 1, text: '예습 복습' }] },
  });
  await draft(course, { llm: async () => '# 노트\n## 요약\n예습 복습\n## 할 일 셋\n1. 예습\n2. 복습\n3. 질문' });
  expect(() => html(course, { vaultRoot: vault })).toThrow('vault 강의 노트 폴더가 안전하지 않다');
  expect(readdirSync(elsewhere)).toEqual([]);
});

test('audio notes do not alter non-audio vault publishing defaults', async () => {
  const vault = folder();
  const course = folder();
  writeFileSync(join(course, 'reading.md'), 'plain markdown');
  await collect(course);
  await draft(course, { llm: async () => '# markdown-only notes' });
  expect(html(course, { vaultRoot: vault }).outcome).toBe('ok');
  expect(readdirSync(vault)).toEqual([]);
  expect(readFileSync(join(course, 'lecture-note/notes.md'), 'utf8')).toBe('# markdown-only notes\n');
});

test('audio collect also reads shared-course audio fragments with the existing source prefix', async () => {
  const dir = folder();
  mkdirSync(join(dir, 'sources/common'), { recursive: true });
  writeFileSync(join(dir, 'sources/common/fragment.m4a'), 'audio');
  await collect(dir, {
    engine: { transcribe: async () => [{ startSeconds: 0, endSeconds: 1, text: '강의 전사' }] },
    decodeAudio: (_file, recordedAt) => ({ samples: new Float32Array(16000), sampleRate: 16000, recordedAt }),
  });
  const inputs = JSON.parse(readFileSync(join(dir, 'lecture-note/inputs.json'), 'utf8')) as
    Array<{ kind: string; name: string; text: string }>;
  expect(inputs).toHaveLength(1);
  expect(inputs[0]).toMatchObject({ name: 'sources/common/fragment.m4a', kind: 'audio', text: expect.stringContaining('강의 전사') });
  expect(readFileSync(join(dir, 'sources/common/fragment.m4a'), 'utf8')).toBe('audio');
});

test('audio collect retains existing inputs.json shape for transcript and other materials', async () => {
  const dir = folder();
  writeFileSync(join(dir, 'first.md'), '기존 본문');
  writeFileSync(join(dir, 'second.wav'), 'audio');
  await collect(dir, {
    engine: { transcribe: async () => [{ startSeconds: 0, endSeconds: 1, text: '예습 복습' }] },
    decodeAudio: (_file, recordedAt) => ({ samples: new Float32Array(16000), sampleRate: 16000, recordedAt }),
  });
  const parsed = JSON.parse(readFileSync(join(dir, 'lecture-note/inputs.json'), 'utf8')) as Array<Record<string, unknown>>;
  expect(parsed).toHaveLength(2);
  expect(parsed.map(entry => Object.keys(entry).sort())).toEqual([['kind', 'name', 'text'], ['kind', 'name', 'text']]);
  expect(parsed[0]).toEqual({ name: 'first.md', kind: 'markdown', text: '기존 본문' });
  expect(parsed[1]).toMatchObject({ name: 'second.wav', kind: 'audio', text: expect.stringContaining('예습 복습') });
});

test('collect fails closed on silent audio without a transcript', async () => {
  const dir = folder();
  writeFileSync(join(dir, 'silence.wav'), 'audio');
  await expect(collect(dir, {
    engine: { transcribe: async () => [] },
    decodeAudio: (_file, recordedAt) => ({ samples: new Float32Array(16000), sampleRate: 16000, recordedAt }),
  })).rejects.toThrow('오디오 전사 결과가 비었다');
  expect(readdirSync(join(dir, 'lecture-note'))).toEqual([]);
});

test('audio notes remain local when the PWA vault is unavailable', async () => {
  const course = folder();
  const missingVault = join(course, 'not-configured');
  writeFileSync(join(course, 'fragment.wav'), 'original audio');
  await collect(course, {
    decodeAudio: (_file, recordedAt) => ({ samples: new Float32Array(16000), sampleRate: 16000, recordedAt }),
    engine: { transcribe: async () => [{ startSeconds: 0, endSeconds: 1, text: '예습과 복습' }] },
  });
  expect((await draft(course, { vaultRoot: missingVault,
    llm: async () => '# 노트\n## 요약\n예습과 복습\n## 할 일 셋\n1. 예습\n2. 복습\n3. 질문',
  })).outcome).toBe('ok');
  html(course, { vaultRoot: missingVault });
  expect(readFileSync(join(course, 'lecture-note/notes.md'), 'utf8')).toContain('## 할 일 셋');
  expect(readdirSync(course).sort()).toEqual(['fragment.wav', 'lecture-note']);
});

test('audio transcription errors do not produce a successful or partially written collect', async () => {
  const dir = folder();
  writeFileSync(join(dir, 'part.ogg'), 'original audio');
  await expect(collect(dir, { engine: { transcribe: async () => { throw new Error('STT unavailable'); } },
    decodeAudio: (_file, recordedAt) => ({ samples: new Float32Array(16000), sampleRate: 16000, recordedAt }),
  })).rejects.toThrow('STT unavailable');
  expect(readdirSync(join(dir, 'lecture-note'))).toEqual([]);
});

test('draft rejects audio notes missing a summary or three tasks', async () => {
  const dir = folder();
  mkdirSync(join(dir, 'lecture-note'));
  writeFileSync(join(dir, 'lecture-note/inputs.json'), JSON.stringify([{ name: 'part.wav', kind: 'audio', text: '강의 내용' }]));
  await expect(draft(dir, { llm: async () => '# 강의 노트\n## 요약\n요약만 있음' })).rejects.toThrow('요약·할 일 셋');
  await expect(draft(dir, { llm: async () => '# 강의 노트\n## 요약\n## 할 일 셋\n1. 예습\n2. 복습\n3. 질문' }))
    .rejects.toThrow('요약·할 일 셋');
  expect(readdirSync(join(dir, 'lecture-note'))).toEqual(['inputs.json']);
});

test('audio draft and publication accept Markdown blank lines after section headings but reject missing content', async () => {
  const vault = folder();
  const course = folder();
  mkdirSync(join(course, 'lecture-note'));
  writeFileSync(join(course, 'lecture-note/inputs.json'), JSON.stringify([{ name: 'part.wav', kind: 'audio', text: '예습 복습' }]));
  const valid = '# 노트\n## 요약\n\n요약 본문\n\n## 할 일 셋\n\n1. 예습\n2. 복습\n3. 질문\n';
  expect((await draft(course, { llm: async () => valid })).outcome).toBe('ok');
  const nested = valid.replace('요약 본문', '### 핵심\n\n요약 본문');
  expect((await draft(course, { llm: async () => nested })).outcome).toBe('ok');
  expect((await draft(course, { llm: async () => valid })).outcome).toBe('ok');
  const fromPwa = createRequire(resolve(import.meta.dir, '../../apps/pwa/package.json'));
  const { createElement } = fromPwa('react') as { createElement: (component: unknown, props: { markdown: string }) => unknown };
  const { renderToStaticMarkup } = fromPwa('react-dom/server') as { renderToStaticMarkup: (element: unknown) => string };
  const { VaultMarkdown } = fromPwa(resolve(import.meta.dir, '../../apps/pwa/src/components/vault/VaultMarkdown.tsx')) as
    { VaultMarkdown: unknown };
  const visible = renderToStaticMarkup(createElement(VaultMarkdown, { markdown: readFileSync(join(course, 'lecture-note/notes.md'), 'utf8') }));
  expect(visible).toContain('요약 본문');
  expect(visible).toContain('할 일 셋</h2>');
  expect(visible).toMatch(/<li[^>]*>질문<\/li>/);
  expect(html(course, { vaultRoot: vault }).outcome).toBe('ok');
  const published = readdirSync(join(vault, 'lecture-notes'));
  expect(published).toHaveLength(1);
  expect(readFileSync(join(vault, 'lecture-notes', published[0]!), 'utf8')).toBe(valid);
  for (const invalid of [
    valid.replace('요약 본문', ''),
    valid.replace('요약 본문', '### 질문'),
    valid.replace('3. 질문', ''),
    valid.replace('3. 질문', '## 질문'),
  ]) {
    await expect(draft(course, { llm: async () => invalid })).rejects.toThrow('요약·할 일 셋');
    writeFileSync(join(course, 'lecture-note/notes.md'), invalid);
    expect(() => html(course, { vaultRoot: vault })).toThrow('요약·할 일 셋');
    expect(readdirSync(join(vault, 'lecture-notes'))).toEqual(published);
  }
});

test('collect OCRs photos and records failed OCR beside unchanged markdown and PDF inputs', async () => {
  const dir = folder();
  const common = join(dir, 'sources/common');
  mkdirSync(common, { recursive: true });
  writeFileSync(join(dir, 'a.png'), 'image one');
  writeFileSync(join(common, 'b.webp'), 'image two');
  writeFileSync(join(dir, 'summary.md'), '원래 강의 요약');
  writeFileSync(join(dir, 'handout.pdf'), '%PDF-1.4');
  const calls: string[] = [];
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    expect((await collect(dir, { toolsPath: '', ocr: async (path) => {
      calls.push(path);
      if (path.endsWith('b.webp')) throw new Error('OCR 인증 실패');
      return '사진 속 핵심 개념';
    } })).inputs).toBe(4);
    expect(calls).toEqual([join(dir, 'a.png'), join(common, 'b.webp')]);
    const inputs = JSON.parse(readFileSync(join(dir, 'lecture-note/inputs.json'), 'utf8')) as
      { name: string; kind: string; text: string }[];
    expect(inputs).toContainEqual({ name: 'a.png', kind: 'image', text: '사진 속 핵심 개념' });
    expect(inputs).toContainEqual({ name: 'sources/common/b.webp', kind: 'image', text: '이미지 텍스트 못 읽음 · OCR 인증 실패' });
    expect(inputs).toContainEqual({ name: 'summary.md', kind: 'markdown', text: '원래 강의 요약' });
    expect(inputs).toContainEqual({ name: 'handout.pdf', kind: 'pdf', text: 'PDF 텍스트 없음 — pdftotext 없음' });
    expect(log).toHaveBeenCalledWith('lecture-note.collect', 'ocr-failed', {
      name: 'sources/common/b.webp', reason: 'OCR 인증 실패',
    });
  } finally { log.mockRestore(); }
});

test('empty OCR fallback is recorded as unreadable rather than silently omitted', async () => {
  const dir = folder();
  writeFileSync(join(dir, 'slide.jpeg'), 'image');
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    await collect(dir, { ocr: async () => '' });
    const inputs = JSON.parse(readFileSync(join(dir, 'lecture-note/inputs.json'), 'utf8')) as
      { name: string; kind: string; text: string }[];
    expect(inputs[0]).toEqual({ name: 'slide.jpeg', kind: 'image',
      text: '이미지 텍스트 못 읽음 · Upstage/OCR.space 폴백 결과가 비었다' });
    expect(log).toHaveBeenCalledWith('lecture-note.collect', 'ocr-failed', {
      name: 'slide.jpeg', reason: 'Upstage/OCR.space 폴백 결과가 비었다',
    });
  } finally { log.mockRestore(); }
});

test('stage observation reports the lecture note counts', async () => {
  const dir = folder();
  writeFileSync(join(dir, 'summary.md'), '강의 내용');
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const result = await runStage('collect', dir, { toolsPath: '' });
    expect(result.inputs).toBe(1);
    expect(log).toHaveBeenCalledWith('lecture.note', 'collect', {
      inputs: 1, diagrams: 0, rendered: 0, pdf: 'skipped',
    });
  } finally { log.mockRestore(); }
});

test('graph runner template validates and requires an approval before rendering', () => {
  const source = readFileSync(graphPath, 'utf8');
  const parsed = parseGraphTemplateYaml(source, graphPath);
  expect(parsed.errors).toEqual([]);
  expect(parsed.template?.graphId).toBe('lecture-note');
  const doc = parseYaml(source) as { loop: { exec_request: boolean; inputs: string[]; trigger: { events: string[] } } };
  expect(doc.loop).toMatchObject({ exec_request: true, inputs: ['folder'], trigger: { events: ['manual'] } });
  const template = parsed.template!;
  expect(template.nodes.map(n => n.nodeId)).toEqual(['collect', 'draft', 'confirm', 'render', 'html', 'pdf', 'done', 'failed']);
  expect(template.nodes.find(n => n.nodeId === 'confirm')).toMatchObject({ kind: 'hitl', recipe: 'approval:confirm' });
  expect(template.edges.find(e => e.from === 'draft')?.map?.ok).toBe('confirm');
  expect(template.edges.find(e => e.from === 'confirm')?.map?.ok).toBe('render');
  expect(template.edges.find(e => e.from === 'pdf')?.map).toMatchObject({ ok: 'done', skipped: 'done', fail: 'failed', error: 'failed' });
  for (const stage of ['collect', 'draft', 'render', 'html']) expect(template.edges.find(e => e.from === stage)?.map?.fail).toBe('failed');
  const recipes = parseYaml(readFileSync(join(import.meta.dir, '../../graphs/lecture/recipes.yaml'), 'utf8')) as Record<string, { command?: string; approval?: string }>;
  expect(recipes.confirm?.approval).toBe('{"kind":"lecture-outline"}');
  for (const stage of ['collect', 'draft', 'render', 'html', 'pdf']) expect(recipes[stage]?.command).toBe(`bun "$ELANOUS_GRAPH_DIR/../../scripts/lecture-note/node.ts" ${stage}`);
});

test('graph runner reaches audio collect and draft before the unchanged approval boundary', async () => {
  const root = folder();
  const course = join(root, 'course');
  mkdirSync(course);
  writeFileSync(join(course, 'fragment.wav'), 'audio');
  const calls: string[] = [];
  const deps = { root, processStartMs: () => null, runBash: async (command: string) => {
    const stage = command.match(/node\.ts\" (collect|draft)/)?.[1];
    if (stage !== 'collect' && stage !== 'draft') throw new Error(`unexpected graph stage: ${command}`);
    calls.push(stage);
    const result = await runStage(stage, course, {
      vaultRoot: root,
      decodeAudio: (_file, recordedAt) => ({ samples: new Float32Array(16000), sampleRate: 16000, recordedAt }),
      engine: { transcribe: async () => [{ startSeconds: 0, endSeconds: 1, text: '예습 복습' }] },
      llm: async () => '# 강의 노트\n## 요약\n예습과 복습\n## 할 일 셋\n1. 예습\n2. 복습\n3. 질문',
    });
    return { stdout: `${JSON.stringify({ outcome: result.outcome })}\n`, stderr: '', exitCode: 0 };
  } };
  const pending = await runGraph(graphPath, { input: { folder: course }, deps });
  expect(pending.status).toBe('awaiting-approval');
  expect(pending.pending?.nodeId).toBe('confirm');
  expect(calls).toEqual(['collect', 'draft']);
  expect(readFileSync(join(course, 'lecture-note/notes.md'), 'utf8')).toContain('## 할 일 셋');
  expect(readdirSync(root).sort()).toEqual(['course', 'graph-runs']);
});

test('PDF collection without pdftotext records absence; HTML uses rendered PNG and preserves tables', async () => {
  const dir = folder();
  writeFileSync(join(dir, 'handout.pdf'), '%PDF-1.4');
  const opts = { toolsPath: '', llm: async () => '# 강의 노트\n<a id="part1"></a>\n## 첫 부분\n| 항목 | 값 |\n| --- | --- |\n| 개념 | 비교 |\n```mermaid\nflowchart LR\n A-->B\n```\n---\n\n<a id="appendix"></a>\n# 부록: 다이어그램 목록\n| # | 파일명 |' };
  await collect(dir, opts);
  const out = join(dir, 'lecture-note');
  const inputs = JSON.parse(readFileSync(join(out, 'inputs.json'), 'utf8')) as { name: string; kind: string; text: string }[];
  expect(inputs).toHaveLength(1);
  expect(inputs[0]).toMatchObject({ name: 'handout.pdf', kind: 'pdf', text: 'PDF 텍스트 없음 — pdftotext 없음' });
  await draft(dir, opts);
  writeFileSync(join(out, 'diagram-1.png'), 'fake rendered image');
  expect(html(dir, opts).rendered).toBe(1);
  const page = readFileSync(join(out, 'notes.html'), 'utf8');
  expect(page).toContain('<img src="diagram-1.png" alt="diagram-1">');
  expect(page).toContain('<table>');
  expect(page).toContain('<a id="part1"></a>');
  expect(page).not.toContain('부록: 다이어그램 목록');
  expect(readFileSync(join(out, 'notes.md'), 'utf8')).toContain('부록: 다이어그램 목록');
});

test('graph execution pauses at confirm; PDF skipped still finishes', async () => {
  const root = folder();
  const calls: string[] = [];
  const runBash = async (command: string) => {
    const stage = command.match(/node\.ts\" (collect|draft|render|html|pdf)/)?.[1];
    if (!stage) throw new Error(`unexpected command: ${command}`);
    calls.push(stage);
    return { stdout: `lecture-note /tmp inputs=1 diagrams=0 rendered=0 html=yes pdf=skipped\n${JSON.stringify({ outcome: stage === 'pdf' ? 'skipped' : 'ok' })}\n`, stderr: '', exitCode: 0 };
  };
  const deps = { root, runBash, processStartMs: () => null };
  const pending = await runGraph(graphPath, { input: { folder: root }, deps });
  expect(pending.status).toBe('awaiting-approval');
  expect(pending.pending?.nodeId).toBe('confirm');
  expect(pending.pending?.message).toBe('{"kind":"lecture-outline"}');
  expect(calls).toEqual(['collect', 'draft']);
  decideGraphApproval('lecture-note', pending.runId, 'approved', 'human', root);
  const finished = await runGraph(graphPath, { resumeRunId: pending.runId, deps });
  expect(finished.status).toBe('done');
  expect(finished.path).toEqual(['collect', 'draft', 'confirm', 'render', 'html', 'pdf', 'done']);
  expect(calls).toEqual(['collect', 'draft', 'render', 'html', 'pdf']);
});

test('failed Mermaid renderer keeps HTML fallback and uv cache out of the note output', async () => {
  const dir = folder();
  writeFileSync(join(dir, 'summary.md'), '강의');
  await collect(dir, { toolsPath: '' });
  await draft(dir, { llm: async () => '# 강의\n```mermaid\nflowchart LR\n A-->B\n```' });
  const tools = join(dir, 'fake-tools');
  mkdirSync(tools);
  const uv = join(tools, 'uv');
  writeFileSync(uv, '#!/bin/sh\nmkdir -p "$UV_CACHE_DIR/sdists-v9" "$UV_CACHE_DIR/interpreter-v4"\ntouch "$UV_CACHE_DIR/CACHEDIR.TAG"\necho "playwright not installed" >&2\necho "extra diagnostic" >&2\nexit 1\n');
  chmodSync(uv, 0o755);
  const stateDir = join(dir, 'state');
  const originalStateDir = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = stateDir;
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  const renderLog = spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(render(dir, { toolsPath: tools })).toMatchObject({ outcome: 'ok', diagrams: 1, rendered: 0 });
    expect(renderLog).toHaveBeenCalledWith('못 그림: 1');
    expect(log).toHaveBeenCalledWith('lecture-note.render', 'diagram-failed', {
      name: 'diagram-1', reason: 'Mermaid 렌더 실패 (diagram-1, exit=1): playwright not installed',
    });
  } finally {
    if (originalStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = originalStateDir;
    log.mockRestore(); renderLog.mockRestore();
  }
  const cache = join(stateDir, 'lecture-note/uv-cache');
  expect(readdirSync(cache).sort()).toEqual(['CACHEDIR.TAG', 'interpreter-v4', 'sdists-v9']);
  const out = join(dir, 'lecture-note');
  expect(html(dir).outcome).toBe('ok');
  expect(readFileSync(join(out, 'notes.html'), 'utf8')).toContain('<pre><code class="language-mermaid">');
  expect(readdirSync(out).sort()).toEqual(['diagram-1.mmd', 'inputs.json', 'notes.html', 'notes.md']);
  for (const name of ['CACHEDIR.TAG', 'sdists-v9', 'interpreter-v4']) expect(readdirSync(out)).not.toContain(name);
});

test('PDF conversion error fails, but a missing Playwright engine skips', () => {
  const dir = folder();
  const out = join(dir, 'lecture-note');
  mkdirSync(out);
  writeFileSync(join(out, 'notes.html'), '<html></html>');
  const tools = join(dir, 'fake-tools');
  mkdirSync(tools);
  const python = join(tools, 'python3');
  writeFileSync(python, '#!/bin/sh\necho "conversion error" >&2\nexit 2\n');
  chmodSync(python, 0o755);
  expect(() => pdf(dir, { toolsPath: tools })).toThrow('PDF 변환 실패 (exit=2): conversion error');
  writeFileSync(python, '#!/bin/sh\necho "ModuleNotFoundError: No module named \'playwright\'" >&2\nexit 1\n');
  expect(pdf(dir, { toolsPath: tools })).toMatchObject({ outcome: 'skipped', pdf: 'skipped' });
  writeFileSync(python, '#!/bin/sh\necho "BrowserType.launch: Executable doesn\x27t exist at /missing/chromium" >&2\nexit 1\n');
  expect(pdf(dir, { toolsPath: tools })).toMatchObject({ outcome: 'skipped', pdf: 'skipped' });
});

test('PDF failure after human approval reaches failed, unlike engine absence', async () => {
  const root = folder();
  const deps = { root, processStartMs: () => null, runBash: async (command: string) => ({
    stdout: `${JSON.stringify({ outcome: command.endsWith(' pdf') ? 'fail' : 'ok' })}\n`,
    stderr: '', exitCode: command.endsWith(' pdf') ? 1 : 0,
  }) };
  const pending = await runGraph(graphPath, { input: { folder: root }, deps });
  expect(pending.status).toBe('awaiting-approval');
  decideGraphApproval('lecture-note', pending.runId, 'approved', 'human', root);
  const finished = await runGraph(graphPath, { resumeRunId: pending.runId, deps });
  expect(finished.status).toBe('failed');
  expect(finished.path).toEqual(['collect', 'draft', 'confirm', 'render', 'html', 'pdf', 'failed']);
});

test('collect reads shared course materials without modifying sources/common', async () => {
  const dir = folder();
  const common = join(dir, 'sources/common');
  mkdirSync(common, { recursive: true });
  writeFileSync(join(common, 'syllabus.md'), '강의 계획');
  expect((await collect(dir, { toolsPath: '' })).inputs).toBe(1);
  expect(JSON.parse(readFileSync(join(dir, 'lecture-note/inputs.json'), 'utf8'))[0])
    .toMatchObject({ name: 'sources/common/syllabus.md', text: '강의 계획' });
  expect(readdirSync(common)).toEqual(['syllabus.md']);
});

test('CLI reads graph context and ends with an outcome JSON for graph runner', () => {
  const dir = folder();
  writeFileSync(join(dir, 'summary.md'), '# 요약');
  const result = spawnSync(process.execPath, [join(import.meta.dir, 'node.ts'), 'collect'], {
    encoding: 'utf8', env: { ...process.env, ELANOUS_GRAPH_CONTEXT: JSON.stringify({ input: { folder: dir } }) },
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(`lecture-note ${dir} inputs=1 diagrams=0 rendered=0 html=no pdf=skipped`);
  expect(result.stdout.trim().split('\n').at(-1)).toBe('{"outcome":"ok"}');
  expect(readdirSync(dir).sort()).toEqual(['lecture-note', 'summary.md']);
});

test('dangling symlink at an output artifact cannot redirect or be overwritten', async () => {
  const dir = folder();
  const target = join(folder(), 'elsewhere.json');
  mkdirSync(join(dir, 'lecture-note'));
  symlinkSync(target, join(dir, 'lecture-note/inputs.json'));
  writeFileSync(join(dir, 'summary.md'), 'untouched');
  await expect(collect(dir)).rejects.toThrow('출력 파일이 안전하지 않다');
  expect(readdirSync(resolve(target, '..'))).toEqual([]);
});

test('a symlinked output directory cannot escape the lecture folder', async () => {
  const dir = folder();
  const elsewhere = folder();
  writeFileSync(join(dir, 'summary.md'), 'untouched');
  symlinkSync(elsewhere, join(dir, 'lecture-note'));
  await expect(collect(dir)).rejects.toThrow('출력 폴더가 안전하지 않다');
  expect(readdirSync(elsewhere)).toEqual([]);
});
