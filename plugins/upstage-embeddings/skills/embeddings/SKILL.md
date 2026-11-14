---
name: upstage-embeddings
description: 검색 질의나 문서를 Solar Embedding 2로 임베딩해 스크랩과 지식 팩의 근거를 찾는다.
---

이 텍스트를 Upstage로 보내 처리합니다. 사용자가 동의한 경우에만 `consent: true`로 실행한다. 거부하면 외부 요청 없이 기존 로컬 검색을 사용한다.

공유 키 설정은 `eln secret slot setup upstage`를 사용한다. 모든 Upstage 플러그인이 `cred:upstage.api_key` 하나를 공유한다. 키를 그래프 입력·설정 파일·로그에 넣지 않는다.

`upstage-embeddings` 그래프에 `input`(텍스트 또는 텍스트 배열), `purpose`(`query` 또는 `passage`), `consent`를 전달한다. `purpose`와 `model`을 생략하면 검색 질의용 `query`/`solar-embedding-2-query`가 기본이다. 저장할 문서는 `purpose: passage`로 지정해 `solar-embedding-2-passage`를 사용한다. 구 `embedding-query`·`embedding-passage` 이름은 이 플러그인에서 지원하지 않는다.

출력의 `embeddings`는 입력 순서를 따른다. 잘못된 응답이나 설정 실패를 빈 벡터 성공으로 처리하지 않는다. 운영 엔드포인트는 공유 Upstage 클라이언트가 고정하며, 시험용 URL은 시험 우주의 가짜 서버에만 사용한다.
