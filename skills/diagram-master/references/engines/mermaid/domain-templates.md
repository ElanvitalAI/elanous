# 분야별 Mermaid 템플릿 (복사해서 바로 사용)

모든 템플릿에 시맨틱 classDef 팔레트 + ELK layout 적용.
lecture-note-digitizer와 연동 시 이 템플릿을 기반으로 생성하세요.

## 공통 시맨틱 팔레트

```
classDef primary fill:#3b82f6,stroke:#1e3a5f,color:#fff
classDef secondary fill:#8b5cf6,stroke:#5b21b6,color:#fff
classDef accent fill:#f59e0b,stroke:#92400e,color:#fff
classDef success fill:#bbf7d0,stroke:#166534
classDef warning fill:#fef08a,stroke:#854d0e
classDef danger fill:#fecaca,stroke:#991b1b
classDef neutral fill:#e5e7eb,stroke:#374151
classDef groupA fill:#fed7aa,stroke:#c2410c
classDef groupB fill:#ddd6fe,stroke:#6d28d9
classDef groupC fill:#a7f3d0,stroke:#065f46
```

---

## 1. 경제학 / 경영학

### 1-1. 기본 흐름 구조

```mermaid
---
title: "경제학의 기본 흐름"
config:
  layout: elk
  theme: base
---
flowchart LR
    subgraph S1 ["1. 합리적 의사결정"]
        A1(소비자) & A2(생산자) & A3(정부)
    end
    subgraph S2 ["2. 상호작용"]
        B1(시장<br/>경제주체 다수) & B2(게임이론<br/>경제주체 소수)
    end
    subgraph S3 ["3. 균형 & 문제해결"]
        C1(균형 도출) & C2(정책 개선)
    end
    S1 ==> S2 ==> S3
    classDef primary fill:#3b82f6,stroke:#1e3a5f,color:#fff
    classDef groupA fill:#fed7aa,stroke:#c2410c
    classDef groupB fill:#ddd6fe,stroke:#6d28d9
    class A1,A2,A3 primary
    class B1 groupA
    class B2 groupB
    class C1,C2 primary
```

### 1-2. 한계분석 (MB = MC)

```mermaid
---
title: "한계분석 MB = MC"
config:
  layout: elk
  theme: base
---
flowchart TB
    subgraph Analysis ["한계분석 프레임워크"]
        direction TB
        Q["활동량 Q"] --> MB["한계편익 MB<br/>(감소 함수)"]
        Q --> MC["한계비용 MC<br/>(증가 함수)"]
        MB & MC --> Compare{"MB vs MC"}
        Compare -->|"MB > MC"| Increase["활동량 증가"]
        Compare -->|"MB < MC"| Decrease["활동량 감소"]
        Compare -->|"MB = MC"| Optimal["최적점 Q*"]
    end
    classDef primary fill:#3b82f6,stroke:#1e3a5f,color:#fff
    classDef success fill:#bbf7d0,stroke:#166534
    classDef warning fill:#fef08a,stroke:#854d0e
    class Q,MB,MC primary
    class Optimal success
    class Increase,Decrease warning
```

### 1-3. 소비자 최적화 문제

```mermaid
---
title: "소비자 최적화 문제"
config:
  layout: elk
  theme: base
---
flowchart TB
    subgraph Objective ["목적"]
        Max["max U(x1, x2)<br/>효용 극대화"]
    end
    subgraph Constraint ["제약"]
        Budget["p1*x1 + p2*x2 <= M<br/>예산 제약"]
    end
    subgraph Solution ["해법"]
        Tangency["MRS = p1/p2<br/>접선 조건"]
        Corner["꼭짓점 해"]
    end
    Max --> Budget
    Budget --> Tangency
    Budget --> Corner
    Tangency --> Optimal["최적 소비 묶음"]
    Corner --> Optimal
    classDef primary fill:#3b82f6,stroke:#1e3a5f,color:#fff
    classDef success fill:#bbf7d0,stroke:#166534
    classDef warning fill:#fef08a,stroke:#854d0e
    class Max primary
    class Budget warning
    class Tangency,Corner primary
    class Optimal success
```

---

## 2. 컴퓨터과학 / 소프트웨어 공학

### 2-1. 시스템 아키텍처 (계층형)

```mermaid
---
title: "웹 서비스 3-Tier 아키텍처"
config:
  layout: elk
  theme: base
---
flowchart TB
    subgraph Presentation ["Presentation Layer"]
        UI[Web Browser] & Mobile[Mobile App]
    end
    subgraph Application ["Application Layer"]
        API[REST API] --> Auth[Authentication]
        API --> BL[Business Logic]
    end
    subgraph Data ["Data Layer"]
        DB[(PostgreSQL)] & Cache[(Redis)]
    end
    UI & Mobile --> API
    BL --> DB & Cache
    classDef groupA fill:#fed7aa,stroke:#c2410c
    classDef groupB fill:#ddd6fe,stroke:#6d28d9
    classDef groupC fill:#a7f3d0,stroke:#065f46
    class UI,Mobile groupA
    class API,Auth,BL groupB
    class DB,Cache groupC
```

