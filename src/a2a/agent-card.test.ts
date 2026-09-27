import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createAgentCard } from './agent-card.js';

describe('A2A Agent Card', () => {
  test('advertises the running package version, text modes and delegate capability', () => {
    const card = createAgentCard('http://127.0.0.1:3210/a2a');
    expect(card.name).toBe('elanous');
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dir, '../../package.json'), 'utf8')) as { version: string };
    expect(card.version).toBe(manifest.version);
    expect(card.defaultInputModes).toEqual(['text/plain']);
    expect(card.defaultOutputModes).toEqual(['text/plain']);
    expect(card.skills).toContainEqual(expect.objectContaining({
      id: 'delegate',
      name: 'Delegate to elanous',
    }));
  });

  test('advertises bearer authorization for JSON-RPC without embedding a token', () => {
    const card = createAgentCard('https://example.test/a2a');
    expect(card.securitySchemes).toEqual({ bearerAuth: { type: 'http', scheme: 'bearer' } });
    expect(card.security).toEqual([{ bearerAuth: [] }]);
    expect(JSON.stringify(card)).not.toContain('Authorization');
  });

  test('uses the supplied server URL rather than a fixed host or port', () => {
    expect(createAgentCard('https://agents.example.test/custom/rpc').url).toBe('https://agents.example.test/custom/rpc');
    expect(createAgentCard('http://localhost:4123/').url).toBe('http://localhost:4123/');
  });
});
