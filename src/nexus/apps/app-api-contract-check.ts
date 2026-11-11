import type { AppManifest } from './app-contract.js';
import { appManifestToOpenApi } from './app-openapi.js';

export interface AppApiRoleCheck {
  readonly method: 'POST';
  readonly path: string;
  /** `anon` exercises the contract's public-read role without minting a role token. */
  readonly role: string;
  readonly auth: 'declared' | 'anonymous' | 'undeclared';
  readonly expected: 'allow' | 'deny';
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid generated OpenAPI contract');
  return value as Record<string, unknown>;
}

/** Deterministic request/role cases from the same OpenAPI artifact used by the app API surface.
 * This is the matrix planning slice; transport, response-schema checks and the live deploy gate follow separately. */
export function planAppApiRoleChecks(manifest: AppManifest): AppApiRoleCheck[] {
  const spec = record(appManifestToOpenApi(manifest));
  const components = record(spec.components);
  const schemes = record(components.securitySchemes);
  let undeclared = '__undeclared_role__';
  while (Object.hasOwn(schemes, undeclared) || undeclared === 'anon') undeclared += '_';
  const roles: Array<{ role: string; auth: AppApiRoleCheck['auth'] }> = [
    ...Object.keys(schemes).filter(role => role !== 'public').sort().map(role => ({ role, auth: 'declared' as const })),
    { role: 'anon', auth: 'anonymous' },
    { role: undeclared, auth: 'undeclared' },
  ];
  const cases: AppApiRoleCheck[] = [];
  for (const [path, methods] of Object.entries(record(spec.paths)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const post = record(record(methods).post);
    const allow = post['x-elanous-allow'];
    if (!Array.isArray(allow) || allow.length === 0 || allow.some(role => typeof role !== 'string' || !Object.hasOwn(schemes, role))) {
      throw new Error('invalid role allow-list in generated OpenAPI contract');
    }
    const allowed = new Set<string>(allow);
    for (const { role, auth } of roles) {
      cases.push({ method: 'POST', path, role, auth,
        expected: auth === 'undeclared' ? 'deny' : allowed.has(auth === 'anonymous' ? 'public' : role) ? 'allow' : 'deny' });
    }
  }
  return cases;
}