### 2-2. 알고리즘 흐름 (의사결정)

```mermaid
---
title: "이진 탐색 알고리즘"
config:
  layout: elk
  theme: base
---
flowchart TD
    Start([Start]) --> Init["low=0, high=n-1"]
    Init --> Check{"low <= high?"}
    Check -->|No| NotFound["Return -1"]
    Check -->|Yes| Mid["mid = (low+high)/2"]
    Mid --> Compare{"arr[mid] vs target"}
    Compare -->|"=="| Found["Return mid"]
    Compare -->|"<"| Right["low = mid+1"]
    Compare -->|">"| Left["high = mid-1"]
    Right & Left --> Check
    classDef primary fill:#3b82f6,stroke:#1e3a5f,color:#fff
    classDef success fill:#bbf7d0,stroke:#166534
    classDef danger fill:#fecaca,stroke:#991b1b
    class Init,Mid,Right,Left primary
    class Found success
    class NotFound danger
```

### 2-3. 디자인 패턴 (클래스 다이어그램)

```mermaid
---
title: "Observer Pattern"
config:
  theme: base
---
classDiagram
    class Subject {
        <<interface>>
        +attach(Observer)
        +detach(Observer)
        +notify()
    }
    class ConcreteSubject {
        -state: State
        +getState(): State
        +setState(State)
    }
    class Observer {
        <<interface>>
        +update()
    }
    class ConcreteObserver {
        -subject: Subject
        +update()
    }
    Subject <|.. ConcreteSubject
    Observer <|.. ConcreteObserver
    Subject o-- Observer : observers
    ConcreteObserver --> ConcreteSubject : observes
```

---

## 3. 자연과학

### 3-1. 실험 설계 흐름

```mermaid
---
title: "과학적 방법론"
config:
  layout: elk
  theme: base
---
flowchart TD
    Obs["관찰<br/>Observation"] --> Q["연구 질문<br/>Research Question"]
    Q --> Hyp["가설 수립<br/>Hypothesis"]
    Hyp --> Design["실험 설계<br/>Experimental Design"]
    Design --> Exp["실험 수행<br/>Experiment"]
    Exp --> Data["데이터 수집<br/>Data Collection"]
    Data --> Analyze["분석<br/>Analysis"]
    Analyze --> Eval{"가설 지지?"}
    Eval -->|Yes| Conclude["결론 & 이론화"]
    Eval -->|No| Revise["가설 수정"]
    Revise --> Hyp
    classDef primary fill:#3b82f6,stroke:#1e3a5f,color:#fff
    classDef success fill:#bbf7d0,stroke:#166534
    classDef accent fill:#f59e0b,stroke:#92400e,color:#fff
    class Obs,Q,Hyp,Design,Exp,Data,Analyze primary
    class Conclude success
    class Revise accent
```

### 3-2. 생물학 — 세포 신호전달

```mermaid
---
title: "세포 신호전달 경로"
config:
  layout: elk
  theme: base
---
flowchart LR
    Signal["리간드<br/>Signal"] --> Receptor["수용체<br/>Receptor"]
    Receptor --> Cascade["신호 전달 캐스케이드<br/>Kinase Cascade"]
    Cascade --> TF["전사인자 활성화<br/>Transcription Factor"]
    TF --> Gene["유전자 발현<br/>Gene Expression"]
    Gene --> Response["세포 반응<br/>Cell Response"]
    classDef groupA fill:#fed7aa,stroke:#c2410c
    classDef groupB fill:#ddd6fe,stroke:#6d28d9
    classDef success fill:#bbf7d0,stroke:#166534
    class Signal,Receptor groupA
    class Cascade,TF groupB
    class Gene,Response success
```

### 3-3. 화학 — 반응 에너지

```mermaid
xychart-beta
  title "반응 에너지 다이어그램"
  x-axis "반응 진행" [Reactant, "", "Transition State", "", Product]
  y-axis "에너지 (kJ/mol)" [0, 20, 40, 60, 80, 100]
  line [30, 50, 90, 60, 20]
```

---

## 4. 인문/사회과학

### 4-1. 연구 프레임워크

```mermaid
---
title: "질적 연구 프레임워크"
config:
  layout: elk
  theme: base
---
flowchart TB
    subgraph Paradigm ["인식론적 패러다임"]
        P1["구성주의"] & P2["해석주의"]
    end
    subgraph Method ["연구 방법"]
        M1["심층 인터뷰"] & M2["참여 관찰"] & M3["문헌 분석"]
    end
    subgraph Analysis ["분석"]
        A1["코딩<br/>Coding"] --> A2["범주화<br/>Categorization"]
        A2 --> A3["주제 도출<br/>Thematic Analysis"]
    end
    Paradigm --> Method --> A1
    A3 --> Result["연구 결과 & 함의"]
    classDef primary fill:#3b82f6,stroke:#1e3a5f,color:#fff
    classDef neutral fill:#e5e7eb,stroke:#374151
    classDef success fill:#bbf7d0,stroke:#166534
    class P1,P2 neutral
    class M1,M2,M3 primary
    class A1,A2,A3 primary
    class Result success
```

