import { afterEach, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addNode } from './node-maker.js';

const dirs: string[] = [];
function fixture(version = '1.2.3'): string {
  const dir = mkdtempSync(join(tmpdir(), 'node-maker-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: 'sample-plugin', version,
    extensions: { 'ai.elanous': { graphs: ['./graphs/main.yaml'], capabilities: ['fs:workdir'] } } }, null, 2) + '\n');
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function writeNode(dir: string, kind: string, graph = 'workflow', run = 'bash'): void {
  writeFileSync(join(dir, 'nodes', `${kind}.yaml`), `kind: ${kind}\ngraph: ${graph}\ninputs: { type: object }\nrun:\n  ${run}: echo ok\n`);
}

test('preflight refuses missing manifest and existing node without codex or writes', async () => {
  const missing = mkdtempSync(join(tmpdir(), 'node-maker-'));
  dirs.push(missing);
  let calls = 0;
  const codex = async () => { calls++; };
  await expect(addNode({ dir: missing, request: 'do work', kind: 'do-work', deps: { codex } })).rejects.toThrow('plugin.json');
  expect(existsSync(join(missing, 'nodes'))).toBe(false);
  const dir = fixture();
  mkdirSync(join(dir, 'nodes'));
  writeNode(dir, 'do-work');
  const before = readFileSync(join(dir, 'plugin.json'), 'utf8');
  await expect(addNode({ dir, request: 'do work', kind: 'do-work', deps: { codex } })).rejects.toThrow('already exists');
  expect(calls).toBe(0);
  expect(readFileSync(join(dir, 'plugin.json'), 'utf8')).toBe(before);
});

test('preflight refuses an already declared kind under a different filename without calling codex', async () => {
  const dir = fixture();
  mkdirSync(join(dir, 'nodes'));
  writeFileSync(join(dir, 'nodes', 'legacy-name.yaml'), 'kind: do-work\ngraph: workflow\ninputs: { type: object }\nrun:\n  bash: echo ok\n');
  const manifestPath = join(dir, 'plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.extensions['ai.elanous'].nodes = ['./nodes/legacy-name.yaml'];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const before = readFileSync(manifestPath);
  let calls = 0;
  await expect(addNode({ dir, request: 'do work', kind: 'do-work', deps: {
    codex: async () => { calls++; },
  } })).rejects.toThrow('node already exists: do-work');
  expect(calls).toBe(0);
  expect(existsSync(join(dir, 'nodes', 'do-work.yaml'))).toBe(false);
  expect(readFileSync(manifestPath)).toEqual(before);
});

test('dangling node symlink is refused before codex can write an outside file', async () => {
  const dir = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'node-maker-outside-'));
  dirs.push(outside);
  mkdirSync(join(dir, 'nodes'));
  const target = join(outside, 'do-work.yaml');
  const nodePath = join(dir, 'nodes', 'do-work.yaml');
  symlinkSync(target, nodePath);
  expect(lstatSync(nodePath).isSymbolicLink()).toBe(true);
  expect(existsSync(nodePath)).toBe(false);
  let calls = 0;
  const before = readFileSync(join(dir, 'plugin.json'));
  await expect(addNode({ dir, request: 'do work', kind: 'do-work', deps: { codex: async cwd => {
    calls++;
    writeNode(cwd, 'do-work');
  } } })).rejects.toThrow('node already exists');
  expect(calls).toBe(0);
  expect(existsSync(target)).toBe(false);
  expect(readFileSync(join(dir, 'plugin.json'))).toEqual(before);
});

test('workflow node passes loader validation, registers manifest path and increments only patch', async () => {
  const dir = fixture();
  let calls = 0;
  const result = await addNode({ dir, request: 'Send a digest to the next step', kind: 'send-digest', deps: {
    codex: async (cwd, prompt) => {
      calls++;
      expect(cwd).toBe(dir);
      expect(prompt).toContain('요청 원문:\nSend a digest to the next step');
      expect(prompt).toContain('graph: workflow');
      expect(prompt).toContain('nodes/send-digest.yaml');
      expect(prompt).toContain('plugin.json 및 다른 파일은 변경하지 말 것');
      writeNode(cwd, 'send-digest');
    },
  } });
  expect(calls).toBe(1);
  expect(result).toMatchObject({ status: 'added', kind: 'send-digest', version: '1.2.4', errors: [],
    timings: { write: expect.any(Number), validate: expect.any(Number) } });
  expect(result.timings.repair).toBeUndefined();
  const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'));
  expect(manifest.version).toBe('1.2.4');
  expect(manifest.extensions['ai.elanous'].nodes).toEqual(['./nodes/send-digest.yaml']);
  expect(manifest.extensions['ai.elanous'].capabilities).toEqual(['fs:workdir']);
  expect(manifest.extensions['ai.elanous'].graphs).toEqual(['./graphs/main.yaml']);
});

