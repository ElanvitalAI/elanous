import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextPersonaTodo, personaTodoPath, readPersonaTodos, writePersonaTodos, type PersonaTodo } from './persona-todo.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'persona-todo-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const newest: PersonaTodo = { id: 'new', title: 'New task', status: 'open', createdAt: '2026-10-03T00:00:00Z' };
const done: PersonaTodo = { id: 'done', title: 'Completed task', status: 'done', createdAt: '2026-09-01T00:00:00Z' };
const oldest: PersonaTodo = { id: 'old', title: 'Old task', status: 'open', createdAt: '2026-10-01T00:00:00Z' };

describe('persona todo JSONL', () => {
  test('writes and reads per persona; selects the oldest open item among two open and one done', () => {
    writePersonaTodos(dir, 'alice', [newest, done, oldest]);
    expect(readFileSync(personaTodoPath(dir, 'alice'), 'utf8').trim().split('\n')).toHaveLength(3);
    expect(readPersonaTodos(dir, 'alice')).toEqual({ todos: [newest, done, oldest], errors: [] });
    expect(nextPersonaTodo(readPersonaTodos(dir, 'alice').todos)).toEqual(oldest);
    expect(readPersonaTodos(dir, 'bob')).toEqual({ todos: [], errors: [] });
  });

  test('a missing file is empty, and no open todo yields null', () => {
    expect(readPersonaTodos(dir, 'missing')).toEqual({ todos: [], errors: [] });
    expect(nextPersonaTodo([done])).toBeNull();
    writePersonaTodos(dir, 'empty', []);
    expect(readPersonaTodos(dir, 'empty')).toEqual({ todos: [], errors: [] });
  });

  test('skips malformed JSON and invalid records while observing line numbers', () => {
    writeFileSync(personaTodoPath(dir, 'alice'), `${JSON.stringify(newest)}\n{broken\n${JSON.stringify({ ...done, status: 'other' })}\n${JSON.stringify(oldest)}\n`);
    const result = readPersonaTodos(dir, 'alice');
    expect(result.todos).toEqual([newest, oldest]);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.map(error => error.line)).toEqual([2, 3]);
    expect(result.errors.every(error => error.message.length > 0)).toBe(true);
    expect(nextPersonaTodo(result.todos)).toEqual(oldest);
  });

  test('rejects path traversal and invalid records before writing', () => {
    expect(() => personaTodoPath(dir, '../elsewhere')).toThrow('Invalid persona id');
    expect(() => writePersonaTodos(dir, 'alice', [{ ...oldest, createdAt: 'invalid' }])).toThrow('Invalid todo record');
    expect(readPersonaTodos(dir, 'alice')).toEqual({ todos: [], errors: [] });
  });
});
