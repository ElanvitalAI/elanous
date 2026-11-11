import { pathToFileURL } from 'node:url';

const adapterPath = process.env.ELANOUS_SIM_REAL_TARGET_ADAPTER;
const itemJson = process.env.ELANOUS_SIM_REAL_TARGET_ITEM;
if (process.env.ELANOUS_SIM_REAL_TARGET_OS_SANDBOXED !== '1' || !adapterPath || !itemJson) {
  console.error('real target worker requires an OS sandbox and declared input');
  process.exit(2);
}

try {
  const item = Object.freeze(JSON.parse(itemJson) as Record<string, unknown>);
  const module = await import(pathToFileURL(adapterPath).href) as { run?: (item: Readonly<Record<string, unknown>>) => Promise<unknown> };
  if (typeof module.run !== 'function') throw new Error('adapter entry missing');
  const receipt = await module.run(item);
  console.log(JSON.stringify(receipt));
} catch {
  console.error('real target worker failed');
  process.exitCode = 2;
}
