# GCP 확장 결정표 — 공개 원문 근거 팩

확인: 2026-11-10 04:03–04:16 UTC, Google Cloud 공식 공개 문서 직접 조회. 이 팩은 원문을 재배포하지 않고 결정 규칙과 링크만 보관한다. 가격 수치는 조회 시점의 예시도 고정하지 않는다. 실제 제안에서는 사용자 리전·SKU의 공식 가격표를 다시 조회하고 시각을 남긴다.

| 신호·조건 | 결정 / 비용 계산 입력 | 주의·반증 | 공식 출처(확인 시각 2026-11-10 UTC) | 출처 확인 |
|---|---|---|---|---|
| 모든 후보 | 사업 가치, 필요한 자원만 공급, 비용·사용량의 반복 점검을 먼저 묻는다 | 실측 없는 과다 프로비저닝을 권하지 않음 | [Well-Architected Framework: Cost optimization](https://docs.cloud.google.com/architecture/framework/cost-optimization) | 확인됨 |
| 요청형·긴 유휴 | Cloud Run request-based, 최소 인스턴스 0을 후보로. `vCPU-second×단가 + GiB-second×단가 + 요청×단가 + 네트워크` | 0 스케일이면 서비스 컴퓨트 과금은 멈추나 다른 리소스 과금은 남음. 백그라운드 작업·최소 인스턴스 설정·리전별 단가 확인 | [Cloud Run pricing](https://cloud.google.com/run/pricing), [autoscaling](https://docs.cloud.google.com/run/docs/about-instance-autoscaling) | 확인됨 |
| 재시도 가능한 병렬 묶음 | Batch, 필요시 Spot VM. `VM·GPU 사용시간×해당 SKU + 디스크 + 네트워크 + 로그` | Batch 자체 추가 요금 없음은 무료 컴퓨트를 뜻하지 않음. Spot 선점 가능, 체크포인트·재시도 필요 | [Batch pricing](https://cloud.google.com/batch/pricing), [Spot VMs](https://docs.cloud.google.com/compute/docs/instances/spot), [Compute pricing](https://cloud.google.com/products/compute/pricing) | 확인됨 |
| Kubernetes 제약·장기 Pod | GKE Autopilot. `Pod vCPU·GiB·ephemeral storage 사용량×SKU + 클러스터/기타 자원` | 표의 컴퓨트 단가만으로 전체 비용을 말하지 않음. 리전·워크로드 클래스·Spot 여부를 다시 선택 | [GKE pricing](https://cloud.google.com/kubernetes-engine/pricing), [Autopilot overview](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/autopilot-overview) | 확인됨 |
| 지속 사용량이 검증됨 | 적용 가능한 committed use discount를 별도 비교 | 약정은 미래 의무. 선결제/기간/적용 가능 SKU와 사용량이 확실한 경우에만 별도 HITL | [Cloud Run pricing](https://cloud.google.com/run/pricing), [GKE pricing](https://cloud.google.com/kubernetes-engine/pricing), [Compute committed use discounts](https://docs.cloud.google.com/compute/docs/instances/committed-use-discounts-overview) | 확인됨 |
| 프로젝트별 비용 감시 | Billing Budget API로 예산·임계값·알림 수신자를 설정하고 생성 결과를 확인 | 일반 alerts-only 예산은 지출을 막지 않음. 일부 서비스의 spend cap 지원 여부를 별도 확인 | [Budget API overview](https://docs.cloud.google.com/billing/docs/how-to/budget-api-overview), [create method](https://docs.cloud.google.com/billing/docs/reference/budget/rest/v1/billingAccounts.budgets/create), [budgets and alerts](https://docs.cloud.google.com/billing/docs/how-to/budgets) | 확인됨 |
| 예산 자동 반응 | Pub/Sub 알림을 선택적으로 사용. 중복·역순·지연을 고려하고 로컬 원장과 대조 | 알림은 지연 가능, 추정 청구 데이터는 정정 가능. 이를 동기식 hard stop으로 취급하지 않음 | [Programmatic budget notifications](https://docs.cloud.google.com/billing/docs/how-to/budgets-programmatic-notifications) | 확인됨 |
| 지역 선택 | 데이터 위치·지연·서비스 가용성·리전별 SKU·이그레스를 함께 비교 | 최저 단가 리전만 선택하지 않음. 제안 시 공식 계산기/가격표 재조회 | [Cloud Run pricing](https://cloud.google.com/run/pricing), [Google Cloud pricing calculator](https://cloud.google.com/products/calculator) | 확인됨 |
| 한국 사용자 기본 리전 | `asia-northeast3`(서울)을 우선 제안하고 `us-central1`(아이오와)을 비용 비교 열에 병기 | 동일 사용량·SKU·통화로 두 리전의 공식 단가·이그레스·지연·데이터 위치를 비교. 미조회 상태에서 비용 우열 주장 금지 | [Compute Engine regions and zones](https://docs.cloud.google.com/compute/docs/regions-zones), [Google Cloud pricing](https://cloud.google.com/pricing) · 확인 2026-11-10 UTC | 확인됨 |
| 공개 단가 조회 경로 | Cloud Billing Catalog API의 `services.skus.list`로 SKU·리전·사용 단위·`pricingInfo`를 조회 | 공개 단가이며 계정별 계약 단가를 뜻하지 않음. 사용자 기기에서 API 키가 필요 | [Catalog API guide](https://docs.cloud.google.com/billing/v1/how-tos/catalog-api), [services.skus.list](https://docs.cloud.google.com/billing/docs/reference/rest/v1/services.skus/list) | 확인됨 |
| 계정별 단가 조회 경로 | 계약 단가는 권한이 있을 때 Cloud Billing Pricing API의 billing-account SKU price를 우선 조회 | API는 Preview; 조회 불가/지원 안 되는 가격 모델이면 `미산정`으로 남김 | [Pricing API guide](https://docs.cloud.google.com/billing/docs/how-to/get-pricing-information-api) | 확인됨 |
| Cloud Run 유휴 설정 | 0 스케일 후보는 request-based 과금과 최소 인스턴스 설정을 함께 확인 | 최소 인스턴스를 유지하거나 instance-based 과금이면 유휴 비용을 다시 산정 | [Minimum instances](https://docs.cloud.google.com/run/docs/configuring/min-instances) | 확인됨 |
| Batch 병렬도 | 작업의 task 수·동시 실행 수·VM 자원 요구량을 별도로 예측 | 작업 수만으로 VM 시간을 계산하지 않음 | [Job creation and execution](https://docs.cloud.google.com/batch/docs/create-run-job) | 확인됨 |
| 작업 종료 후 잔여 디스크 | VM 중지·삭제 후 보존되는 디스크를 별도 비용·정리 원장에 기록 | 컴퓨트 종료만으로 저장 비용 종료를 주장하지 않음 | [Persistent Disk](https://docs.cloud.google.com/compute/docs/disks/persistent-disks) | 확인됨 |
| 추정 대 실제 비용 대조 | 승인된 계정에서는 상세 Billing export의 SKU·프로젝트·리소스 사용량을 비용 원장과 대조하도록 설계 | export 활성화·BigQuery 조회 자체의 비용과 지연을 계산 | [Billing data export to BigQuery](https://docs.cloud.google.com/billing/docs/how-to/export-data-bigquery) | 확인됨 |
| 사용자 SKU·계약 단가 실조회 | 제안 시 사용자의 리전·SKU·통화·소비 모델을 특정하고 조회 영수증을 붙임 | 이번 오프라인 팩은 사용자 계정·API를 호출하지 않았으므로 금액 제시 금지 | 해당 사용자 계정의 공식 API 응답(아직 없음) | 미확인 |

## 제안 계산 계약

`월 추정 = Σ(선택 리전·SKU·소비 모델별 예상 사용량 × 공식 단가의 해당 사용량 구간) + 저장·네트워크·로그·제어면 비용 − 검증된 할인/무료 티어`.

공개 단가는 [Cloud Billing Catalog API](https://docs.cloud.google.com/billing/v1/how-tos/catalog-api)의 SKU·`serviceRegions`·`pricingExpression`·`effectiveTime`에서, 계약 단가는 권한이 있는 경우 [Cloud Billing Pricing API](https://docs.cloud.google.com/billing/docs/how-to/get-pricing-information-api)의 계정별 SKU 가격에서 가져온다. 사용량을 API의 `usageUnit`·구간 단위로 환산하고 `tieredRates`·집계 범위·무료 티어·청구 최소 단위를 서비스 문서와 대조한다. Preview API가 없거나 해당 가격 모델을 지원하지 않으면 공식 제품 가격 문서/계산기 링크와 수식만 보여 주고 숫자는 `미산정`으로 둔다. API 키·계정 토큰은 사용자 기기에만 둔다. **이 팩과 시뮬은 가격 API를 호출하지 않았다.**

반드시 workload 기간, 대기열 수, CPU·GiB·디스크 필요량, 요청/작업 횟수, 리전, 통화, 할인 자격, 단가 조회 시각, 계산식, 빠진 비용을 카드에 싣는다. 불확실한 항목은 영으로 채우지 않고 `미산정`으로 표시한다. 가격은 고정 약속이 아니며 승인 후에도 사용량 감시와 유휴 정지가 필요하다.
