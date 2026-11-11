# kr-flow read-only composition graphs

This plugin declares three fixed-basket demonstration graphs. Market data enters only through `requires` contracts; the shared `scripts/kr-flow-composites.ts` command joins verified node outputs. No order or account path exists in the plugin. The graphs use the 2026-11-09 fixed observation window for the 11-21 demonstration. They are examples, not a live scanner or investment recommendation.

| Graph | Required data contracts | Output and limit |
| --- | --- | --- |
| `sector-flow` | `market.quote@1` and `market.kr-flow@1` for Samsung Electronics and LG Energy Solution | Compares one representative stock per sector by same-day foreign plus institution net volume. This is not the original rolling z-score or whole-sector universe. |
| `battery-signal` | `market.quote@1` and `market.kr-flow@1` for LG Energy Solution, Samsung SDI, and Ecopro | Weights same-day net volume 50/35/15. The original five-day investor sum is unavailable in the current contract. |
| `etf-price` | `market.ohlcv@1` for ETF 471990, six daily bars | Computes latest close, one-day and five-session change. Constituent-return attribution needs a future holdings contract. |

All outputs include “정보 제공·판단 보조이며 투자 권유 아님”. A missing or inconsistent market response fails the graph. The plugin performs no market HTTP request itself.

## Source command → contract inventory

The table below is asserted by `test/kr-flow-command-contract-map.test.ts`. KRX has 13 command names and 14 distinct API IDs because `krx-stock-info` selects a KOSPI or KOSDAQ service by `board`.

| KIS command | Contract | Status |
| --- | --- | --- |
| `foreign-net` | `kr.flow.foreign@1` | mapped; adapter pending |
| `investor` | `kr.flow.investor@1` | mapped; adapter pending |
| `investor-time` | `kr.flow.investor-time@1` | mapped; adapter pending |
| `estimate` | `kr.flow.estimate@1` | mapped; adapter pending |
| `price` | `market.quote@1` | KIS adapter active |
| `ohlcv` | `market.ohlcv@1` | KIS adapter active |
| `market-flow` | `kr.flow.market@1` | mapped; adapter pending |
| `investor-detail` | `kr.flow.investor-detail@1` | mapped; adapter pending |
| `frgn-institution` | `kr.flow.intraday@1` | mapped; adapter pending |
| `short-sale` | `kr.short-sale@1` | mapped; adapter pending |

| KRX command | API ID | Contract |
| --- | --- | --- |
| `krx-market` | `stk_bydd_trd` | `kr.market.daily@1` |
| `krx-kosdaq` | `ksq_bydd_trd` | `kr.market.daily@1` |
| `krx-index` | `kospi_dd_trd` | `market.index@1` |
| `krx-kosdaq-index` | `kosdaq_dd_trd` | `market.index@1` |
| `krx-etf` | `etf_bydd_trd` | `kr.etp.daily@1` |
| `krx-etn` | `etn_bydd_trd` | `kr.etp.daily@1` |
| `krx-stock-info` KOSPI | `stk_isu_base_info` | `market.instrument@1` |
| `krx-stock-info` KOSDAQ | `ksq_isu_base_info` | `market.instrument@1` |
| `krx-bond-index` | `bon_dd_trd` | `market.index@1` |
| `krx-deriv-index` | `drvprod_dd_trd` | `market.index@1` |
| `krx-futures` | `fut_bydd_trd` | `kr.derivatives.futures@1` |
| `krx-options` | `opt_bydd_trd` | `kr.derivatives.options@1` |
| `krx-bond` | `bnd_bydd_trd` | `kr.bond.daily@1` |
| `krx-kts` | `kts_bydd_trd` | `kr.bond.daily@1` |
