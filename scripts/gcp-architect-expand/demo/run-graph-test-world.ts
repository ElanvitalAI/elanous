/** Direct Graph v2 fake-world proof. No Google Cloud SDK, credentials, or paid calls. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { decideGraphApproval, runGraph } from '../../../src/graph-runner/runner.js';
import { runSharedDeliverables } from '../../../src/ux-sim/gcp-architect-expand/shared-deliverables.js';
import { registerGcpScene5FakeProvider } from '../../../src/ux-sim/gcp-architect-expand/scene5-fake-provider.js';
import { ticketDesignFromArchitectureJson } from './design-result.js';

const repo = resolve(import.meta.dir, '../../..');
const plugin = resolve(repo, 'plugins/gcp-architect-expand');
const scriptDir = import.meta.dir;
const target = resolve(process.argv[2] ?? join(repo, '.elanous-test/gcp-architect-graph-direct'));
const inputDir = join(target, 'shared-input');
const outDir = join(target, 'artifacts');
const stateRoot = join(target, 'graph-state');
const ticketDesignPath = resolve(process.argv[3] ?? join(plugin, 'demo/fixtures/ticketing-design.json'));
const pressurePath = resolve(process.argv[4] ?? join(plugin, 'demo/fixtures/pressure.json'));
const decision = process.argv[5];
if (decision !== undefined && decision !== 'y' && decision !== 'N') throw new Error('fake-world decision must be y or N');
const externalDesign = process.argv[3] !== undefined;
if (externalDesign && process.argv[4] === undefined) throw new Error('structured design JSON requires an explicit capacity signal path');
const sourceDir = externalDesign ? join(target, 'generated-from-design') : join(plugin, 'sim/sample-output');
const proposalPath = join(sourceDir, 'proposal.json');
const iconRegistryPath = join(repo, 'plugins/architecture-deliverables/references/official-gcp-icons.json');
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
if (externalDesign) {
  mkdirSync(sourceDir, { recursive: true });
  const propose = Bun.spawnSync(['bun', join(scriptDir, 'propose.ts'), '--ticket-design', ticketDesignPath,
    '--pressure', pressurePath, '--output', proposalPath], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
  if (propose.exitCode !== 0) throw new Error(`structured design proposal failed: ${new TextDecoder().decode(propose.stderr).slice(0, 600)}`);
  const rendererDir = join(repo, 'skills/diagram-master/references');
  const prepare = (command: string[]) => {
    const result = Bun.spawnSync(command, { cwd: rendererDir, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) {
      const detail = new TextDecoder().decode(result.stderr).trim().split('\n').at(-1) ?? 'unknown error';
      throw new Error(`fake-world renderer setup failed — cd ${rendererDir} && uv sync --extra python-engines && uv run --extra python-engines playwright install chromium (${detail})`);
    }
  };
  prepare(['uv', 'sync', '--extra', 'python-engines']);
  prepare(['uv', 'run', '--extra', 'python-engines', 'playwright', 'install', 'chromium']);
  const render = Bun.spawnSync(['uv', 'run', '--extra', 'python-engines', 'python',
    join(scriptDir, '../sim/build-sample.py'), '--proposal', proposalPath, '--output', sourceDir],
    { cwd: rendererDir, stdout: 'pipe', stderr: 'pipe' });
  if (render.exitCode !== 0) throw new Error(`fake-world design source render failed: ${new TextDecoder().decode(render.stderr).trim().split('\n').at(-1)}`);
}
const proposal = JSON.parse(readFileSync(proposalPath, 'utf8'));
const pressure = JSON.parse(readFileSync(pressurePath, 'utf8'));
const ticket = ticketDesignFromArchitectureJson(JSON.parse(readFileSync(ticketDesignPath, 'utf8')) as unknown);
if (JSON.stringify(ticket) !== JSON.stringify(proposal.ticketDesign)) throw new Error('proposal and structured design result differ');
if (proposal.estimate?.price !== 'unpriced' || proposal.realGcpCalls !== 0) throw new Error('fake world must have no quoted price or real GCP call');
mkdirSync(inputDir, { recursive: true });
const htmlPath = join(inputDir, 'architecture.html');
const diagramPath = join(inputDir, 'architecture.excalidraw');
const html = readFileSync(join(sourceDir, 'architecture-design.html'), 'utf8').replace('<section class="sheet" id="cover">', '<section class="sheet cover" id="cover">')
  .replace('>부록 A · 재현과 판정</h2>', '>부록</h2>');
if (!html.includes('class="sheet cover"')) throw new Error('cover marker missing');
writeFileSync(htmlPath, html);
const diagram = JSON.parse(readFileSync(join(sourceDir, 'architecture.excalidraw'), 'utf8'));
const knownAssets = JSON.parse(readFileSync(iconRegistryPath, 'utf8')).assets as Record<string,{sha256:string}>;
const assetByHash = new Map(Object.entries(knownAssets).map(([name, item]) => [item.sha256, name]));
const iconAssets: Record<string,string> = {};
for (const element of diagram.elements as Array<{type:string;fileId?:string;text?:string}>) {
  if (element.type === 'image' && element.fileId) {
    const dataUrl = diagram.files[element.fileId]?.dataURL;
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) throw new Error('embedded official icon missing');
    const hash = createHash('sha256').update(Buffer.from(dataUrl.split(',',2)[1], 'base64')).digest('hex');
    const path = assetByHash.get(hash);
    if (!path) throw new Error('GCP icon is absent from common official icon registry');
    iconAssets[element.fileId] = path;
  }
  if (element.type === 'text' && typeof element.text === 'string') {
    const names: Record<string,string> = {
      '01  사용자 · 설계':'USERS / 01  사용자 · 설계', '02  제어·엣지':'EDGE / 02  제어·엣지',
      '03  앱·컴퓨트':'APPLICATION / 03  앱·컴퓨트', '04  데이터':'DATA / 04  데이터',
      '05  관측 · 비용':'MONITORING / 05  관측 · 비용', '06  보안 경계':'SECURITY / 06  보안 경계',
      '범례 / 판독':'LEGEND / 범례 / 판독',
    };
    element.text = names[element.text] ?? element.text;
    if (/^[1-8]$/u.test(element.text)) element.text = '①②③④⑤⑥⑦⑧'[Number(element.text)-1];
  }
}
if (Object.keys(iconAssets).length < 3) throw new Error('official icon provenance incomplete');
diagram.metadata = { ...(diagram.metadata ?? {}), iconLibraryUrl:'https://cloud.google.com/icons', iconAssets,
  source:'GCP fake-world sample; common architecture output input adapter' };
writeFileSync(diagramPath, JSON.stringify(diagram,null,2)+'\n');
const called: string[] = [];
const registry = registerGcpScene5FakeProvider({
  proposal, pressure, outDir, stateRoot,
  onInvoke: nodeId => called.push(nodeId),
  deliverables: () => runSharedDeliverables({ designHtmlPath:htmlPath, diagramSourcePath:diagramPath,
    outDir,stateRoot:join(target,'shared-graph-state'),resourceRoot:repo,attachmentUrlBase:outDir }),
});
let graph = await runGraph(join(plugin,'graph.yaml'), {input:{ticketDesignPath,context:{memberId:'fake-test-member'}},quiet:true,
  deps:{root:stateRoot,capabilityProviders:registry}});
if (graph.status !== 'awaiting-approval' || graph.pending?.nodeId !== 'approve') throw new Error(`expected spending gate after outputs, got ${graph.status}/${graph.pending?.nodeId}`);
if (called.join(',') !== 'detect,design,deliverables') throw new Error(`unexpected provider calls: ${called.join(',')}`);
if (decision) {
  decideGraphApproval(graph.graphId, graph.runId, decision === 'y' ? 'approved' : 'rejected', 'fake-test-user', stateRoot);
  graph = await runGraph(join(plugin,'graph.yaml'), {resumeRunId:graph.runId,resumeGraphId:graph.graphId,quiet:true,
    deps:{root:stateRoot,capabilityProviders:registry}});
  const expected = decision === 'y' ? 'detect,design,deliverables,provision,schedule,idle-stop' : 'detect,design,deliverables';
  if (called.join(',') !== expected || graph.status !== (decision === 'y' ? 'done' : 'failed'))
    throw new Error(`fake-world decision did not follow graph edges: ${graph.status}/${called.join(',')}`);
}
const fakeCostLedgerPath = join(outDir, 'fake-gcp-runs', graph.graphId, graph.runId, 'cost-ledger.json');
if (decision === 'y') {
  if (!existsSync(fakeCostLedgerPath)) throw new Error('approved fake world has no cost ledger');
  const ledger = JSON.parse(readFileSync(fakeCostLedgerPath, 'utf8'));
  if (ledger.realGcpCalls !== 0 || ledger.project?.state !== 'stopped'
    || ledger.events?.map((event:{event:string}) => event.event).join(',') !== 'project-created,work-scheduled,idle-stopped'
    || Date.parse(ledger.events[2].at) - Date.parse(ledger.events[1].at) !== proposal.idleTtlMs)
    throw new Error('fake world did not stop after the declared idle TTL');
} else if (existsSync(fakeCostLedgerPath)) throw new Error('fake project created without y approval');
const verificationPath = join(outDir,'verification.json');
const verification = JSON.parse(readFileSync(verificationPath,'utf8'));
if (verification.status !== 'verified') throw new Error('shared output not verified');
const files = ['architecture.excalidraw','architecture.png','architecture.pdf','architecture.html','verification.json'];
for (const name of files) if (!existsSync(join(outDir,name))) throw new Error(`missing ${name}`);
const deliverablesOutput = graph.nodes.find(node => node.nodeId === 'deliverables')?.output;
if (typeof deliverablesOutput !== 'string') throw new Error('deliverables graph output missing');
const output = JSON.parse(deliverablesOutput);
const attachments = output.result?.attachments ?? [];
if (attachments.length !== 4 || attachments.some((item:{sha256:string;url:string}) => item.sha256 !== sha256(item.url))) throw new Error('attachment contract/hash mismatch');
const receipt = {checkedAt:new Date().toISOString(),mode:'direct runGraph in isolated test world',graphId:graph.graphId,runId:graph.runId,
  status:graph.status,pendingNode:graph.pending?.nodeId ?? null,decision:decision ?? null,executedNodes:called,
  fakeLifecycleExecuted:decision === 'y',spendingNodesExecuted:false,realGcpCalls:0,
  fakeCostLedgerPath:decision === 'y' ? fakeCostLedgerPath : null,
  input:{ticketDesignPath,designResultSha256:sha256(ticketDesignPath),sourceKind:ticket.sourceKind,
    sourceSessionId:ticket.sourceSessionId ?? null,sourceGraphRunId:ticket.sourceGraphRunId ?? null,
    pressurePath,proposalPath,sourceHtml:join(sourceDir,'architecture-design.html'),sourceDiagram:join(sourceDir,'architecture.excalidraw')},
  assumptions:proposal.assumptions ?? [],assumptionStatus:proposal.assumptionStatus ?? 'none',
  sharedGraphId:output.result.graphId,sharedGraphRunId:output.result.runId,verification,
  files:files.map(name=>({path:join(outDir,name),sha256:sha256(join(outDir,name))})),attachments,
  limitations:[externalDesign ? 'structured architecture JSON supplied by caller' : 'synthetic ticket design fixture',
    pressure.source === 'synthetic-demo-fixture' ? 'synthetic pressure fixture' : 'caller-supplied pressure JSON',
    'diagram/PDF content uses the existing fake-world renderer adapted for the common output contract',
    decision ? 'HITL decision injected by fake test driver; no actual TUI interaction' : 'no HITL approval or GCP provisioning executed',
    'no real GCP provisioning executed','not a classic TUI/board attachment receipt']};
writeFileSync(join(target,'graph-direct-receipt.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({status:receipt.status,runId:receipt.runId,outDir,receipt:join(target,'graph-direct-receipt.json'),pages:verification.pages,attachments:attachments.length}));
