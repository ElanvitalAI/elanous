import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { integrateTrain } from './merge-train.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function run(cwd: string, ...args: string[]) { const r = spawnSync(args[0]!, args.slice(1), { cwd, encoding: 'utf8' }); return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }; }
function git(cwd: string, ...args: string[]) { const r = run(cwd, 'git', ...args); if (r.status !== 0) throw new Error(r.stderr || r.stdout); return r.stdout.trim(); }
const catalogPath = 'src/ux-sim/mock-scenario-catalog.json';
const manualPath = 'docs/manual/MANUAL-ux-simulation-devices-2026-08-23.md';
function fixture() {
 const repo=mkdtempSync(join(tmpdir(),'ux-sim-merge-driver-'));dirs.push(repo);git(repo,'init','-q','-b','main');git(repo,'config','user.name','test');git(repo,'config','user.email','test@localhost');
 mkdirSync(join(repo,'scripts'),{recursive:true});mkdirSync(join(repo,'src/ux-sim'),{recursive:true});mkdirSync(join(repo,'docs/manual'),{recursive:true});
 for(const file of ['.gitattributes','scripts/ux-sim-merge-driver.mjs','scripts/generate-ux-sim-device-manual.ts','src/ux-sim/mock-scenario-catalog.ts',catalogPath,manualPath]){const target=join(repo,file);mkdirSync(join(target,'..'),{recursive:true});copyFileSync(resolve(process.cwd(),file),target);}
 git(repo,'add','.');git(repo,'commit','-qm','base');return {repo,base:git(repo,'rev-parse','HEAD')};
}
function branch(repo:string,base:string,name:string,id:string,extraField:string){git(repo,'checkout','-q','--detach',base);git(repo,'checkout','-q','-b',name);const c=JSON.parse(readFileSync(join(repo,catalogPath),'utf8'));c.worldEvents.push({id:`test-${id}`,name,description:extraField});c[extraField]=true;writeFileSync(join(repo,catalogPath),JSON.stringify(c,null,2)+'\n');git(repo,'add',catalogPath);git(repo,'commit','-qm',name);return git(repo,'rev-parse','HEAD');}

test('integrateTrain uses repository attributes to union independent catalog and appended manual assets',()=>{
 const {repo,base}=fixture(),a=branch(repo,base,'asset-a','MD-0001','addedA'),b=branch(repo,base,'asset-b','MD-0002','addedB');
 const merged=integrateTrain(repo,base,[{number:1,head:a},{number:2,head:b}]);expect(merged.conflicts).toEqual([]);expect(merged.commitSha).toMatch(/^[0-9a-f]{40}$/);
 const c=JSON.parse(git(repo,'show',`${merged.commitSha}:${catalogPath}`));expect(c.worldEvents.map((x:any)=>x.id)).toContain('test-MD-0001');expect(c.worldEvents.map((x:any)=>x.id)).toContain('test-MD-0002');expect(c.addedA).toBe(true);expect(c.addedB).toBe(true);
 const doc=run(repo,'git','show',`${merged.commitSha}:${manualPath}`).stdout;expect(doc).toContain('### Source-file registry');expect(doc.endsWith('\n')).toBe(true);expect(doc.endsWith('\n\n')).toBe(false);
});
test('integrateTrain leaves divergent contents for one stable ID conflicted',()=>{
 const {repo,base}=fixture(),a=branch(repo,base,'same-a','MD-0099','addedA');git(repo,'checkout','-q','--detach',base);git(repo,'checkout','-q','-b','same-b');const c=JSON.parse(readFileSync(join(repo,catalogPath),'utf8'));c.worldEvents.push({id:'test-MD-0099',name:'different',description:'different'});writeFileSync(join(repo,catalogPath),JSON.stringify(c,null,2)+'\n');git(repo,'add',catalogPath);git(repo,'commit','-qm','divergent same id');const b=git(repo,'rev-parse','HEAD');const result=integrateTrain(repo,base,[{number:3,head:a},{number:4,head:b}]);expect(result.conflicts).toEqual([{number:4,reason:'conflict',files:[catalogPath]}]);
});

test('integrateTrain runs the real manual generator on the merged catalog tree',()=>{
 const repo=mkdtempSync(join(tmpdir(),'ux-sim-generated-train-'));dirs.push(repo);git(repo,'init','-q','-b','main');git(repo,'config','user.name','test');git(repo,'config','user.email','test@localhost');
 for(const file of ['.gitattributes','scripts/ux-sim-merge-driver.mjs','scripts/generate-ux-sim-device-manual.ts','src/ux-sim/mock-scenario-catalog.ts',catalogPath,manualPath]){const target=join(repo,file);mkdirSync(join(target,'..'),{recursive:true});copyFileSync(resolve(process.cwd(),file),target);}
 git(repo,'add','.');git(repo,'commit','-qm','base');const base=git(repo,'rev-parse','HEAD');
 const catalog=JSON.parse(readFileSync(join(repo,catalogPath),'utf8'));
 const makeBranch=(name:string,index:number,label:string)=>{git(repo,'checkout','-q','--detach',base);git(repo,'checkout','-q','-b',name);const branchCatalog=JSON.parse(JSON.stringify(catalog));branchCatalog.devices[index].name+=` ${label}`;writeFileSync(join(repo,catalogPath),JSON.stringify(branchCatalog,null,2)+'\n');git(repo,'add',catalogPath);git(repo,'commit','-qm',name);return git(repo,'rev-parse','HEAD');};
 const first=makeBranch('source-one',0,'one'),second=makeBranch('source-two',1,'two');const headBefore=git(repo,'rev-parse','HEAD');
 const result=integrateTrain(repo,base,[{number:1,head:first},{number:2,head:second}]);expect(result.conflicts).toEqual([]);expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);expect(git(repo,'rev-parse','HEAD')).toBe(headBefore);
 const doc=git(repo,'show',`${result.commitSha}:${manualPath}`);expect(doc).toContain(`${catalog.devices[0].name} one`);expect(doc).toContain(`${catalog.devices[1].name} two`);
 git(repo,'checkout','-q','--detach',base);git(repo,'checkout','-q','-b','generator-changed');writeFileSync(join(repo,'scripts/generate-ux-sim-device-manual.ts'),`${readFileSync(join(repo,'scripts/generate-ux-sim-device-manual.ts'),'utf8')}\nthrow new Error('PR-controlled generator must not run in train');\n`);git(repo,'add','scripts/generate-ux-sim-device-manual.ts');git(repo,'commit','-qm','change generator');const changedGenerator=git(repo,'rev-parse','HEAD');
 const trusted=integrateTrain(repo,base,[{number:3,head:changedGenerator}]);expect(trusted.conflicts).toEqual([]);expect(git(repo,'show',`${trusted.commitSha}:${manualPath}`)).toContain('### Source-file registry');
 git(repo,'checkout','-q','--detach',base);git(repo,'checkout','-q','-b','generator-removed');git(repo,'rm','scripts/generate-ux-sim-device-manual.ts');git(repo,'commit','-qm','remove generator');const removed=git(repo,'rev-parse','HEAD');
 expect(()=>integrateTrain(repo,base,[{number:4,head:removed}])).toThrow('UX simulation generation input missing from train tree: scripts/generate-ux-sim-device-manual.ts');
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
