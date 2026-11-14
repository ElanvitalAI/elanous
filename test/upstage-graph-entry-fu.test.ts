import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setElanousConfigDir, resetElanousConfigDir } from '../src/elanous-config-dir.js';
import { setCredentialSlotAsync, useBackend } from '../src/nexus/config/secrets/index.js';
import { registerGraphCommands } from '../src/graph-runner/graph-cli.js';
import { latestGraphRun } from '../src/graph-runner/runner.js';
import { startFakeUpstageServer } from './fixtures/fake-upstage-server.js';

const embeddingGraph = join(import.meta.dir, '../plugins/upstage-embeddings/graphs/embeddings.yaml');
const extractGraph = join(import.meta.dir, '../plugins/upstage-information-extract/graphs/information-extract.yaml');

test('landed P3/P4 graphProviders factories reach the one fake through the default graph CLI', async () => {
  const root = mkdtempSync(join(tmpdir(), 'upstage-default-entry-'));
  const fake = await startFakeUpstageServer();
  const priorNodeEnv = process.env.NODE_ENV;
  const priorBase = process.env.UPSTAGE_BASE_URL;
  const priorExit = process.exitCode;
  try {
    setElanousConfigDir(join(root, 'config'));
    useBackend('file');
    await setCredentialSlotAsync('cred:upstage.api_key', 'fake-upstage-key');
    process.env.NODE_ENV = 'test';
    process.env.UPSTAGE_BASE_URL = fake.baseUrl;
    const stateRoot = join(root, 'runs');
    const program = new Command();
    registerGraphCommands(program, { root: stateRoot }); // no injected capabilityProviders
    const run = async (file: string, input: unknown) => {
      process.exitCode = 0;
      await program.parseAsync(['node', 'elanous', 'graph', 'run', file, '--input', JSON.stringify(input)]);
      return process.exitCode;
    };

    expect(await run(embeddingGraph, { input: 'synthetic query', consent: true })).toBe(0);
    const query = latestGraphRun('upstage-embeddings', stateRoot);
    expect(query?.status).toBe('done');
    const queryOutput = JSON.parse(String(query?.nodes.find(node => node.nodeId === 'embed')?.output));
    expect(queryOutput.result).toMatchObject({ model: 'solar-embedding-2-query', purpose: 'query', dimensions: 1024 });

    expect(await run(embeddingGraph, { input: 'synthetic passage', consent: true, purpose: 'passage' })).toBe(0);
    const passage = latestGraphRun('upstage-embeddings', stateRoot);
    expect(passage?.status).toBe('done');
    const passageOutput = JSON.parse(String(passage?.nodes.find(node => node.nodeId === 'embed')?.output));
    expect(passageOutput.result).toMatchObject({ model: 'solar-embedding-2-passage', purpose: 'passage' });

    const schema = { type: 'object', properties: { reference: { type: 'string' } }, required: ['reference'], additionalProperties: false };
    const extractExit = await run(extractGraph, { documentDataUrl: 'data:application/pdf;base64,JVBERi0xLjQ=', schemaName: 'synthetic', schema, consentToUpstage: true });
    const extraction = latestGraphRun('upstage-information-extract', stateRoot);
    expect(extractExit, JSON.stringify(extraction)).toBe(0);
    expect(extraction?.status).toBe('done');
    const extracted = JSON.parse(String(extraction?.nodes.find(node => node.nodeId === 'extract')?.output));
    expect(extracted.result).toEqual({ reference: 'SYNTHETIC-1' });

    expect(fake.requests.map(request => request.path)).toEqual([
      '/v1/embeddings', '/v1/embeddings', '/v1/information-extraction',
    ]);
    expect(fake.requests.every(request => request.authorized)).toBe(true);
    expect(fake.requests.map(request => JSON.parse(request.body).model)).toEqual([
      'solar-embedding-2-query', 'solar-embedding-2-passage', 'information-extract',
    ]);
    expect(JSON.stringify([queryOutput, passageOutput, extracted, fake.requests])).not.toContain('fake-upstage-key');
  } finally {
    await fake.close();
    resetElanousConfigDir();
    useBackend('file');
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorNodeEnv;
    if (priorBase === undefined) delete process.env.UPSTAGE_BASE_URL;
    else process.env.UPSTAGE_BASE_URL = priorBase;
    process.exitCode = priorExit ?? 0;
    rmSync(root, { recursive: true, force: true });
  }
});
