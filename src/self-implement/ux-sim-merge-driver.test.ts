import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { integrateTrain, runGeneratorWithTimeout } from './merge-train.js';
import { SPAWN_SYNC_MAX_BUFFER } from '../util/spawn-sync-output.js';
import { loadMockScenarioCatalogFromRoot, renderMockScenarioDeviceMarkdownTable } from '../ux-sim/mock-scenario-catalog.js';

const dirs: string[] = [];
setDefaultTimeout(30_000);
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function run(cwd: string, ...args: string[]) { const r = spawnSync(args[0]!, args.slice(1), { cwd, encoding: 'utf8' }); return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }; }
function git(cwd: string, ...args: string[]) { const r = run(cwd, 'git', ...args); if (r.status !== 0) throw new Error(r.stderr || r.stdout); return r.stdout.trim(); }
const fragmentsRoot = 'catalog/ux-sim/mock-scenario-catalog-fragments';
const manualPath = 'docs/manual/MANUAL-ux-simulation-devices-2026-08-23.md';
test('version history merge combines independently added device membership', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ux-sim-history-driver-'));
  dirs.push(dir);
  const [base, ours, theirs] = ['base.json', 'ours.json', 'theirs.json'].map((name) => join(dir, name));
  writeFileSync(base!, JSON.stringify({ '28': ['MD-BASE'] }));
  writeFileSync(ours!, JSON.stringify({ '28': ['MD-BASE', 'MD-A'] }));
  writeFileSync(theirs!, JSON.stringify({ '28': ['MD-BASE', 'MD-B'] }));
  const result = run(dir, 'node', resolve(process.cwd(), 'scripts/ux-sim-merge-driver.mjs'), 'catalog', base!, ours!, theirs!);
  expect(result.status).toBe(0);
  expect(JSON.parse(readFileSync(ours!, 'utf8'))).toEqual({ '28': ['MD-BASE', 'MD-A', 'MD-B'] });
});
function fixture() {
 const repo=mkdtempSync(join(tmpdir(),'ux-sim-merge-driver-'));dirs.push(repo);git(repo,'init','-q','-b','main');git(repo,'config','user.name','test');git(repo,'config','user.email','test@localhost');
 mkdirSync(join(repo,'scripts'),{recursive:true});mkdirSync(join(repo,'src/ux-sim'),{recursive:true});mkdirSync(join(repo,'docs/manual'),{recursive:true});mkdirSync(join(repo,'catalog/sim-world-device-catalog-fragments/devices'),{recursive:true});
 writeFileSync(join(repo,'.gitignore'),'node_modules\n');
 for(const file of ['.gitattributes','scripts/ux-sim-merge-driver.mjs','scripts/generate-ux-sim-device-manual.ts','scripts/generate-sim-world-device-catalogs.ts','src/primitives/guards.ts','src/ux-sim/mock-scenario-catalog.ts','src/ux-sim/device-catalog-snapshot-fragments.ts','src/sim-world-device-catalog-history.json',manualPath]){const target=join(repo,file);mkdirSync(join(target,'..'),{recursive:true});copyFileSync(resolve(process.cwd(),file),target);}
 writeFileSync(join(repo,'catalog/sim-world-device-catalog-fragments/metadata.json'),JSON.stringify({firstVersion:1},null,2)+'\n');
 writeFileSync(join(repo,'catalog/sim-world-device-catalog-fragments/devices/MD-UX-SIM-MOCK-SCENARIO-CATALOG-TS.json'),JSON.stringify({id:'MD-UX-SIM-MOCK-SCENARIO-CATALOG-TS',versions:[1]},null,2)+'\n');
 mkdirSync(join(repo,'docs/generated'),{recursive:true});writeFileSync(join(repo,'docs/generated/cli-anatomy.md'),'human CLI anatomy\n');
 symlinkSync(resolve(process.cwd(),'node_modules'),join(repo,'node_modules'),'dir');
 const put=(file:string,value:unknown)=>{const target=join(repo,fragmentsRoot,file);mkdirSync(join(target,'..'),{recursive:true});writeFileSync(target,JSON.stringify(value,null,2)+'\n');};
 put('metadata.json',{version:2,deviceCatalogVersion:1,runEvidence:{scope:'test',runId:'test',event:{category:'test',name:'done'},persistence:'test',artifact:'test'},discovery:{trackedRoot:'test',candidateRoots:['test'],limits:'test'},candidateAudit:{source:'test',baseCommit:'test',sourceRows:1,existingPaths:0,excludedPaths:0}});
 put('source-exclusions/00010--baseline.json',{path:'test/baseline',reason:'baseline fixture'});put('omission-required-paths/00010--baseline.json','test/baseline');
 put('devices/00010--fixture-a.json',{id:'fixture-a',name:'Fixture device A',implementation:['src/ux-sim/mock-scenario-catalog.ts'],tests:['src/ux-sim/mock-scenario-catalog.test.ts'],target:'fixture A',inputs:['fixture'],observations:['fixture'],entryCommands:['fixture'],logsRecorded:'no',eventNames:[],recentUse:null});
 put('devices/00020--fixture-b.json',{id:'fixture-b',name:'Fixture device B',implementation:['src/ux-sim/mock-scenario-catalog.ts'],tests:['src/ux-sim/mock-scenario-catalog.test.ts'],target:'fixture B',inputs:['fixture'],observations:['fixture'],entryCommands:['fixture'],logsRecorded:'no',eventNames:[],recentUse:null});
 put('source-modules/00010--catalog-module.json',{id:'MD-UX-SIM-MOCK-SCENARIO-CATALOG-TS',path:'src/ux-sim/mock-scenario-catalog.ts',boundary:'catalog loader',deviceIds:['fixture-a','fixture-b'],integrityCertificatePresent:false,integrityCertificatePath:null});
 for(const collection of ['catalog-additions','candidates','omission-missing-paths','scenarios','world-events'])mkdirSync(join(repo,fragmentsRoot,collection),{recursive:true});
 git(repo,'add','.');git(repo,'commit','-qm','base');return {repo,base:git(repo,'rev-parse','HEAD')};
}
function branch(repo:string,base:string,name:string,id:string,extraField:string){git(repo,'checkout','-q','--detach',base);git(repo,'checkout','-q','-b',name);const file=join(repo,fragmentsRoot,'world-events',`00090--${name}.json`);mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,JSON.stringify({id:`test-${id}`,name,description:extraField},null,2)+'\n');git(repo,'add',file);git(repo,'commit','-qm',name);return git(repo,'rev-parse','HEAD');}

