import { createWebChatHandoffLedger, routeBareWebChatHostRequest } from '../../../nexus/api/http-server.js';

const url = process.env.MEMBER_JOURNEY_HANDOFF_URL;
const memberId = process.env.MEMBER_JOURNEY_MEMBER_ID;
if (!url || !memberId) throw new Error('missing fake member journey restart input');
const ledger = createWebChatHandoffLedger({});
const response = await routeBareWebChatHostRequest(new Request(url), {
  pinnedHandles: new Set(['user']),
  pinOwners: new Map([['user', memberId]]),
  webChatHandoff: ledger,
});
console.log(JSON.stringify({ status: response?.status,
  derivedCookie: response?.headers.getSetCookie().some(value => value.startsWith('__Secure-elanous_webchat_session=wcs_')) === true }));
