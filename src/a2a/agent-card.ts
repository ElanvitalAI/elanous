import { packageVersion } from '../version/code-revision.js';

/** The public A2A discovery document. The bearer scheme describes the protected RPC endpoint; discovery itself is public. */
export function createAgentCard(serverUrl: string) {
  return {
    protocolVersion: '0.3.0',
    name: 'elanous',
    description: 'A self-healing agent for delegated work, research, and coding.',
    url: serverUrl,
    version: packageVersion(),
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{
      id: 'delegate',
      name: 'Delegate to elanous',
      description: 'Delegate a task to elanous for research, coding, or other agent work.',
      tags: ['delegate', 'research', 'coding'],
    }],
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer' },
    },
    security: [{ bearerAuth: [] }],
  };
}