test('integrateTrain assembles independently added fragment files without conflicts',()=>{
 const {repo,base}=fixture(),a=branch(repo,base,'asset-a','MD-0001','addedA'),b=branch(repo,base,'asset-b','MD-0002','addedB');
 const merged=integrateTrain(repo,base,[{number:1,head:a},{number:2,head:b}]);expect(merged.conflicts).toEqual([]);expect(merged.commitSha).toMatch(/^[0-9a-f]{40}$/);
 expect(git(repo,'show',`${merged.commitSha}:${fragmentsRoot}/world-events/00090--asset-a.json`)).toContain('test-MD-0001');expect(git(repo,'show',`${merged.commitSha}:${fragmentsRoot}/world-events/00090--asset-b.json`)).toContain('test-MD-0002');
 const doc=run(repo,'git','show',`${merged.commitSha}:${manualPath}`).stdout;expect(doc).toContain('### Source-file registry');expect(doc.endsWith('\n')).toBe(true);expect(doc.endsWith('\n\n')).toBe(false);
});
test('integrateTrain rejects duplicate IDs from independent fragment files',()=>{
 const {repo,base}=fixture(),a=branch(repo,base,'same-a','MD-0099','addedA');git(repo,'checkout','-q','--detach',base);git(repo,'checkout','-q','-b','same-b');const file=join(repo,fragmentsRoot,'world-events','00090--same-b.json');mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,JSON.stringify({id:'test-MD-0099',name:'different',description:'different'},null,2)+'\n');git(repo,'add',file);git(repo,'commit','-qm','duplicate ID');const b=git(repo,'rev-parse','HEAD');expect(()=>integrateTrain(repo,base,[{number:3,head:a},{number:4,head:b}])).toThrow('duplicate id: test-MD-0099');
});

