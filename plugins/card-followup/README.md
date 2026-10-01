# card-followup

명함 사진 한 장으로 사람·회사 조사, 타겟 판정, 접근 전략, 로컬 CRM 한 줄과 이에 맞는 팔로업 초안을 만듭니다. 메일과 LinkedIn 메시지는 보내지 않습니다.

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
- `offer` (선택): 우리 제품과 대상 고객을 설명하는 한두 줄. 없으면 적합도 점수는 `null`, 라벨은 `unknown`이며 접근 전략과 초안은 계속 작성합니다.
- `crm` (선택): 로컬 CRM CSV의 절대 경로. 기본값은 `<outDir>/crm.csv`입니다.

## 산출

- `followup.md`: 맨 위에 사람·회사 분석, CRM 한 줄, 타겟 판정(점수·라벨·근거), 접근 전략(대상·문제·제안·채널·시점), 메일·LinkedIn 초안을 순서대로 보여줍니다. 그 아래에 출처와 경고가 있습니다.
- `followup.json`: `fit`, `approach`, `nextAction`, `crm` 경로 및 초안의 구조화 데이터. `sent`는 항상 `false`입니다. 타겟 판정의 `S#` 이유는 번호뿐 아니라 해당 출처의 제목·본문 조각과 주장 내용도 재검증합니다. `assumption`은 적합성 근거로 세지 않고, 실제 명함·만남 맥락·제안·조사 출처에 뒷받침되는 이유만 남깁니다. 재작성 후에도 유효한 이유가 두 개 미만이면 점수는 `null`, 라벨은 `unknown`입니다. 접근 전략은 주장별 근거와 전체 출처 원문을 대조하고, 다음 행동의 확인되지 않은 고객 약속·확정 일정은 재작성 후에도 남으면 산출을 중단합니다. 다음 행동·기한은 제안 또는 내부 목표이지 고객 확약이 아닙니다.
- `crm.csv` (또는 지정한 `crm` 경로): `name,company,title,email,interest,met_context,fit_score,fit_label,next_action,due,updated_at` 헤더의 로컬 CSV. 같은 이메일(없으면 이름+회사)은 갱신하고 다른 연락처는 추가합니다. 적합도 점수 내림차순으로 저장하며 미판정 점수는 맨 뒤입니다. 쉼표·따옴표·줄바꿈이 포함된 값은 CSV 인용 규칙으로 저장합니다. 외부 CRM과 동기화하지 않습니다.

## 개인정보 주의

명함 사진과 연락처는 그래프 런 상태에 남습니다. 비공개 경로만 사용하고 공유하지 마세요.

어디로 나가나:
- **명함 이미지** → `codex`(설치된 codex CLI 의 모델)가 읽는다.
- **이름·회사·사이트** → `elanous research` 가 웹 검색어로 쓴다.
- **명함 필드·만남 맥락·offer·조사 결과** → `elanous ask` 로 설정된 LLM 에 보내 판정·전략·초안을 만든다.
- **CRM(`crm.csv`)·보고서** → 이 기계의 파일에만 쓴다. 외부 CRM 과 동기화하지 않고, 메일·LinkedIn 을 보내지 않는다.

## 릴리스 노트

- 한 줄: feat — card-followup turns one business card into a sales plan: a local CRM row sorted by fit, a target-fit score with three sourced reasons, an approach strategy and matching drafts, all on one report
- 종류: feat
- 문서: plugins/card-followup/README.md
- 대상: next
