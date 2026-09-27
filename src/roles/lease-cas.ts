// 임대 CAS 판정(순수) — 공개 코어(`elanous role …`)가 쓰는 부분.
// 원래 scripts/botlab/core-lease.ts 에 있었으나 scripts/botlab/** 는 공개본에서 빠진다(release/public-export.yaml)
// ⇒ 공개판에서 `role-cli.ts` 가 모듈을 못 찾아 PWA 빌드·기동이 깨졌다(📏 2026-09-27 0.2.3 prepare). botlab 은 여기서 다시 내보낸다.

/**
 * 🔎⛔⭐ **「없다」와 「못 읽었다」를 gcloud 문면에서 «가른다»**
 *
 * 🩸 계기(라이브): 첫 판은 `404|not found` 만 봤는데 gcloud 는 이렇게 낸다 —
 *    ***`The following URLs matched no objects or files`***. ⇒ ***진짜 「없다」가 「못 읽었다」로 떨어졌다.***
 * ⛔ 그 둘이 갈려야 하는 이유: 「없다」는 ***CAS 를 `--if-generation-match=0` 으로 시도할 수 있는*** 상태이고,
 *    「못 읽었다」는 ***아무것도 하면 안 되는*** 상태다.
 * 📌 그래서 이 판정을 «순수»로 꺼냈다 — 시험이 gcloud 문면을 «그대로» 물 수 있게.
 */
export function isAbsentSaid(said: string): boolean {
  return /\b404\b/.test(said)
    || /not found/i.test(said)
    || /does not exist/i.test(said)
    || /matched no objects/i.test(said);     // ⇐ 🩸 라이브가 잡은 문면
}


export type CasOutcome =
  /** 이겼다 — 내가 잡았다/갱신했다. */
  | { readonly kind: 'won' }
  /** ⭐ ***졌다*** — 그 사이 남이 썼다(412). ⛔ 「실패」가 아니라 «정상 결과»다. */
  | { readonly kind: 'lost'; readonly detail: string }
  /** ⛔ 「졌다」로 접지 «않는다» — 네트워크·자격·버킷 문제일 수 있다. */
  | { readonly kind: 'unmeasured'; readonly why: string };

/**
 * 🔐⭐⭐ **CAS 산출을 «셋»으로 가른다** — ⛔ 이것이 이 파일에서 가장 중요한 함수다.
 *
 * 🔑 ***「졌다」와 「못 쟀다」를 뭉치면 이 설계가 무너진다***:
 * ```
 * 「졌다」    ⇒ 남이 primary 다 — ***정상***이고, 나는 조용히 물러난다
 * 「못 쟀다」 ⇒ 내가 «모른다» — ⛔ 그때 ***물러나도 안 되고 잡아도 안 된다***
 * ```
 * ⛔ 그 둘을 같은 값으로 내면 「네트워크가 끊겼을 뿐인데 primary 를 넘겨준다」가 된다.
 */
export function interpretCasResult(r: { readonly code: number | null; readonly said: string }): CasOutcome {
  if (r.code === 0) return { kind: 'won' };
  const said = r.said ?? '';
  // 📏 gcloud 는 전제조건 실패를 `412` ⊕ `PreconditionFailed`/`does not match` 로 낸다.
  //    ⛔ 코드 하나에 안 기댄다 — 문면과 «둘 다» 본다(gcloud 판이 바뀌어도 한쪽이 남는다).
  if (/\b412\b/.test(said) || /precondition/i.test(said) || /generation.*(match|mismatch)/i.test(said)) {
    return { kind: 'lost', detail: said.trim().split('\n').slice(-2).join(' / ').slice(0, 200) };
  }
  return {
    kind: 'unmeasured',
    why: `CAS 가 «졌는지 못 쟀는지» 모른다(code=${r.code}) — ${said.trim().split('\n').slice(-2).join(' / ').slice(0, 160)}`,
  };
}
