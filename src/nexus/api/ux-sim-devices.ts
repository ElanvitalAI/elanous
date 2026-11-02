import { loadMockScenarioCatalog } from '../../ux-sim/mock-scenario-catalog.js';
import { UX_SIM_DEVICES_PATH } from './rest-route-paths.js';

export function isUxSimDevicesPath(pathname: string): boolean {
  return pathname === UX_SIM_DEVICES_PATH;
}

/** Read the canonical mock catalog. This handler never runs a device or writes usage. */
export function handleUxSimDevices(req: Request): Response {
  if (req.method !== 'GET') {
    return jsonResponse({ error: 'method not allowed' }, 405);
  }
  try {
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

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
