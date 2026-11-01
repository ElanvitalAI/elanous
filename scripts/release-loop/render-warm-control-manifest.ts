#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONTROL_PORT } from '../../src/control-plane/server.js';

const args = process.argv.slice(2);
const imageIndex = args.indexOf('--image');
const namespaceIndex = args.indexOf('--namespace');
const image = imageIndex >= 0 ? args[imageIndex + 1] : undefined;
const namespace = namespaceIndex >= 0 ? args[namespaceIndex + 1] : undefined;
if (args.length !== 4 || imageIndex < 0 || namespaceIndex < 0 || imageIndex === namespaceIndex
  || !image || !namespace || !/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(namespace)
  || !/^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?\/[a-zA-Z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(image)) {
  process.stderr.write('usage: bun scripts/release-loop/render-warm-control-manifest.ts --image <repository@sha256:digest> --namespace <namespace>\n');
  process.exitCode = 2;
} else {
  const template = readFileSync(join(import.meta.dir, '../../docker/warm-control/control.yaml.tmpl'), 'utf8');
  if (!template.includes('{{CONTROL_IMAGE}}') || !template.includes('{{NAMESPACE}}') || !template.includes('{{CONTROL_PORT}}'))
    throw new Error('warm control manifest placeholder missing');
  process.stdout.write(template.replaceAll('{{CONTROL_IMAGE}}', image)
    .replaceAll('{{NAMESPACE}}', namespace).replaceAll('{{CONTROL_PORT}}', String(DEFAULT_CONTROL_PORT)));
}
