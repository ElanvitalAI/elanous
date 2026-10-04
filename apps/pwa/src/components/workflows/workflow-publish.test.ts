import { expect, test } from 'bun:test';
import { publishEntries } from './workflow-publish';

const base = 'https://example.test:3000/';

test('webhook POST and GET produce their actual daemon addresses and method-specific curl', () => {
  const entries = publishEntries(`nodes:
  - id: receive
    webhookTrigger:
      method: POST
      path: /hooks/receive
  - id: lookup
    webhookTrigger:
      method: GET
      path: /hooks/lookup
`, base);
  expect(entries).toEqual([
    {
      kind: 'webhook', nodeId: 'receive', method: 'POST', auth: 'open',
      url: 'https://example.test:3000/v1/workflows/webhooks/hooks/receive',
      curl: "curl -X POST 'https://example.test:3000/v1/workflows/webhooks/hooks/receive' -H 'content-type: application/json' -d '{}'",
    },
    {
      kind: 'webhook', nodeId: 'lookup', method: 'GET', auth: 'open',
      url: 'https://example.test:3000/v1/workflows/webhooks/hooks/lookup',
      curl: "curl -X GET 'https://example.test:3000/v1/workflows/webhooks/hooks/lookup'",
    },
  ]);
  expect(entries[1]!.curl).not.toContain('-d');
});

test('chat curl includes message; bearer uses a placeholder and never returns YAML token', () => {
  const token = 'never-expose-this-secret-8392';
  const entries = publishEntries(`nodes:
  - id: chat
    chatTrigger:
      path: /support
      auth:
        type: bearer
        token: ${token}
`, base);
  expect(entries).toEqual([{
    kind: 'chat', nodeId: 'chat', method: 'POST', auth: 'bearer',
    url: 'https://example.test:3000/v1/workflows/chat/support',
    curl: "curl -X POST 'https://example.test:3000/v1/workflows/chat/support' -H 'content-type: application/json' -d '{\"message\":\"안녕하세요\"}' -H 'authorization: Bearer <토큰>'",
  }]);
  expect(JSON.stringify(entries)).not.toContain(token);
});

test('webhook hmac leaves a signature reminder without emitting its secretRef', () => {
  const entries = publishEntries(`nodes:
  - id: hook
    webhookTrigger:
      method: PATCH
      path: /signed
      auth:
        type: hmac
        secretRef: private-signing-reference
`, 'https://example.test:3000///');
  expect(entries[0]?.auth).toBe('hmac');
  expect(entries[0]?.curl).toBe("curl -X PATCH 'https://example.test:3000/v1/workflows/webhooks/signed' -H 'content-type: application/json' -d '{}' # 서명 헤더 필요");
  expect(JSON.stringify(entries)).not.toContain('private-signing-reference');
});

test('invalid YAML, missing nodes and workflows without external triggers have no entries', () => {
  expect(publishEntries('nodes: [', base)).toEqual([]);
  expect(publishEntries('name: empty', base)).toEqual([]);
  expect(publishEntries('nodes: []', base)).toEqual([]);
  expect(publishEntries('nodes:\n  - id: run\n    manualTrigger: {}', base)).toEqual([]);
});
