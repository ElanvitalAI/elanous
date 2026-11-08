import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAppSourceSnapshot } from '../nexus/apps/app-source-snapshot.js';
import { createObjectStore } from '../storage/object-store.js';

const [root, sourceRoot, deploymentId, readyPath, startPath, resultPath] = process.argv.slice(2);
if (!root || !sourceRoot || !deploymentId || !readyPath || !startPath || !resultPath) throw new Error('worker arguments missing');
mkdirSync(root, { recursive: true });
writeFileSync(readyPath, 'ready');
while (!existsSync(startPath)) await new Promise(resolve => setTimeout(resolve, 2));
const objectStore = createObjectStore({ provider: 'local', localDir: join(root, 'objects'), bucket: '', publicBucket: '', prefix: 'apps' });
const result = createAppSourceSnapshot({
  appSlug: 'notes', deploymentId, sourceRoot, objectStore,
  record() { /* each worker's result file is the test's operation receipt */ },
});
writeFileSync(resultPath, JSON.stringify(result));
