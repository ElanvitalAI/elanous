import { test } from "bun:test";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockSeatPtySequence } from "./mock-seat-pty-sequence.js";
test("mode omitted long RunShell reaches idle before command finishes", async () => {
 const root = mkdtempSync(join(tmpdir(), "cx2-runshell-default-"));
 writeFileSync(join(root,"config.json"), JSON.stringify({onboarding:{completed:true},errorReports:{enabled:false}}));
 const marker=join(root,"DONE_DEFAULT_RUNSHELL");
 let baseline=0;
 try {
  const run=await mockSeatPtySequence({executable:process.execPath,args:[join(import.meta.dir,"../../bin/elanous.mjs"),"--test={root}","--config-dir","{root}","--test-state-dir","{root}","--tui","next"],root,rows:40,cols:100,
   env:{ELANOUS_SESSION_ROOT:join(root,"sessions"),ELANOUS_CONFIG_DIR:root,ELANOUS_TEST_FAKE_LLM:"1",ELANOUS_TEST_FAKE_LLM_AS_PROVIDER:"1",ELANOUS_TEST_FAKE_LLM_RESPONSE:"DEFAULT_ACK",ELANOUS_TEST_FAKE_LLM_CAPTURE:join(root,"requests.jsonl"),ELANOUS_TEST_FAKE_LLM_TOOL_CALL:JSON.stringify({when:"DEFAULT_PARENT",name:"RunShell",args:{command:["sh","-c","sleep 20; touch DONE_DEFAULT_RUNSHELL"],approval:"none"}})},
   ready:{label:"boot",until:"Ctrl+Q quit"},steps:[
    // 출처: #95212 — boot first 60 seconds excluded; allow 10 seconds for PTY polling.
    {label:"first minute excluded",until:()=>{baseline ||= Date.now();return Date.now()-baseline>=60000},timeoutMs:70000}, // 출처: #95212 첫 60초 제외 및 PTY 여유 10초
    // 출처: RFC-C-10 — 10s cap; 18s leaves 2s before this fixture command ends at 20s.
    {label:"turn settles before child exit",text:"DEFAULT_PARENT",until:screen=>{if(existsSync(marker)) throw new Error("command completed before turn settled");return /Turn done|○ done/.test(screen)},timeoutMs:18000}]}); // 출처: RFC-C-10 10초 캡과 20초 명령 사이 판정
  console.log(JSON.stringify({root,exitCode:run.exitCode,markerExists:existsSync(marker),status:"detached-before-completion"}));
 } catch (error) {console.log(JSON.stringify({root,markerExists:existsSync(marker),status:"not-observed",error:String(error)}));throw error}
}, 110000);