test('SIM-CATALOG-MANUAL-FRAGMENT-MERGE: independent device fragments regenerate one merged catalog and manual',()=>{
 const {repo,base}=fixture();
 const makeDeviceBranch=(branchName:string,slot:string,id:string,label:string)=>{git(repo,'checkout','-q','--detach',base);git(repo,'checkout','-q','-b',branchName);const file=join(repo,fragmentsRoot,'devices',`${slot}--${branchName}.json`);writeFileSync(file,JSON.stringify({id,name:`${label} device`,implementation:['src/ux-sim/mock-scenario-catalog.ts'],tests:['src/ux-sim/mock-scenario-catalog.test.ts'],target:`${label} independently added device`,inputs:['fragment'],observations:['merged catalog'],entryCommands:['bun test src/self-implement/ux-sim-merge-driver.test.ts'],logsRecorded:'no',eventNames:[],recentUse:null},null,2)+'\n');git(repo,'add',file);git(repo,'commit','-qm',branchName);return git(repo,'rev-parse','HEAD');};
 const alpha=makeDeviceBranch('fragment-alpha','00030','fragment-alpha','Alpha');
 const beta=makeDeviceBranch('fragment-beta','00040','fragment-beta','Beta');
 const before=git(repo,'rev-parse','HEAD');
 const merged=integrateTrain(repo,base,[{number:10,head:alpha},{number:11,head:beta}]);
 expect(merged.conflicts).toEqual([]);expect(merged.commitSha).toMatch(/^[0-9a-f]{40}$/);expect(git(repo,'rev-parse','HEAD')).toBe(before);
 const projection=join(repo,'.integrated-tree');
 try {
  git(repo,'worktree','add','--quiet','--detach',projection,merged.commitSha!);
  const catalog=loadMockScenarioCatalogFromRoot(projection);
  expect(catalog.devices.map(({id})=>id)).toContain('fragment-alpha');
  expect(catalog.devices.map(({id})=>id)).toContain('fragment-beta');
  const doc=readFileSync(join(projection,manualPath),'utf8');
  expect(doc).toContain('| fragment-alpha | Alpha device |');expect(doc).toContain('| fragment-beta | Beta device |');
  const start=doc.indexOf('<!-- BEGIN GENERATED MOCK DEVICE CATALOG -->');
  const end=doc.indexOf('<!-- END GENERATED MOCK DEVICE CATALOG -->');
  expect(start).toBeGreaterThanOrEqual(0);expect(end).toBeGreaterThan(start);
  expect(doc.slice(start,end)).toContain(renderMockScenarioDeviceMarkdownTable(catalog).join('\n'));
  expect(renderMockScenarioDeviceMarkdownTable(catalog)).toEqual(renderMockScenarioDeviceMarkdownTable(catalog));
 } finally {git(repo,'worktree','remove','--force',projection);}
 const duplicateA=makeDeviceBranch('duplicate-device-alpha','00050','duplicate-id','Alpha');
 const duplicateB=makeDeviceBranch('duplicate-device-beta','00060','duplicate-id','Beta');
 expect(()=>integrateTrain(repo,base,[{number:12,head:duplicateA},{number:13,head:duplicateB}])).toThrow('duplicate id: duplicate-id');
});

test('integrateTrain runs the real manual generator on the merged catalog tree',()=>{
 const {repo,base}=fixture();
 const makeBranch=(name:string,index:number,label:string)=>{git(repo,'checkout','-q','--detach',base);git(repo,'checkout','-q','-b',name);const file=index===0?'00010--fixture-a.json':'00020--fixture-b.json';const device=JSON.parse(readFileSync(join(repo,fragmentsRoot,'devices',file),'utf8'));device.name+=` ${label}`;writeFileSync(join(repo,fragmentsRoot,'devices',file),JSON.stringify(device,null,2)+'\n');git(repo,'add',fragmentsRoot);git(repo,'commit','-qm',name);return git(repo,'rev-parse','HEAD');};
 const first=makeBranch('source-one',0,'one'),second=makeBranch('source-two',1,'two');const headBefore=git(repo,'rev-parse','HEAD');
 const result=integrateTrain(repo,base,[{number:1,head:first},{number:2,head:second}]);expect(result.conflicts).toEqual([]);expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);expect(git(repo,'rev-parse','HEAD')).toBe(headBefore);
 const doc=git(repo,'show',`${result.commitSha}:${manualPath}`);expect(doc).toContain('Fixture device A one');expect(doc).toContain('Fixture device B two');
 git(repo,'checkout','-q','--detach',base);git(repo,'checkout','-q','-b','generator-changed');writeFileSync(join(repo,'scripts/generate-ux-sim-device-manual.ts'),`${readFileSync(join(repo,'scripts/generate-ux-sim-device-manual.ts'),'utf8')}\nthrow new Error('PR-controlled generator must never execute');\n`);git(repo,'add','scripts/generate-ux-sim-device-manual.ts');git(repo,'commit','-qm','change generator');const changedGenerator=git(repo,'rev-parse','HEAD');
 const skipped=integrateTrain(repo,base,[{number:3,head:changedGenerator}]);expect(skipped.conflicts).toEqual([]);expect(git(repo,'show',`${skipped.commitSha}:scripts/generate-ux-sim-device-manual.ts`)).toContain('PR-controlled generator must never execute');
 git(repo,'checkout','-q','--detach',base);git(repo,'checkout','-q','-b','generator-removed');git(repo,'rm','scripts/generate-ux-sim-device-manual.ts');git(repo,'commit','-qm','remove generator');const removed=git(repo,'rev-parse','HEAD');
 expect(integrateTrain(repo,base,[{number:4,head:removed}]).conflicts).toEqual([]);
});

