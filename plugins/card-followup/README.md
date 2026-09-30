# card-followup

명함 사진 한 장으로 사람·회사 조사와 팔로업 초안을 만듭니다. 메일과 LinkedIn 메시지는 보내지 않습니다.

## 실행 명령

```bash
elanous graph run plugins/card-followup/graphs/card-followup.yaml --input '<json>' --json
```

## 입력

- `image` (필수): 명함 사진의 절대 경로. `png`, `jpg`, `jpeg`, `heic`만 허용합니다. `~/`는 홈 경로로 펼칩니다.
- `context` (선택): 어디서 만났고 무슨 이야기를 했는지 한두 줄.
- `sender` (선택): 보내는 사람 이름·회사. 기본값은 비움입니다.
- `language` (선택): `ko` 또는 `en`. 생략하면 명함에서 읽은 언어를 사용합니다.
- `outDir` (선택): 보고서 출력 절대 경로. 생략하면 그래프 런 디렉터리를 사용합니다.

## 산출

- `followup.md`: 명함 필드 표, 조사 요약과 출처, 팔로업 메일, LinkedIn 초대 문구, 대화 질문.
- `followup.json`: 같은 내용의 구조화 데이터. `sent`는 항상 `false`입니다.

## 개인정보 주의

명함 사진과 연락처는 그래프 런 상태에 남습니다. 비공개 경로만 사용하고 공유하지 마세요.

## 릴리스 노트

- 한 줄: feat — New card-followup plugin turns a business card photo into researched follow-up and LinkedIn drafts
- 종류: feat
- 문서: plugins/card-followup/README.md
- 대상: next
