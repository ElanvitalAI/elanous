import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { handleWorkflowPut, handleWorkflowDelete } from '../src/nexus/api/workflows.js';
import type { MetaApiOpts } from '../src/nexus/api/meta-api.js';

const opts: MetaApiOpts = { noAuth: true };
const YAML = 'name: t-api-demo\ndescription: API test demo\nnodes:\n  - id: one\n    bash: echo hello\n';
let root: string;
let cwd: string;
beforeEach(() => {
  cwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'wf-readonly-'));
  mkdirSync(join(root, '.elanous', 'workflows'), { recursive: true });
  process.chdir(root);
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(root, { recursive: true, force: true });
});
const headers = { 'sec-fetch-site': 'same-origin' };
const put = (name: string, yaml: string) => handleWorkflowPut(new Request(`http://localhost/v1/workflows/${name}`, {
  method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ yaml }),
}), name, opts);
const del = (name: string) => handleWorkflowDelete(new Request(`http://localhost/v1/workflows/${name}`, {
  method: 'DELETE', headers,
}), name, opts);

describe('readonly workflow PUT/DELETE guard', () => {
  it('rejects overwrite and delete with 409 without touching source or backup; a new copy saves', async () => {
    const original = YAML.replace('description:', 'readonly: true\ndescription:');
    const file = join(root, '.elanous', 'workflows', 't-api-demo.yaml');
    writeFileSync(file, original);
    const response = await put('t-api-demo', YAML);
    expect(response.status).toBe(409);
    expect((await response.json() as { error: string }).error).toBe('readonly_workflow');
    expect(readFileSync(file, 'utf-8')).toBe(original);
    expect(existsSync(`${file}.bak`)).toBe(false);
    expect((await put('t-api-demo', 'name: t-api-demo\n')).status).toBe(409);
    const deleted = del('t-api-demo');
    expect(deleted.status).toBe(409);
    expect((await deleted.json() as { error: string }).error).toBe('readonly_workflow');
    expect(readFileSync(file, 'utf-8')).toBe(original);
    const copy = YAML.replace('t-api-demo', 't-api-demo-copy');
    expect((await put('t-api-demo-copy', copy)).status).toBe(200);
    expect(readFileSync(join(root, '.elanous', 'workflows', 't-api-demo-copy.yaml'), 'utf-8')).toBe(copy);
  });
  it('protects .yml against both methods; false and absent preserve ordinary overwrite/delete', async () => {
    const dir = join(root, '.elanous', 'workflows');
    const yml = join(dir, 't-api-demo.yml');
    const locked = YAML.replace('description:', 'readonly: true\ndescription:');
    writeFileSync(yml, locked);
    expect((await put('t-api-demo', YAML)).status).toBe(409);
    expect(del('t-api-demo').status).toBe(409);
    expect(readFileSync(yml, 'utf-8')).toBe(locked);
    writeFileSync(yml, YAML.replace('description:', 'readonly: false\ndescription:'));
    expect(del('t-api-demo').status).toBe(200);
    expect((await put('t-api-demo', YAML)).status).toBe(200);
    expect((await put('t-api-demo', YAML.replace('echo hello', 'echo changed'))).status).toBe(200);
    expect(readFileSync(join(dir, 't-api-demo.yaml'), 'utf-8')).toContain('echo changed');
    expect(del('t-api-demo').status).toBe(200);
  });
});