### 4-2. 역사 — 사건 타임라인

```mermaid
timeline
  title 산업혁명의 주요 사건
  section 1차 산업혁명
    1760s : 방적기 발명
          : 증기기관 개량
    1780s : 공장제 생산 확산
  section 2차 산업혁명
    1870s : 전기 상용화
          : 강철 대량생산
    1900s : 자동차 생산라인
  section 3차 산업혁명
    1960s : 반도체 발명
    1990s : 인터넷 보급
```

### 4-3. 법학 — 소송 절차

```mermaid
---
title: "민사소송 절차"
config:
  layout: elk
  theme: base
---
flowchart TD
    Filing["소장 제출"] --> Service["송달"]
    Service --> Answer["답변서 제출"]
    Answer --> Discovery["증거개시<br/>Discovery"]
    Discovery --> Pretrial["변론 준비"]
    Pretrial --> Decision{"합의?"}
    Decision -->|Yes| Settlement["합의 종결"]
    Decision -->|No| Trial["본안 심리"]
    Trial --> Verdict["판결"]
    Verdict --> Appeal{"항소?"}
    Appeal -->|Yes| HighCourt["상급심"]
    Appeal -->|No| Final["확정"]
    classDef primary fill:#3b82f6,stroke:#1e3a5f,color:#fff
    classDef success fill:#bbf7d0,stroke:#166534
    classDef groupA fill:#fed7aa,stroke:#c2410c
    classDef groupB fill:#ddd6fe,stroke:#6d28d9
    class Filing,Service,Answer groupA
    class Discovery,Pretrial primary
    class Trial,Verdict,HighCourt groupB
    class Settlement,Final success
```

---

## 5. 의학 / 보건

### 5-1. 진단 알고리즘

```mermaid
---
title: "흉통 감별진단 알고리즘"
config:
  layout: elk
  theme: base
---
flowchart TD
    Sx["흉통 호소"] --> ECG{"ECG 이상?"}
    ECG -->|"ST 상승"| STEMI["STEMI<br/>즉시 PCI"]
    ECG -->|"ST 변화 없음"| Troponin{"Troponin?"}
    Troponin -->|"양성"| NSTEMI["NSTEMI<br/>입원 관리"]
    Troponin -->|"음성"| Risk{"위험도 평가"}
    Risk -->|"고위험"| Admit["입원 관찰"]
    Risk -->|"저위험"| Discharge["퇴원 & F/U"]
    classDef danger fill:#fecaca,stroke:#991b1b
    classDef warning fill:#fef08a,stroke:#854d0e
    classDef success fill:#bbf7d0,stroke:#166534
    classDef primary fill:#3b82f6,stroke:#1e3a5f,color:#fff
    class STEMI danger
    class NSTEMI,Admit warning
    class Discharge success
    class Sx,ECG,Troponin,Risk primary
```

---

## 6. 공학 / 수학

### 6-1. 최적화 문제 구조

```mermaid
---
title: "최적화 문제의 일반 구조"
config:
  layout: elk
  theme: base
---
flowchart TB
    subgraph Problem ["문제 정의"]
        Obj["목적함수<br/>Objective Function"]
        Const["제약 조건<br/>Constraints"]
        Var["결정 변수<br/>Decision Variables"]
    end
    subgraph Solve ["풀이"]
        Method{"문제 유형?"}
        Method -->|"선형"| LP["LP Simplex"]
        Method -->|"비선형"| NLP["경사하강법"]
        Method -->|"정수"| IP["Branch & Bound"]
    end
    Obj & Const & Var --> Method
    LP & NLP & IP --> Sol["최적해"]
    classDef primary fill:#3b82f6,stroke:#1e3a5f,color:#fff
    classDef warning fill:#fef08a,stroke:#854d0e
    classDef success fill:#bbf7d0,stroke:#166534
    class Obj,Const,Var warning
    class LP,NLP,IP primary
    class Sol success
```

---

## 사용 가이드

1. 위 템플릿 중 분야에 맞는 것을 복사
2. 강의 맥락에 맞게 노드/라벨 수정
3. 시맨틱 팔레트(primary/success/warning 등)는 그대로 유지하되, groupA/B/C는 도메인에 맞게 이름 변경
4. `render_mermaid.py`로 PNG 생성 (PDF용)
5. Markdown에 Mermaid 코드 블록으로 삽입

**새로운 분야 추가**: 위 패턴을 따라 flowchart/sequence/mindmap 등으로 자유롭게 확장하세요.
