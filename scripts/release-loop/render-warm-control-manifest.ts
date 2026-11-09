#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONTROL_PORT } from '../../src/control-plane/server.js';
import { validateRemotePrimaryCandidates, type RemotePrimaryCandidate } from '../../src/control-plane/remote-primary-candidates.js';

const args = process.argv.slice(2);
const imageIndex = args.indexOf('--image');
const namespaceIndex = args.indexOf('--namespace');
const image = imageIndex >= 0 ? args[imageIndex + 1] : undefined;
const namespace = namespaceIndex >= 0 ? args[namespaceIndex + 1] : undefined;
const candidatesIndex = args.indexOf('--primary-candidates-file');
const candidatesPath = candidatesIndex >= 0 ? args[candidatesIndex + 1] : undefined;
if (args.length !== (candidatesIndex >= 0 ? 6 : 4) || imageIndex < 0 || namespaceIndex < 0 || imageIndex === namespaceIndex
  || (candidatesIndex >= 0 && (!candidatesPath || !candidatesPath.startsWith('/')))
  || !image || !namespace || !/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(namespace)
  || !/^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?\/[a-zA-Z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(image)) {
  process.stderr.write('usage: bun scripts/release-loop/render-warm-control-manifest.ts --image <repository@sha256:digest> --namespace <namespace> [--primary-candidates-file ABSOLUTE]\n');
  process.exitCode = 2;
} else {
  const template = readFileSync(join(import.meta.dir, '../../docker/warm-control/control.yaml.tmpl'), 'utf8');
  if (!template.includes('{{CONTROL_IMAGE}}') || !template.includes('{{NAMESPACE}}') || !template.includes('{{CONTROL_PORT}}'))
    throw new Error('warm control manifest placeholder missing');
  let rendered = template.replaceAll('{{CONTROL_IMAGE}}', image)
    .replaceAll('{{NAMESPACE}}', namespace).replaceAll('{{CONTROL_PORT}}', String(DEFAULT_CONTROL_PORT));
  if (candidatesPath) {
    const candidates = validateRemotePrimaryCandidates(JSON.parse(readFileSync(candidatesPath, 'utf8')) as RemotePrimaryCandidate[]);
    const endpoints = candidates.map(candidate => {
      if (!candidate.egressIp) throw new Error('all HQ candidates need egressIp for a cluster manifest');
      const url = new URL(candidate.url);
      if (url.protocol !== 'https:' || !url.port || !/^[a-z0-9.-]+$/.test(url.hostname))
        throw new Error('HQ candidate needs an HTTPS DNS hostname and explicit port');
      return { host: url.hostname, ip: candidate.egressIp, port: Number(url.port) };
    });
    if (new Set(endpoints.map(item => item.host)).size !== endpoints.length) throw new Error('HQ candidate DNS hostnames must be distinct');
    const hostAliases = endpoints.map(item => `      - ip: ${item.ip}\n        hostnames: [${item.host}]`).join('\n');
    rendered = rendered.replace('      automountServiceAccountToken: false',
      `      hostAliases:\n${hostAliases}\n      automountServiceAccountToken: false`);
    rendered = rendered.replace('          test "$(stat -c \'%a\' /var/lib/elanous/control/tokens.json)" = 600',
      `          test "$(stat -c '%a' /var/lib/elanous/control/tokens.json)" = 600\n          install -m 0600 /run/primary-candidates/primary-candidates.json /var/lib/elanous/control/primary-candidates.json`);
    rendered = rendered.replace('        - name: control-token\n          mountPath: /run/secrets\n          readOnly: true',
      '        - name: control-token\n          mountPath: /run/secrets\n          readOnly: true\n        - name: primary-candidates\n          mountPath: /run/primary-candidates\n          readOnly: true');
    rendered = rendered.replace(`"--port", "${DEFAULT_CONTROL_PORT}"]`,
      `"--port", "${DEFAULT_CONTROL_PORT}", "--primary-candidates-file", "/var/lib/elanous/control/primary-candidates.json"]`);
    rendered = rendered.replace('      - name: tmp\n        emptyDir: {}',
      '      - name: primary-candidates\n        secret:\n          secretName: elanous-primary-candidates\n          defaultMode: 0440\n      - name: tmp\n        emptyDir: {}');
    const egress = endpoints.map(item => `  - to: [{ ipBlock: { cidr: ${item.ip}/32 } }]\n    ports: [{ protocol: TCP, port: ${item.port} }]`).join('\n');
    rendered += `\n---\napiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: elanous-control-to-hq-candidates\n  namespace: ${namespace}\nspec:\n  podSelector:\n    matchLabels:\n      app: elanous-control\n  policyTypes: [Egress]\n  egress:\n  - to: [{ namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: kube-system } } }]\n    ports: [{ protocol: UDP, port: 53 }, { protocol: TCP, port: 53 }]\n${egress}\n`;
  }
  process.stdout.write(rendered);
}
