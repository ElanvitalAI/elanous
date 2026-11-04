import { createFakeCloudVm } from '../../src/ux-sim/fake-cloud-vm.js';
import type { CloudBurstCloudPort, CloudBurstReceipt } from './service.js';
import { getCloudBurstCostReport, requestCloudBurstBasic } from './service.js';
import type { CloudBurstCommandRuntime } from './runtime-types.js';

/** Explicit, process-local mock route; it never contacts a cloud provider or reads credentials. */
export function createMockCloudBurstRuntime(options: { readonly beforeVmStart?: () => void } = {}): CloudBurstCommandRuntime {
  const fleet = createFakeCloudVm();
  const receipts = new Map<string, CloudBurstReceipt>();
  const runStartIndexes = new Map<string, number>();
  const cloud: CloudBurstCloudPort = {
    async quote() { return { hourlyCost: 12, readyAfterMs: 5_000 }; },
    async list() { return fleet.statusAll(); },
    async resume(_accountRef, id, resumeOptions) { options.beforeVmStart?.(); return fleet.resume(id, resumeOptions); },
    async createFromImage(_accountRef, input) { options.beforeVmStart?.(); return fleet.createFromImage(input); },
    async status(_accountRef, id) { return fleet.status(id); },
    async stop(_accountRef, id) { return fleet.stop(id); },
    async reportRun(receipt) {
      const current = fleet.status(receipt.vmId);
      const events = fleet.events();
      const startIndex = runStartIndexes.get(receipt.requestId);
      const startEvent = startIndex === undefined ? undefined : events[startIndex];
      if (!startEvent || startEvent.id !== receipt.vmId
        || (startEvent.type !== 'create-from-image' && startEvent.type !== 'resume')) {
        throw new Error(`cloud-burst: mock start event missing for ${receipt.requestId}`);
      }
      const stopEvent = events.slice(startIndex + 1).find(event => event.id === receipt.vmId && event.type === 'stop');
      if (stopEvent && stopEvent.type === 'stop') {
        const poweredOnMs = Math.max(0, stopEvent.at - startEvent.at);
        return { state: 'parked' as const, poweredOnMs, estimatedCost: poweredOnMs / (60 * 60 * 1000) * receipt.hourlyCost };
      }
      const laterStart = events.slice(startIndex + 1).find(event => event.id === receipt.vmId
        && (event.type === 'create-from-image' || event.type === 'resume'));
      if (laterStart) throw new Error(`cloud-burst: mock stop event missing before later run ${receipt.requestId}`);
      const poweredOnMs = Math.max(0, current.poweredOnMs - receipt.baselinePoweredOnMs);
      return { state: current.state, poweredOnMs, estimatedCost: poweredOnMs / (60 * 60 * 1000) * receipt.hourlyCost };
    },
  };

  return {
    async request(input) {
      const eventStart = fleet.events().length;
      const result = await requestCloudBurstBasic({ ...input, accountRef: 'mock-profile' }, {
        local: { async tryAcquire() { return undefined; } }, cloud,
      });
      if (result.source !== 'local') {
        const events = fleet.events();
        const offset = events.slice(eventStart).findIndex(event => event.id === result.vm.id
          && (event.type === 'create-from-image' || event.type === 'resume'));
        if (offset < 0) throw new Error(`cloud-burst: mock start event missing for ${result.receipt.requestId}`);
        runStartIndexes.set(result.receipt.requestId, eventStart + offset);
        receipts.set(result.receipt.requestId, result.receipt);
      }
      return result;
    },
    async report(requestId) {
      const receipt = receipts.get(requestId);
      if (!receipt) throw new Error(`cloud-burst: no mock receipt for ${requestId}`);
      return getCloudBurstCostReport(receipt, cloud);
    },
  };
}
