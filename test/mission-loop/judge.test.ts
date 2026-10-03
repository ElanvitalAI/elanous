import { setDefaultTimeout, afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { judgeMissionRequests } from '../../src/mission-loop/judge.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'mission-request-judge-'));
  roots.push(value);
  return value;
}

function request(id: string, intent = 'Test mission', schedule = '0 * * * *', requires = '[alpha.beta]'): string {
  return `---\nid: ${id}\nintent: "${intent}"\nschedule: "${schedule}"\nrequires: ${requires}\n---\n`;
}

function validRequest(intent = 'Test mission', schedule = '0 * * * *', requires = '[alpha.beta]'): string {
  const capabilities = requires.replace(/^\[|\]$/g, '').split(',').map((value) => value.trim()).filter(Boolean);
  const normalized = intent.trim().toLowerCase().replace(/\s+/g, ' ');
  const hash = createHash('sha256').update(`${normalized}|${schedule}|${[...capabilities].sort().join(',')}`).digest('hex').slice(0, 16);
  return request(`req:v1:${hash}`, intent, schedule, requires);
}

function writeRequest(authorityRoot: string, name: string, content: string): void {
  const dir = join(authorityRoot, 'docs/mission-requests');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
}

function writeCapability(authorityRoot: string, capability: string): void {
  const [directory, ...rest] = capability.split('.');
  const path = join(authorityRoot, 'src/mission-capabilities', directory!, `${rest.join('.')}.ts`);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'export {};\n');
}

const codeTreeCapabilityPath = (capability: string): string => {
  const [directory, ...rest] = capability.split('.');
  return join(fileURLToPath(new URL('../../src/mission-capabilities/', import.meta.url)), directory!, `${rest.join('.')}.ts`);
};

describe('judgeMissionRequests', () => {
  it('continues past invalid requests and reports structured missing capability reasons', () => {
    const authorityRoot = root();
    writeRequest(authorityRoot, 'a-invalid.md', 'not frontmatter');
    writeRequest(authorityRoot, 'b-valid.md', validRequest('Valid request', '0 * * * *', '[alpha.beta,gamma.delta]'));

    const result = judgeMissionRequests(authorityRoot);

    expect(result).toMatchObject({ catalogStatus: 'present', requestsScanned: 2, invalidCount: 1 });
    expect(result.judgments).toEqual([
      { file: 'a-invalid.md', status: 'invalid-request', reasons: ['프론트매터 없음'] },
      {
        file: 'b-valid.md', status: 'missing-capability', capabilityCount: 2,
        missingCapabilities: [
          { id: 'alpha.beta', path: codeTreeCapabilityPath('alpha.beta') },
          { id: 'gamma.delta', path: codeTreeCapabilityPath('gamma.delta') },
        ],
      },
    ]);
  });

  it('reports schema and hash failures without stopping valid request judgment', () => {
    const authorityRoot = root();
    writeRequest(authorityRoot, 'invalid-schema.md', request('req:v1:0000000000000000', 'Bad schema', '0 * * *', '[alpha/escape]'));
    writeRequest(authorityRoot, 'valid.md', validRequest('Valid request'));

    const result = judgeMissionRequests(authorityRoot);

    expect(result).toMatchObject({ requestsScanned: 2, invalidCount: 1 });
    expect(result.judgments[0]).toMatchObject({
      file: 'invalid-schema.md',
      status: 'invalid-request',
      reasons: [
        'schedule cron 5필드 아님',
        '능력 id 형식 위반: alpha/escape',
        '경로 탈출 문자: alpha/escape',
        expect.stringMatching(/^id 해시 불일치\(기대 req:v1:/),
      ],
    });
    expect(result.judgments[1]).toMatchObject({ file: 'valid.md', status: 'missing-capability' });
  });

  it('distinguishes a missing catalog from an empty catalog', () => {
    const authorityRoot = root();
    const result = judgeMissionRequests(authorityRoot);
    expect(result).toMatchObject({ catalogStatus: 'missing', requestsScanned: 0, invalidCount: 0, judgments: [] });
  });

  it('uses the code-tree registry rather than capability files in an isolated authority root', () => {
    const authorityRoot = root();
    writeRequest(authorityRoot, 'unregistered.md', validRequest('Unregistered', '0 * * * *', '[alpha.beta]'));
    writeCapability(authorityRoot, 'alpha.beta');
    writeRequest(authorityRoot, 'registered.md', validRequest('Registered', '1 * * * *', '[report.openprcount]'));

    const result = judgeMissionRequests(authorityRoot);

    expect(result.judgments).toContainEqual({
      file: 'unregistered.md', status: 'missing-capability', capabilityCount: 1,
      missingCapabilities: [{ id: 'alpha.beta', path: codeTreeCapabilityPath('alpha.beta') }],
    });
    expect(result.judgments).toContainEqual({ file: 'registered.md', status: 'missing-blueprint', capabilityCount: 1 });
  });

  it('uses only the supplied authority root for blueprint states after registry capability judgment', () => {
    const authorityRoot = root();
    writeRequest(authorityRoot, 'candidate.md', validRequest('Candidate', '0 * * * *', '[report.openprcount]'));
    const candidateId = /^id: (.+)$/m.exec(validRequest('Candidate', '0 * * * *', '[report.openprcount]'))![1]!;
    const blueprint = join(authorityRoot, 'src/mission-blueprints', `${candidateId.replace(/:/g, '-')}.ts`);
    mkdirSync(join(blueprint, '..'), { recursive: true });
    writeFileSync(blueprint, 'export {};\n');
    writeRequest(authorityRoot, 'missing.md', validRequest('Missing blueprint', '1 * * * *', '[report.openprcount]'));

    const result = judgeMissionRequests(authorityRoot);

    expect(result.judgments).toContainEqual({ file: 'candidate.md', status: 'blueprint-candidate', capabilityCount: 1, blueprintPath: blueprint });
    expect(result.judgments).toContainEqual({ file: 'missing.md', status: 'missing-blueprint', capabilityCount: 1 });
  });

  it('reaches runCompositeCycle through the CLI only with --tick', () => {
    const authorityRoot = root();
    writeRequest(authorityRoot, 'request.md', validRequest());
    const entry = resolve(import.meta.dir, '..', '..', 'scripts/mission-request-judge.ts');
    const run = spawnSync('bun', [entry, '--tick', '--root', authorityRoot], { encoding: 'utf8', env: { ...process.env, ELANOUS_MISSION_REQUEST_HARNESS_COMMAND: 'true' } });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('🔁 복합 회차 1건');
    expect(run.stdout).toContain('🟡 req:v1:');
    expect(run.stdout).toContain('goal-created');
  });

  it('reaches judgeMissionRequests through the CLI and preserves its stdout contract', () => {
    const authorityRoot = root();
    writeRequest(authorityRoot, 'request.md', validRequest());
    const entry = resolve(import.meta.dir, '..', '..', 'scripts/mission-request-judge.ts');
    const run = spawnSync('bun', [entry, '--root', authorityRoot], { encoding: 'utf8' });

    expect(run.status).toBe(0);
    expect(run.stdout).toBe([
      `📍 권위 트리: ${authorityRoot}`,
      `📍 요청 카탈로그: ${join(authorityRoot, 'docs/mission-requests')}`,
      '📏 훑은 요청 1건',
      '✅ request.md ⇒ 스키마 통과 · 능력 1개',
      '   🔴 missing-capability 1/1',
      `      · alpha.beta → ${codeTreeCapabilityPath('alpha.beta')}`,
      '📏 훑은 1 · invalid 0',
      '',
    ].join('\n'));
  });
});
