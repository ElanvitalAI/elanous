# 레퍼런스 다이어그램 예시

diagram-master가 생성해야 할 **목표 품질 수준**의 참조 이미지.
Nano Banana 2의 `--ref` 입력으로도 직접 사용 가능.

---

## 1. ref_grid_architecture.png — 그리드 시스템 아키텍처

**원본**: SmartDocs - Intelligent Multilingual PDF Q&A System

### 스타일 특징
- **그리드 레이아웃**: 11개 섹션이 3행 구조로 정렬 (Input → Processing → Output)
- **색상 코딩**: 섹션별 고유 배경 그라데이션 (노랑=Input, 초록=Detection, 빨강=Security, 보라=Chunking 등)
- **컴포넌트 카드**: 각 섹션 내 흰 배경 카드에 아이콘 + 컴포넌트명 + 설명 텍스트
- **아이콘 활용**: 각 카드 우상단에 의미 전달 아이콘 (톱니바퀴, 방패, DB 등)
- **범례**: 우상단에 Active Flow / Future Enhancement / Processing Step Number 구분
- **깔끔한 타이포그래피**: 제목(Bold) → 섹션명(Medium) → 설명(Regular) 계층

### 최적 엔진 매핑
| 엔진 | 적합도 | 이유 |
|------|--------|------|
| **SVG interactive** | 최적 | 섹션별 hover, 웹 배포, 색상 코딩 정밀 제어 |
| **Nano Banana 2** | 좋음 | `--ref`로 전달 시 유사 스타일 재생성 가능 |
| **Excalidraw** | 가능 | 자유 배치이지만 그리드 정밀도 부족 |
| Mermaid | 부적합 | 그리드 레이아웃 + 배경색 그라데이션 불가 |

---

## 2. ref_layered_flow.png — 레이어드 아키텍처 플로우

**원본**: Mem0 Memory Architecture - Personalized AI Memory Layer for LLM Applications

### 스타일 특징
- **레이어 구분**: 4개 수평 레이어 (Input / Memory Manager / Storage / Output) 배경색으로 구분
- **다양한 화살표**: API/Control flow(파랑), Memory write(녹색), Memory read(보라), Data transform(주황) 색상별 구분
- **아이콘 혼합**: 사용자 아이콘, DB 심볼, 문서 아이콘 등 도메인 아이콘
- **메서드 라벨**: 화살표 위에 `store()`, `retrieve()`, `update()` 등 API 메서드 표기
- **코드 스니펫**: Storage Layer의 Key-Value Store에 실제 데이터 예시 (`user_123`, `likes Python`)
- **범례**: 하단에 4가지 화살표 유형 범례

### 최적 엔진 매핑
| 엔진 | 적합도 | 이유 |
|------|--------|------|
| **Excalidraw** | 최적 | 자유 배치, Evidence Artifacts(코드 스니펫), 곡선 화살표 |
| **SVG interactive** | 좋음 | 레이어 토글, 화살표 hover 시 상세 표시 |
| **Nano Banana 2** | 좋음 | 전체적 시각 품질 재생성 |
| Mermaid | 부분적 | 기본 흐름은 가능하나 다중 화살표 색상/레이어 배경 한계 |

---

## 사용 방법

### Nano Banana 2 --ref로 스타일 참조
```bash
cd ./references
uv run python render_nanobannana2.py \
  "이 아키텍처 스타일로 우리 시스템 다이어그램을 그려줘: [시스템 설명]" \
  --ref examples/ref_grid_architecture.png \
  --output my_architecture.png
```

### 다이어그램 생성 시 품질 기준
이 두 이미지의 공통 특성이 **목표 품질 기준**:
1. **시맨틱 색상 코딩** — 기능별 색상 구분
2. **계층적 타이포그래피** — 제목 → 컴포넌트명 → 설명
3. **Evidence Artifacts** — 실제 코드, 메서드명, 데이터 예시
4. **범례** — 화살표/색상의 의미 명시
5. **여백과 정렬** — 깔끔한 간격, 시각적 호흡
