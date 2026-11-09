import { isRecord } from '../../primitives/guards.js';
import { loadMockScenarioCatalog } from '../../ux-sim/mock-scenario-catalog.js';
import { getTestStateRoot } from '../paths.js';
import { listMockDeviceRequests, MockDeviceRequestInputError, requestMockDevice } from '../../ux-sim/mock-device-requests.js';
import { UX_SIM_DEVICES_PATH } from './rest-route-paths.js';

export function isUxSimDevicesPath(pathname: string): boolean {
  return pathname === UX_SIM_DEVICES_PATH;
}

/** Read the canonical mock catalog. This handler never runs a device or writes usage. */
export async function handleUxSimDevices(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.searchParams.has('missing')) {
      if (!getTestStateRoot()) return jsonResponse({ error: 'mock-device-requests-require-test-universe' }, 403);
      const requests = listMockDeviceRequests();
      return jsonResponse({ missing: requests.filter((row) => row.state === 'missing'), resolved: requests.filter((row) => row.state === 'resolved') }, 200);
    }
    if (req.method === 'POST') {
      if (!getTestStateRoot()) return jsonResponse({ error: 'mock-device-requests-require-test-universe' }, 403);
      const input = await bodyToJson(req);
      if (!isRecord(input)) return jsonResponse({ error: 'request body must be an object' }, 400);
      if (typeof input.cellId !== 'string' || typeof input.boundary !== 'string' || typeof input.nearestDeviceId !== 'string') {
        return jsonResponse({ error: 'cellId, boundary, and nearestDeviceId are required' }, 400);
      }
      try {
        return jsonResponse(requestMockDevice({ cellId: input.cellId, boundary: input.boundary, nearestDeviceId: input.nearestDeviceId }), 201);
      } catch (error) {
        if (error instanceof MockDeviceRequestInputError) {
          return jsonResponse({ error: 'invalid-mock-device-request', detail: error.message }, 400);
        }
        return jsonResponse({ error: 'mock-device-request-storage-failed', detail: error instanceof Error ? error.message : String(error) }, 500);
      }
    }
    if (req.method !== 'GET') return jsonResponse({ error: 'method not allowed' }, 405);
    const catalog = loadMockScenarioCatalog();
    return jsonResponse({
      catalogVersion: catalog.version,
      devices: catalog.devices,
      scenarios: catalog.scenarios,
      runEvidence: catalog.runEvidence,
      candidateAudit: catalog.candidateAudit,
      discovery: catalog.discovery,
    }, 200);
  } catch (error) {
    return jsonResponse({
      error: 'mock-device-catalog-unavailable',
      detail: error instanceof Error ? error.message : String(error),
    }, 500);
  }
}

async function bodyToJson(req: Request): Promise<unknown> {
  try { return await req.json(); }
  catch { return null; }
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
