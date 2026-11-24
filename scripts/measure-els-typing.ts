import { mockSeatPtySequence } from "../src/ux-sim/mock-seat-pty-sequence.js";
import { requestEls } from "../src/els/client.js";
import { elsSocketPath } from "../src/els/server.js";
// Run in a disposable checkout on a test host. The 30 samples are a shell
// echo through an isolated ELS PTY, not a measure of physical display latency.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const expectedHead = process.argv[2];
if (!expectedHead || !/^[0-9a-f]{40}$/.test(expectedHead)) throw Error("pass the expected full checkout SHA");
const head = execFileSync("git", ["rev-parse", "HEAD"], {encoding:"utf8"}).trim();
if (head !== expectedHead) throw Error("checkout HEAD mismatch");
const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "--", "src", "bin"], {encoding:"utf8"});
if (dirty.trim()) throw Error("src or bin is modified; refusing unbound measurement");
const root = mkdtempSync(join(tmpdir(), "els-screen-latency-"));
const scriptSha256 = createHash('sha256').update(readFileSync(import.meta.path)).digest('hex');
const seq="abcdefghijklmnopqrstuvwxyzABCD"; const events:any[]=[]; let started=0, marker="", armed=false, pending="", current="";
const resultPath=join(root, "result.json");
const steps=Array.from(seq, (c,i)=>({label:`key-${i+1}`, text:()=>{marker=seq.slice(0,i+1);started=performance.now();armed=true;pending="";current="";return c;},enter:false,until:(s:string)=>s.includes(`sh-3.2$ ${seq.slice(0,i+1)}`),timeoutMs:10000}));
try {
const result=await mockSeatPtySequence({executable:process.execPath,args:[`${process.cwd()}/bin/elanous.mjs`,"--test-state-dir","{root}","side"],root,rows:24,cols:120,env:{SHELL:"/bin/sh",NODE_ENV:"development"},
ready:{label:"ready",until:(s)=>s.includes("sh-3.2$"),timeoutMs:45000},steps,quitKeys:"\x15\x02q",exitTimeoutMs:15000,
onOutput:(chunk,at)=>{if(!armed)return;pending+=chunk;for(;;){const end=pending.indexOf("\x1b[?2026l");if(end<0)break; const frame=pending.slice(0,end+8);pending=pending.slice(end+8);current+=frame;if(frame.includes(`sh-3.2$ ${marker}`)){events.push({marker,startedAtMs:started,observedAtMs:at,latencyMs:at-started,frameBase64:Buffer.from(frame).toString("base64")});armed=false;break;}}},artifactPath:join(root, "screens.json")});
const vals=events.map(e=>e.latencyMs).sort((a,b)=>a-b);const pct=(n:number)=>vals[Math.min(vals.length-1,Math.floor(vals.length*n/100))]??null;
writeFileSync(resultPath,JSON.stringify({head,scriptSha256,host:hostname(),samples:events.length,expected:seq.length,p50:pct(50),p95:pct(95),exitCode:result.exitCode,events},null,2)+"\n");
console.log(JSON.stringify({head,samples:events.length,expected:seq.length,p50:pct(50),p95:pct(95),exitCode:result.exitCode,resultPath}));
if (events.length !== seq.length || result.exitCode !== 0) process.exitCode = 1;
} finally {try {const p=await requestEls(elsSocketPath(root),{op:"ping"});const pid=Number(p.message.match(/pid (\d+)/)?.[1]);if(pid>0)process.kill(pid,"SIGTERM");}catch{}}
