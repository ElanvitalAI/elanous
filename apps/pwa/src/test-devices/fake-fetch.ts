// Keep the PWA test seam narrow; the shared recorder lives in the root UX simulation package.
export { createFakeFetchDevice, withFakeFetchDevice } from '../../../../src/ux-sim/fake-fetch';
export type { FakeFetchCall, FakeFetchDevice, FakeFetchRequest, FakeFetchRoute } from '../../../../src/ux-sim/fake-fetch';
