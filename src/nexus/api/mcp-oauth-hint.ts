// Claude Code 가 HTTP MCP(`/v1/mcp`)에 토큰 없이 붙으면 401 을 받고 OAuth 를 시도한다 — 인가 서버 메타데이터가 없으니
// 기본 경로 `POST /register`(동적 클라이언트 등록 · RFC 7591)로 떨어지고, 종전엔 거기서 405 «method-not-allowed» 를 받아
// 사람은 무엇을 해야 할지 몰랐다(🅢 09-28 · 대표 승인 수리). Elanous 는 OAuth 를 쓰지 않는다 — 고정 Bearer 토큰이다.
// ⇒ 두 자리에서 «할 일»을 말한다: ① 401 의 `WWW-Authenticate` ② `/register` 의 RFC 7591 오류 본문(Claude Code 가 그대로 보여 준다).

/** 토큰 «값»은 절대 싣지 않는다 — 파일 경로와 명령만. */
export const MCP_AUTH_HINT =
  'Elanous 는 OAuth 를 쓰지 않는다(고정 Bearer 토큰). 권장: stdio 로 등록 — `claude mcp add elanous -- elanous mcp serve`. '
  + 'HTTP 가 필요하면 ~/.elanous/acp-token 의 값을 Authorization 헤더로: '
  + '`claude mcp add --transport http elanous http://127.0.0.1:31415/v1/mcp --header "Authorization: Bearer <acp-token>"`';

/** `/v1/mcp` 401 — 무엇을 해야 하는지 헤더로도 말한다(WWW-Authenticate 의 error_description 은 ASCII 만). */
export function mcpUnauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: 'unauthorized', hint: MCP_AUTH_HINT }), {
    status: 401,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'www-authenticate': 'Bearer realm="elanous", error="invalid_token", error_description="Elanous does not use OAuth. Register via stdio (claude mcp add elanous -- elanous mcp serve) or send Authorization: Bearer <~/.elanous/acp-token>"',
    },
  });
}

/** OAuth 동적 클라이언트 등록 거절 — RFC 7591 §3.2.2 오류 형식(Claude Code 가 본문을 사람에게 보여 준다). */
export function oauthRegistrationRejected(): Response {
  return new Response(JSON.stringify({ error: 'invalid_client_metadata', error_description: MCP_AUTH_HINT }), {
    status: 400,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
  });
}
