import { describe, expect, test } from 'bun:test';
import { parseAppManifest } from './app-contract.js';
import { appManifestToOpenApi, serializeOpenApi } from './app-openapi.js';

const yaml = `apiVersion: elanous.app/v0
slug: voice-note
title: Voice notes
frontend: { kind: static-export }
tables: { notes: {} }
roles:
  viewer: { via: share-link }
  owner: { via: nexus-session }
rpc:
  listNotes:
    sql: SELECT id FROM notes WHERE id = :limit
    params: { limit: { type: int, max: 200, default: 50 } }
    allow: [owner, viewer]
actions:
  transcribe: { builtin: stt, input: { audio: object-ref }, output: { text: text }, uses: [cred:openai.api_key] }
  summarize: { builtin: summarize, input: { text: text }, output: { text: text }, uses: [cred:openai.api_key] }
credentials: [cred:openai.api_key]
`;

describe('APP-OPENAPI-FROM-CONTRACT', () => {
  test('maps RPC, action, input schemas and declared role security', () => {
    const parsed = parseAppManifest(yaml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const spec = appManifestToOpenApi(parsed.manifest) as any;
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.paths['/rpc/listNotes'].post['x-elanous-allow']).toEqual(['owner', 'viewer']);
    expect(spec.paths['/rpc/listNotes'].post.requestBody.content['application/json'].schema)
      .toEqual({ $ref: '#/components/schemas/Rpc_listNotesRequest' });
    expect(spec.components.schemas.Rpc_listNotesRequest.properties.limit).toEqual({ type: 'integer', maximum: 200 });
    expect(spec.paths['/actions/transcribe'].post.security).toEqual([{ owner: [] }]);
    expect(spec.components.schemas.Action_transcribeRequest.properties.audio.format).toBe('uri-reference');
  });

  test('is byte deterministic and omits SQL and credential references', () => {
    const parsed = parseAppManifest(yaml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const first = serializeOpenApi(appManifestToOpenApi(parsed.manifest));
    const reordered = {
      ...parsed.manifest,
      roles: Object.fromEntries(Object.entries(parsed.manifest.roles ?? {}).reverse()),
      actions: Object.fromEntries(Object.entries(parsed.manifest.actions as Record<string, unknown>).reverse()),
    };
    const second = serializeOpenApi(appManifestToOpenApi(reordered));
    expect(first).toBe(second);
    expect(first).not.toContain('SELECT');
    expect(first).not.toContain('cred:');
  });
});