test('integrateTrain never executes a PR-controlled generator that writes outside its output paths',()=>{
 const {repo,base}=fixture();git(repo,'checkout','-q','-b','generator-writes-cli-output');
 const generator='scripts/generate-ux-sim-device-manual.ts';
 writeFileSync(join(repo,generator),`${readFileSync(join(repo,generator),'utf8')}\nimport { appendFileSync } from 'node:fs';\nappendFileSync('docs/generated/cli-anatomy.md', 'unauthorized');\n`);
 git(repo,'add',generator);git(repo,'commit','-qm','generator writes a non-UX output');const head=git(repo,'rev-parse','HEAD');
 const result=integrateTrain(repo,base,[{number:5,head}]);expect(result.conflicts).toEqual([]);expect(git(repo,'show',`${result.commitSha}:docs/generated/cli-anatomy.md`)).toBe('human CLI anatomy');
});

test('integrateTrain rejects generated output symlinks before reading their targets',()=>{
 const {repo,base}=fixture();const secret=join(repo,'host-secret.txt');writeFileSync(secret,'host secret must not be imported');
 git(repo,'checkout','-q','-b','generated-output-is-secret-link');unlinkSync(join(repo,manualPath));symlinkSync(secret,join(repo,manualPath));
 git(repo,'add','-A');git(repo,'commit','-qm','generated output is an external symlink');const head=git(repo,'rev-parse','HEAD');
 expect(()=>integrateTrain(repo,base,[{number:6,head}])).toThrow('generated output path contains a symbolic link');
});

test('integrateTrain rejects generator edits outside the human-authored manual region',()=>{
 const {repo,base}=fixture();git(repo,'checkout','-q','-b','generator-edits-human-manual');
 const generator='scripts/generate-ux-sim-device-manual.ts';
 writeFileSync(join(repo,generator),`${readFileSync(join(repo,generator),'utf8')}\nimport { appendFileSync } from 'node:fs';\nappendFileSync('${manualPath}', '\\nunauthorized human-authored change\\n');\n`);
 git(repo,'add',generator);git(repo,'commit','-qm','generator changes human-authored manual text');const head=git(repo,'rev-parse','HEAD');
 const result=integrateTrain(repo,base,[{number:7,head}]);expect(result.conflicts).toEqual([]);expect(git(repo,'show',`${result.commitSha}:${manualPath}`)).not.toContain('unauthorized human-authored change');
});

test('generator execution has a bounded timeout',()=>{
 let captured:{command:string;args:string[];timeout?:number}|undefined;
 const result=runGeneratorWithTimeout('generator.ts',{cwd:'/tmp/integrated',encoding:'utf8',timeout:60_000,maxBuffer:1024},(command,args,options)=>{ // Source: #35341 generator timeout is bounded to one minute.
  captured={command,args,timeout:options.timeout};return {status:null,stdout:'',stderr:'',error:Object.assign(new Error('timed out'),{code:'ETIMEDOUT'}) as NodeJS.ErrnoException};
 });
 // Source: #35341 production generator timeout uses the same one-minute bound.
 expect(captured).toMatchObject({command:process.execPath,args:['generator.ts'],timeout:60_000});expect(result.error?.code).toBe('ETIMEDOUT');
});

test('generator default spawn uses the shared output-buffer contract',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ux-sim-generator-buffer-'));dirs.push(dir);
 const script=join(dir,'large-output.cjs');
 const outputBytes=SPAWN_SYNC_MAX_BUFFER / 2;
 writeFileSync(script,`process.stdout.write('x'.repeat(${outputBytes}));`);
 const result=runGeneratorWithTimeout(script,{cwd:dir,encoding:'utf8'});
 expect(result.status).toBe(0);
 expect(result.stdout.length).toBe(outputBytes);
});

