# 보안 등급 결정표 — 공식 GCP 원문 확인

확인: 2026-11-10 04:06 UTC. 등급 명칭과 기본 구성은 **엘라누스 설계 제안**이며 Google Cloud 인증 등급이 아니다. 사용자·조직의 분류와 서비스별 지원 상태가 우선한다. 원문은 링크로만 인용한다.

| 결정 지점 | 기본 판정·검증할 증거 | 실패 시 | 공식 출처 | 출처 확인 |
|---|---|---|---|---|
| 데이터 분류 | 사용자 지정 등급·데이터 소유자·민감정보 유형·반출 허용 리전을 기록. 자동 프로파일은 보조로만 사용 | 미분류·혼합 등급 불확실하면 제한 등급으로 보류 | [Sensitive Data Protection discovery](https://docs.cloud.google.com/sensitive-data-protection/docs/data-profiles) | 확인됨 |
| IAM | 사람·배포자·런타임을 분리하고 기본 Owner/Editor 대신 필요한 리소스의 좁은 역할을 검토. 서비스 계정 사칭은 범위를 따로 승인 | 넓은 역할·서비스 계정 키 생성 요구면 축소/재설계 | [Use IAM securely](https://docs.cloud.google.com/iam/docs/using-iam-securely), [service account impersonation](https://docs.cloud.google.com/iam/docs/service-account-impersonation) | 확인됨 |
| VPC·진입 | Cloud Run 내부 ingress와 IAM 인증을 별개로 확인. VPC의 라우팅·방화벽·이그레스 제약을 설계 | 기밀/제한 데이터에 불필요한 공개 진입이 남으면 배치 차단 | [Cloud Run ingress](https://docs.cloud.google.com/run/docs/securing/ingress), [VPC overview](https://docs.cloud.google.com/vpc/docs/overview) | 확인됨 |
| Private Service Connect | 대상 관리형 서비스·엔드포인트·DNS·연결 방향의 지원을 확인한 뒤 사설 연결 선택 | 지원/구성 확인 안 되면 사설 연결 충족이라고 표기하지 않음 | [Private Service Connect](https://docs.cloud.google.com/vpc/docs/private-service-connect) | 확인됨 |
| 서비스 경계 | 조직·서비스 지원이 있을 때 VPC Service Controls를 데이터 유출 완화 수단으로 검토 | IAM·VPC·PSC의 대체물로 주장하지 않음 | [VPC Service Controls overview](https://docs.cloud.google.com/vpc-service-controls/docs/overview) | 확인됨 |
| 암호화·CMEK | Google 기본 저장 암호화를 기준으로 하고, 기밀 이상은 해당 서비스의 CMEK 통합·키 위치·키 관리자·서비스 에이전트 권한·회전/복구·추가 비용을 확인 | 미지원 또는 키 접근 실패의 복구 계획이 없으면 강제 적용/반출 보류 | [CMEK overview](https://docs.cloud.google.com/kms/docs/cmek), [supported integrations](https://docs.cloud.google.com/kms/docs/use-keys-google-cloud) | 확인됨 |
| 비밀 | GCP 작업 비밀은 Secret Manager에서 개별 secret 범위 접근; 사용자 로컬 OAuth/ADC는 기기 밖으로 복제 금지 | 프로젝트 전체 secret 읽기 권한·평문 유출이면 차단 | [Secret Manager best practices](https://docs.cloud.google.com/secret-manager/docs/best-practices), [access control](https://docs.cloud.google.com/secret-manager/docs/access-control) | 확인됨 |
| 감사 | Admin Activity 로그와 Data Access 로그를 구분. 기밀 이상은 서비스별 Data Access 활성화·읽기 권한·보존·비용·오류 알림을 확인 | 로그가 필요한 통제인데 비활성/접근 불가면 반출 보류 | [Cloud Audit Logs](https://docs.cloud.google.com/logging/docs/audit), [configure Data Access](https://docs.cloud.google.com/logging/docs/audit/configure-data-access) | 확인됨 |
| 조직 정책 | 조직 리소스·권한·상속 정책을 먼저 읽고 위치·공개 접근·키 발급 등의 제약을 검토 | 개인 계정처럼 조직 리소스가 없으면 조직 정책 적용 완료로 주장하지 않음; 기밀/제한 등급은 별도 검토 | [Organization Policy overview](https://docs.cloud.google.com/organization-policy/overview), [organization resource setup](https://docs.cloud.google.com/resource-manager/docs/creating-managing-organization) | 확인됨 |

외부 인증 대응 표는 이 기본 보안 등급표의 동의어가 아니다. ISMS-P·CSAP·ISO 27001·SOC 2 같은 요청을 받으면 고객이 지정한 범위·판본·통제 책임자·감사 증거를 별도 매핑해야 한다. 이 팩만으로 인증 또는 법적 적합성을 판정하지 않는다.
