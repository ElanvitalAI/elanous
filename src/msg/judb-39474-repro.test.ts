import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MsgStore } from "./msg-store.js";
import { runMailFallback } from "./msg-mail-fallback.js";
for (const toolAck of [false,true]) test(`unanswered delivered message toolAck=${toolAck} requires fallback wake`, async () => {
  const db=join(mkdtempSync(join(tmpdir(),"judb-mail-")),"messages.db");
  const s=new MsgStore(db); const m=s.post({from:"OP",to:"TC",body:"unanswered",intent:"request"});
  s.recordReceipt({messageId:m.id,recipient:"TC",state:"delivered",source:"tui-queue",queueItemId:"q1"});
  if(toolAck) s.ackThroughSeen("TC",m.id,"tool-ack");
  console.log(JSON.stringify({toolAck,status:s.messageStatus("TC",m.id),receipts:s.listReceipts({messageId:m.id}).map(r=>({state:r.state,source:r.source}))})); s.close();
  let wakes=0; const result=await runMailFallback({messageId:m.id,recipient:"TC",from:"OP"},{openStore:()=>new MsgStore(db),sleep:async()=>{},wake:async()=>{wakes++;return {result:"injected",wake:"els"}}});
  console.log(JSON.stringify({toolAck,result,wakes})); expect(wakes).toBe(1);
});
