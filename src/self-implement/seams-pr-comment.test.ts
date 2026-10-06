import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSeams } from './seams.js';

const marker = '<!-- elanous:run-status -->';
const previous = { PATH: process.env.PATH, GH_TOKEN: process.env.GH_TOKEN, GH_LOG: process.env.GH_LOG, GH_RESPONSE: process.env.GH_RESPONSE };
const directories: string[] = [];

afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeGh(response: string): { cwd: string; args: () => string[]; token: () => string } {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-comment-seam-'));
  directories.push(cwd);
  const binary = join(cwd, 'gh');
  writeFileSync(binary, '#!/bin/sh\nprintf "%s\\0" "$@" > "$GH_LOG"\nprintf "%s" "$GH_TOKEN" > "$GH_LOG.token"\ncat "$GH_RESPONSE"\n');
  chmodSync(binary, 0o755);
  writeFileSync(join(cwd, 'response'), response);
  process.env.PATH = `${cwd}:${previous.PATH ?? ''}`;
  process.env.GH_TOKEN = 'unit-test-token';
  process.env.GH_LOG = join(cwd, 'args');
  process.env.GH_RESPONSE = join(cwd, 'response');
  return {
    cwd,
    args: () => readFileSync(join(cwd, 'args'), 'utf8').split('\0').slice(0, -1),
    token: () => readFileSync(join(cwd, 'args.token'), 'utf8'),
  };
}

describe('PR issue comment seams', () => {
  test('finds a marked comment on a later page and returns its ID and existing body', async () => {
    const gh = fakeGh(JSON.stringify([[{ id: 1, body: 'unrelated' }], [{ id: 2, body: `history\n${marker}\nround 1` }]]));
    const found = await defaultSeams().findPrComment!({ number: 7, marker, cwd: gh.cwd });
    expect(found).toEqual({ id: 2, body: `history\n${marker}\nround 1` });
    expect(gh.args()).toEqual(['api', '--paginate', '--slurp', '--method', 'GET', '-f', 'per_page=100', 'repos/{owner}/{repo}/issues/7/comments']);
    expect(gh.token()).toBe('unit-test-token');
  });

  test('uses supplied comment pages without querying gh; no match means absent', async () => {
    const seams = defaultSeams();
    const gh = fakeGh('');
    expect(await seams.findPrComment!({ number: 7, marker, cwd: gh.cwd, comments: [[{ id: 6, body: 'other' }]] })).toBeUndefined();
    expect(await seams.findPrComment!({ number: 7, marker, cwd: gh.cwd, comments: [[{ id: 8, body: marker }]] })).toEqual({ id: 8, body: marker });
    await expect(Bun.file(join(gh.cwd, 'args')).exists()).resolves.toBe(false);
  });

  test('rejects invalid comment data rather than interpreting it as absence', async () => {
    const gh = fakeGh('not-json');
    await expect(defaultSeams().findPrComment!({ number: 7, marker, cwd: gh.cwd })).rejects.toThrow();
    await expect(defaultSeams().findPrComment!({ number: 7, marker, cwd: gh.cwd, comments: [[{ body: marker }]] })).rejects.toThrow('invalid comment');
  });

  test('edits by issue comment ID with PATCH, retaining multiline body and automation credentials', async () => {
    const gh = fakeGh('{}');
    const body = `${marker}\n<details>\nround 1\n</details>`;
    await defaultSeams().editPrComment!({ id: 42, body, cwd: gh.cwd });
    expect(gh.args()).toEqual(['api', '--method', 'PATCH', 'repos/{owner}/{repo}/issues/comments/42', '-f', `body=${body}`]);
    expect(gh.token()).toBe('unit-test-token');
  });

  test('postPrComment still creates a separate PR comment with the original arguments', async () => {
    const gh = fakeGh('');
    await defaultSeams().postPrComment!({ number: 7, body: 'separate note', cwd: gh.cwd });
    expect(gh.args()).toEqual(['pr', 'comment', '7', '--body', 'separate note']);
    expect(gh.token()).toBe('unit-test-token');
  });
});
