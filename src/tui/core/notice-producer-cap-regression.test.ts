// JUD-B #39592 producer probe (mbp /tmp/judb-39592-oComz0/producer-regression.test.ts) — literal expectations kept.
// The notice cap / overflow guide is for seat mail only; other producers keep their pre-PR behaviour.
import { test, expect } from 'bun:test';
import { createNextTuiQueue } from './queue';
import { createChildNoticeProducers } from './notice-producers';
function setup() {const q=createNextTuiQueue({log:()=>{},turnLifeLog:()=>{}});const prod=createChildNoticeProducers(q);for(let i=0;i<20;i++)prod.sidetabResult({mission:`m${i}`,status:'passed'});return {q,prod};}
test('21 distinct sidetab results do not create an actionable result-only turn',()=>{const {q,prod}=setup();prod.sidetabResult({mission:'m20',status:'passed'});expect(q.autoDispatchCount).toBe(0);});
test('capsule completion at capacity remains passive',()=>{const {q,prod}=setup();prod.capsuleDone({capsuleId:'cap',kind:'agent',status:'ok',summary:'done'});expect(q.autoDispatchCount).toBe(0);});
test('capsule carry never erases independently queued overflow notice',()=>{const {q,prod}=setup();prod.eventWatchLine('watched result');const overflow=q.items.at(-1)!;prod.capsuleDone({capsuleId:'cap',kind:'agent',status:'ok',summary:'done'});q.removeCapsuleDoneNotice('cap');expect(q.get(overflow.id)?.status).toBe('queued');});