test('invalid harness node is repaired once; repair prompt includes validation failure', async () => {
  const dir = fixture('0.0.9');
  let calls = 0;
  const result = await addNode({ dir, request: 'do work', kind: 'do-work', deps: { codex: async (cwd, prompt) => {
    calls++;
    if (calls === 2) expect(prompt).toContain('node graph must be workflow');
    writeNode(cwd, 'do-work', calls === 1 ? 'harness' : 'workflow');
  } } });
  expect(calls).toBe(2);
  expect(result.status).toBe('added');
  expect(result.version).toBe('0.0.10');
  expect(result.timings.repair).toEqual(expect.any(Number));
});

test('invalid after repair fails and keeps manifest byte-for-byte unchanged', async () => {
  const dir = fixture();
  const before = readFileSync(join(dir, 'plugin.json'), 'utf8');
  let calls = 0;
  const result = await addNode({ dir, request: 'do work', kind: 'do-work', deps: { codex: async cwd => {
    calls++;
    writeNode(cwd, 'do-work', 'harness');
  } } });
  expect(calls).toBe(2);
  expect(result.status).toBe('failed');
  expect(result.errors).toContain('node graph must be workflow');
  expect(result.version).toBeUndefined();
  expect(readFileSync(join(dir, 'plugin.json'), 'utf8')).toBe(before);
});

test('codex failure leaves version unchanged and does not repair a failed write', async () => {
  const dir = fixture();
  const before = readFileSync(join(dir, 'plugin.json'), 'utf8');
  let calls = 0;
  const result = await addNode({ dir, request: 'do work', kind: 'do-work', deps: { codex: async () => { calls++; throw new Error('codex unavailable'); } } });
  expect(calls).toBe(1);
  expect(result.status).toBe('failed');
  expect(result.errors).toContain('codex unavailable');
  expect(readFileSync(join(dir, 'plugin.json'), 'utf8')).toBe(before);
});

test('symlinked nodes directory is rejected before codex writes through it', async () => {
  const dir = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'node-maker-outside-'));
  dirs.push(outside);
  symlinkSync(outside, join(dir, 'nodes'), 'dir');
  let calls = 0;
  await expect(addNode({ dir, request: 'do work', kind: 'do-work', deps: { codex: async () => { calls++; } } })).rejects.toThrow('unsafe nodes directory');
  expect(calls).toBe(0);
  expect(existsSync(join(outside, 'do-work.yaml'))).toBe(false);
});

test('codex may not mutate the manifest; rejected after one repair without version bump', async () => {
  const dir = fixture();
  const before = readFileSync(join(dir, 'plugin.json'), 'utf8');
  let calls = 0;
  const result = await addNode({ dir, request: 'do work', kind: 'do-work', deps: { codex: async cwd => {
    calls++;
    writeNode(cwd, 'do-work');
    if (calls === 1) writeFileSync(join(cwd, 'plugin.json'), before.replace('1.2.3', '9.9.9'));
  } } });
  expect(result.status).toBe('failed');
  expect(result.errors).toContain('plugin.json was modified');
  expect(calls).toBe(2);
  expect(result.version).toBeUndefined();
  expect(readFileSync(join(dir, 'plugin.json'))).toEqual(Buffer.from(before));
});

test('large major and minor remain exact while only patch increases', async () => {
  const dir = fixture('900719925474099312345.000900719925474099312345.99999999999999999999');
  const result = await addNode({ dir, request: 'do work', kind: 'do-work', deps: { codex: async cwd => { writeNode(cwd, 'do-work'); } } });
  expect(result.status).toBe('added');
  expect(result.version).toBe('900719925474099312345.000900719925474099312345.100000000000000000000');
  expect(JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')).version).toBe(result.version);
});

test('a manifest deleted by the first write is a validation error that one repair can fix', async () => {
  const dir = fixture();
  const before = readFileSync(join(dir, 'plugin.json'), 'utf8');
  const prompts: string[] = [];
  const result = await addNode({ dir, request: 'do work', kind: 'do-work', deps: { codex: async (cwd, prompt) => {
    prompts.push(prompt);
    writeNode(cwd, 'do-work');
    if (prompts.length === 1) rmSync(join(cwd, 'plugin.json'));
    else writeFileSync(join(cwd, 'plugin.json'), before);
  } } });
  expect(prompts.length).toBe(2);
  expect(prompts[1]).toContain('plugin.json was deleted');
  expect(result.status).toBe('added');
  expect(result.version).toBe('1.2.4');
});

test('a manifest deleted and never restored fails after one repair and is put back unchanged', async () => {
  const dir = fixture();
  const before = readFileSync(join(dir, 'plugin.json'));
  let calls = 0;
  const result = await addNode({ dir, request: 'do work', kind: 'do-work', deps: { codex: async cwd => {
    calls++;
    writeNode(cwd, 'do-work');
    rmSync(join(cwd, 'plugin.json'), { force: true });
  } } });
  expect(calls).toBe(2);
  expect(result.status).toBe('failed');
  expect(result.errors.some(error => error.includes('plugin.json was deleted'))).toBe(true);
  expect(result.version).toBeUndefined();
  expect(readFileSync(join(dir, 'plugin.json'))).toEqual(before);
});
