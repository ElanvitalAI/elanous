// NEXUS · GET /v1/bots/commands — declared bot-command catalog
//
// Surfaces `botCommandCatalog()` over HTTP so an external consumer
// (PWA or otherwise) can ask "what commands can I give this bot?"
// without executing any of them. Execution is a later plate.
//
// Wire shape: the catalog array itself — not wrapped, no extra fields:
//   [
//     {
//       name: string,
//       description: string,
//       arguments: [{ name, description, required }]
//     }
//   ]
//
// Read-only · no auth (mirrors `/v1/worktrees` / `/v1/platforms`
// per existing same-origin enforcement layer).

import { botCommandCatalog } from '../../bots/command-surface.js';
import { jsonResponse } from './json-response.js';

/** GET /v1/bots/commands — see top-of-file wire shape. Returns the
 *  catalog array from `botCommandCatalog()` unchanged. Does not run
 *  handlers and does not invent fields (`hasHandler` is not a catalog
 *  key). */
export function handleBotCommands(): Response {
  return jsonResponse(botCommandCatalog(), 200);
}
