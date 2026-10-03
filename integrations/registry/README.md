# Registry publication

## S — 준비된 파일

`package.json`의 `mcpName`, 루트 `server.json`, `.agents/plugins/marketplace.json`이 각각 MCP 공식 레지스트리와 Codex 플러그인 마켓의 등재 형식을 제공한다. 실제 바깥 게시 여부는 별도 결정이다.

## C — 판 올림과 npm 게시 순서

매 판에서 `package.json`의 `version`과 `server.json`의 `version`·`packages[0].version`을 같은 값으로 맞춘다. `scripts/release-loop/version-node.ts`는 `server.json`이 있으면 판 올림 때 함께 갱신한다. 게시할 npm 패키지 `elanous`의 버전이 먼저 npm에 있어야 MCP 레지스트리에서 이를 참조할 수 있다.

## Q — 어떻게 올리나?

## A — 대표 확인 뒤에만 실행

```sh
npm publish
mcp-publisher login github
mcp-publisher publish
```

Codex 사용자 쪽 마켓 등록 명령:

```sh
codex plugin marketplace add ElanvitalAI/elanous
```

바깥 게시는 대표 확인 뒤에만 한다. 이 문서는 실제 게시 완료를 뜻하지 않는다.
