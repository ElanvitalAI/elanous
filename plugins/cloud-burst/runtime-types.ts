import type { CloudBurstRequest, CloudBurstResult } from './service.js';

/** Adapter boundary for a user-owned provider connection and its run receipt store. */
export interface CloudBurstCommandRuntime {
  request(input: CloudBurstRequest): Promise<CloudBurstResult>;
  report(requestId: string): Promise<string>;
}
