// SC1 반증 시험 — 심어 둔 주소·토큰이 가린 마크업(글자·속성·폼 값) 어디에도 남지 않는다.
import { describe, expect, test } from 'bun:test';
import { maskShareMarkup, maskShareText, shareLiterals } from './share-capture';

const PLANTED = {
  elt: 'elt_FAKEownerTOKEN1234567890abcd',
  ghp: 'ghp_FAKEgithubTOKEN1234567890',
  telegram: '7700112233:AAFAKEtelegramTOKENvalue_zz9Qxyz123',
  bearer: 'FAKEbearerVALUE_9876543210',
  query: 'FAKEquerySECRET42',
  cgnat: '100.101.102.103:4016',
  tailnet: 'user-mbp.tail1a2b3c.ts.net',
  mdns: 'user-mbp.local',
  lan: '192.168.0.57',
  localhostPort: 'localhost:31415',
  home: '/Users/user',
  email: 'someone@example.com',
  plainToken: 'plainDeviceTokenNoPrefix77', // only removable as a literal
  pageHost: 'node-c-host:4016',
};

const markup = `
<div class="topbar" title="connected to ${PLANTED.cgnat}">
  <a href="https://${PLANTED.tailnet}/app/?token=${PLANTED.query}">open</a>
  <span>${PLANTED.mdns} · ${PLANTED.lan} · ${PLANTED.localhostPort}</span>
  <code data-x="${PLANTED.elt}">Authorization: Bearer ${PLANTED.bearer}</code>
  <p>${PLANTED.ghp} ${PLANTED.telegram} ${PLANTED.home}/notes ${PLANTED.email}</p>
  <input type="text" value="${PLANTED.plainToken}">
  <textarea>draft with ${PLANTED.plainToken}</textarea>
  <script>window.__t = "${PLANTED.elt}"</script>
  <p>page ${PLANTED.pageHost} · token ${PLANTED.plainToken}</p>
  <p>오늘 할 일 3건 · 승인 대기 1건</p>
</div>`;

describe('SC1 share capture masking — nothing planted survives', () => {
  const literals = shareLiterals({ pageHost: PLANTED.pageHost, baseUrl: `http://${PLANTED.cgnat}`, token: PLANTED.plainToken });

  test('every planted address and token is gone from text, attributes and form values', () => {
    const { markup: masked, hits } = maskShareMarkup(markup, literals);
    const survivors = Object.entries(PLANTED).filter(([, value]) => masked.includes(value)).map(([key]) => key);
    expect(survivors).toEqual([]);
    for (const fragment of ['tail1a2b3c', 'FAKE', '102.103', 'user']) expect(masked).not.toContain(fragment);
    expect(masked).not.toContain('<script');
    expect(masked).toContain('<textarea></textarea>');
    expect(masked).toContain('value=""');
    expect(masked).toContain('오늘 할 일 3건 · 승인 대기 1건'); // ordinary content stays
    expect(hits).toBeGreaterThanOrEqual(12);
  });

  test('literals catch this device’s values even when no pattern would', () => {
    expect(maskShareText(`token ${PLANTED.plainToken}`).text).toContain(PLANTED.plainToken); // pattern alone: not caught
    expect(maskShareText(`token ${PLANTED.plainToken}`, literals).text).not.toContain(PLANTED.plainToken);
    expect(shareLiterals({ token: 'abc', baseUrl: 'http://10.0.0.2:9000/' })).toEqual(['http://10.0.0.2:9000', '10.0.0.2:9000', '10.0.0.2']);
  });

  test('public addresses and ordinary numbers are left alone', () => {
    const { text, hits } = maskShareText('https://elanous.ai/docs · 8.8.8.8 · 버전 0.2.8 · 3명');
    expect(text).toBe('https://elanous.ai/docs · 8.8.8.8 · 버전 0.2.8 · 3명');
    expect(hits).toBe(0);
  });
});
