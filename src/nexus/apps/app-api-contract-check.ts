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

export interface RecordedAppApiCall {
  readonly method: string;
  /** Contract-relative OpenAPI path (/rpc/... or /actions/...), not a production host URL. */
  readonly path: string;
  readonly role: string;
  readonly status: number;
  readonly response: unknown;
}

export interface AppApiCallMismatch {
  /** Ordinal locators deliberately exclude caller-controlled route names and response values. */
  readonly path: string;
  readonly reason: 'route' | 'method' | 'status' | 'response-type' | 'missing-field';
}

export interface AppApiCheckReceipt {
  readonly world: 'simulation';
  readonly ok: boolean;
  readonly checkedCalls: number;
  readonly mismatches: readonly AppApiCallMismatch[];
  /** Stable call ordinals to replay against the fake host; never includes bodies or credentials. */
  readonly rerun: { readonly callIndexes: readonly number[] };
}

function matchesField(value: unknown, definition: unknown): boolean {
  const type = typeof definition === 'string' ? definition : record(definition).type;
  switch (type) {
    case 'int': return typeof value === 'number' && Number.isSafeInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'json': return value !== undefined;
    case 'text': case 'timestamp': case 'object-ref': return typeof value === 'string';
    default: return false;
  }
}

/** Compare captured fake-host calls with the implementation manifest. This receipt is simulation
 * evidence only: it neither runs network requests nor authorizes a production deployment gate.
 * Replaying rerun.callIndexes after repairing a host yields an independent new receipt. */
export function checkRecordedAppApiCalls(
  manifest: AppManifest,
  calls: readonly RecordedAppApiCall[],
): AppApiCheckReceipt {
  const matrix = planAppApiRoleChecks(manifest);
  const mismatches: AppApiCallMismatch[] = [];
  const rerun = new Set<number>();
  calls.forEach((call, index) => {
    const at = `/calls/${index}`;
    const issue = (path: string, reason: AppApiCallMismatch['reason']) => {
      mismatches.push({ path, reason });
      rerun.add(index);
    };
    const routes = matrix.filter(item => item.path === call.path);
    if (routes.length === 0) { issue(`${at}/path`, 'route'); return; }
    if (call.method !== 'POST') { issue(`${at}/method`, 'method'); return; }
    const allowed = routes.some(item => item.role === call.role && item.expected === 'allow');
    const actionName = call.path.startsWith('/actions/') ? decodeURIComponent(call.path.slice('/actions/'.length)) : undefined;
    const declaration = actionName === undefined ? undefined : record(record(manifest.actions)[actionName]);
    const expectedStatus = allowed ? declaration?.async === true ? 202 : 200 : 403;
    if (call.status !== expectedStatus) { issue(`${at}/status`, 'status'); return; }
    if (!allowed) return;
    if (!call.response || typeof call.response !== 'object' || Array.isArray(call.response)) {
      issue(`${at}/response`, 'response-type'); return;
    }
    const body = call.response as Record<string, unknown>;
    if (!declaration) {
      if (!Array.isArray(body.rows)) issue(`${at}/response/rows`, 'response-type');
      return;
    }
    if (body.ok !== true) issue(`${at}/response/ok`, 'response-type');
    if (declaration.async === true) {
      if (typeof body.jobId !== 'string' || body.jobId.length === 0) issue(`${at}/response/jobId`, 'response-type');
      return;
    }
    if (declaration.output === undefined) return;
    Object.entries(record(declaration.output)).forEach(([name, definition], fieldIndex) => {
      const location = `${at}/response/@field:${fieldIndex}`;
      if (!Object.hasOwn(body, name)) {
        const optional = typeof definition === 'object' && definition !== null && Object.hasOwn(definition, 'default');
        if (!optional) issue(location, 'missing-field');
      } else if (!matchesField(body[name], definition)) issue(location, 'response-type');
    });
  });
  if (calls.length === 0) mismatches.push({ path: '/calls', reason: 'missing-field' });
  return { world: 'simulation', ok: mismatches.length === 0, checkedCalls: calls.length,
    mismatches, rerun: { callIndexes: [...rerun] } };
}