test('JSON driver preserves independent new fields and rejects dropped base array values',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ux-sim-json-conflict-'));dirs.push(dir);const b=join(dir,'b'),o=join(dir,'o'),t=join(dir,'t'),driver=resolve(process.cwd(),'scripts/ux-sim-merge-driver.mjs');
 writeFileSync(b,JSON.stringify({arr:[1,2]}));writeFileSync(o,JSON.stringify({arr:[2,3],x:1}));writeFileSync(t,JSON.stringify({arr:[2,4],y:2}));const r=run(dir,'node',driver,'catalog',b,o,t);expect(r.status).toBe(1);expect(r.stderr).toContain('array removal/change');expect(readFileSync(o,'utf8')).toBe(JSON.stringify({arr:[2,3],x:1}));
 writeFileSync(o,JSON.stringify({arr:[2]}));writeFileSync(t,JSON.stringify({arr:[2]}));const sameDelete=run(dir,'node',driver,'catalog',b,o,t);expect(sameDelete.status).toBe(1);expect(sameDelete.stderr).toContain('array removal/change');
 writeFileSync(b,JSON.stringify({arr:[1,1]}));writeFileSync(o,JSON.stringify({arr:[1]}));writeFileSync(t,JSON.stringify({arr:[1]}));const duplicateDelete=run(dir,'node',driver,'catalog',b,o,t);expect(duplicateDelete.status).toBe(1);expect(duplicateDelete.stderr).toContain('array removal/change');
 writeFileSync(b,JSON.stringify({}));writeFileSync(o,JSON.stringify({x:1}));writeFileSync(t,JSON.stringify({y:2}));const fields=run(dir,'node',driver,'catalog',b,o,t);expect(fields.status).toBe(0);expect(JSON.parse(readFileSync(o,'utf8'))).toEqual({x:1,y:2});
});
test('manual driver lets the integration generator replace generated rows',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ux-sim-manual-conflict-'));dirs.push(dir);const b=join(dir,'b'),o=join(dir,'o'),t=join(dir,'t'),text='<!-- BEGIN GENERATED MOCK DEVICE CATALOG -->\n| ID | 장치 | 구현 · 시험 | 진입 명령 | test logs 근거 | 최근 사용 근거 |\n|---|---|---|---|---|---|\n| base | base | impl | test | no | none |\n<!-- END GENERATED MOCK DEVICE CATALOG -->\n';writeFileSync(b,text);writeFileSync(o,text.replace('| base | base |','| base | changed |'));writeFileSync(t,text.replace('| base | base |','| base | other |'));const r=run(dir,'node',resolve(process.cwd(),'scripts/ux-sim-merge-driver.mjs'),'manual',b,o,t);expect(r.status).toBe(0);expect(readFileSync(o,'utf8')).toContain('| base | changed |');
});

test('manual driver rejects concurrent edits to human-authored manual content',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ux-sim-manual-shape-'));dirs.push(dir);const base=join(dir,'base'),ours=join(dir,'ours'),theirs=join(dir,'theirs'),driver=resolve(process.cwd(),'scripts/ux-sim-merge-driver.mjs');
 const text='before\n<!-- BEGIN GENERATED MOCK DEVICE CATALOG -->\nold table\n<!-- END GENERATED MOCK DEVICE CATALOG -->\nafter\n';
 writeFileSync(base,text);writeFileSync(ours,text.replace('before','ours'));writeFileSync(theirs,text.replace('before','theirs'));
 const r=run(dir,'node',driver,'manual',base,ours,theirs);expect(r.status).toBe(1);expect(r.stderr).toContain('manual non-generated content conflict');
});

test('manual driver merges independent human-authored changes outside generated markers',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ux-sim-manual-independent-'));dirs.push(dir);const base=join(dir,'base'),ours=join(dir,'ours'),theirs=join(dir,'theirs'),driver=resolve(process.cwd(),'scripts/ux-sim-merge-driver.mjs');
 const text='before\n<!-- BEGIN GENERATED MOCK DEVICE CATALOG -->\nold table\n<!-- END GENERATED MOCK DEVICE CATALOG -->\nafter\n';
 writeFileSync(base,text);writeFileSync(ours,text.replace('before','ours'));writeFileSync(theirs,text.replace('after','theirs'));
 const r=run(dir,'node',driver,'manual',base,ours,theirs);expect(r.status).toBe(0);const merged=readFileSync(ours,'utf8');expect(merged).toContain('ours');expect(merged).toContain('theirs');expect(merged).toContain('old table');
});
