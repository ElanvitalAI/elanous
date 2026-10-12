// REVIEW-ACP-POD ②-b — Pod 안 리뷰를 «호스트 리뷰로 미룸».
//
// S  ②-a(#26457)로 호스트가 Pod merge-ready PR 을 Claude ACP 로 리뷰한다. 그런데 Pod 안 하니스 리뷰는 그대로 api 로 돌아
//    켜면 리뷰가 «둘»(돈 두 번)이다.
// C  오케스트레이터는 «실제 리뷰»(`reviewed=true`)가 있어야 merge-ready 를 낸다 — 그냥 끄면 `no-real-review` 로 멎는다.
// Q  Pod 안 리뷰를 어떻게 «정직하게» 비우나?
// A  발사 호스트가 ACP 리뷰를 맡을 때만 자식 env 에 표지를 싣는다. 자식은 api 리뷰를 부르지 않고
//    `reviewed=false` ⊕ `failureReason=deferred-to-host` 를 낸다(⛔ verdict 를 clean 으로 꾸미지 않는다).
//    오케스트레이터는 «호스트 병합(mergeByHost)» 런에서만 그 상태를 merge-ready 로 받고 `mergeReason` 에 적어 호스트로 돌려보낸다.
//    호스트는 그 표지를 보면 ACP 리뷰를 «반드시» 하고, 못 하면(refused) 병합하지 않는다(fail-closed).

/** 발사 호스트 → Pod 자식: 「리뷰는 호스트가 Claude ACP 로 한다 — Pod 안 api 리뷰를 부르지 마라」. 값 `1` 만 켠다. */
export const REVIEW_DEFERRED_TO_HOST_ENV = 'ELANOUS_REVIEW_DEFERRED_TO_HOST';
/** 미룬 리뷰의 `failureReason`(`reviewed=false` 의 «왜»). */
export const REVIEW_DEFERRED_TO_HOST_FAILURE = 'deferred-to-host';
/** 자식 merge-ready 결과의 `mergeReason` — 호스트가 이 값으로 «Pod 리뷰 없음»을 안다. */
export const REVIEW_DEFERRED_TO_HOST_MERGE_REASON = 'review-deferred-to-host';

export function reviewDeferredToHostFromEnv(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[REVIEW_DEFERRED_TO_HOST_ENV]?.trim() === '1';
}
