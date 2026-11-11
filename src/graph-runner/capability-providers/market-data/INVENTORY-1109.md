# Market-source and kr-flow contract inventory (11-09)

Based on `seat-state/R-MKT/KR-FLOW-INVENTORY-1109.md` and OP's KRX specification. A mapped contract is not an implemented adapter unless the status says *active*.

| Source | Contracts in scope | `eln secret` slots | Status |
| --- | --- | --- | --- |
| Toss Securities | `market.quote@1`, `market.orderbook@1`, `market.ohlcv@1`, `market.instrument@1`, `fx.rate@1`, `market.calendar@1` | `cred:toss.client_id`, `cred:toss.client_secret`; `cred:toss.account_seq` is inventoried but not read by market adapters | quote/OHLCV active; other mappings pending |
| Yahoo Finance | `market.index@1`, `kr.derivatives.futures@1` (index/futures quotes) | none | keyless public chart declaration active; fixed-response test |
| EODHD | `market.quote@1`, `market.ohlcv@1`, `market.fundamentals@1` | `cred:eodhd.api_key` | quote/OHLCV active; fundamentals pending |
| Twelve Data | `market.quote@1`, `market.intraday@1` (US) | `cred:twelvedata.api_key` | quote/intraday declarations active; fixed-response tests |
| FinancialDatasets.ai (FDS) | `market.quote@1`, `market.ohlcv@1`, `market.fundamentals@1` (US) | `cred:fds.api_key` | quote/OHLCV/fundamentals declarations active; fixed-response tests |
| KIS production | `market.quote@1`, `market.ohlcv@1` plus named kr-flow contracts below | `cred:kis.app_key`, `cred:kis.app_secret`; `cred:kis.account` inventoried but not read by market adapters | quote/OHLCV/`market.kr-flow@1` active; other mappings pending |
| KIS VTS | same contracts; `mode: vts` configuration chooses the mock host | same slot names per OP inventory; live entitlement and separate VTS credentials require OP confirmation | fixture-backed quote proven; other mappings pending |
| KRX Data Marketplace | named KRX contracts below | `cred:krx.api_key` | 14 read-only API IDs declared from OP's specification; fixed-response tests cover every route; each live service still needs portal approval |
| pykrx | `market.ohlcv@1` KR fallback | none | optional local library adapter active with fixed-response test; library availability checked before selection |

KIS `mode` and Toss base URL are configuration, not secret values. The one-time migration reads `KIS_MODE` from the source `.env`, validates `real/prod/vts/paper`, and writes `kis.mode` to `~/.elanous/market-data.json` with owner-only permissions; it reports the name only. The KIS adapter reads that config unless a caller passes an explicit mode. No token cache value belongs in the slot inventory. The active graph adapters do not expose a trade or account capability.

## `kr-flow` command mapping

| Source | Command | Contract |
| --- | --- | --- |
| KIS | `foreign-net` | `kr.flow.foreign@1` |
| KIS | `investor` | `kr.flow.investor@1` |
| KIS | `investor-time` | `kr.flow.investor-time@1` |
| KIS | `estimate` | `kr.flow.estimate@1` |
| KIS | `price` | `market.quote@1` (PER/PBR and foreign ownership need a future enriched schema) |
| KIS | `ohlcv` | `market.ohlcv@1` |
| KIS | `market-flow` | `kr.flow.market@1` |
| KIS | `investor-detail` | `kr.flow.investor-detail@1` |
| KIS | `frgn-institution` | `kr.flow.intraday@1` |
| KIS | `short-sale` | `kr.short-sale@1` |
| KRX | `krx-market`, `krx-kosdaq` | `kr.market.daily@1` |
| KRX | `krx-index`, `krx-kosdaq-index` | `market.index@1` |
| KRX | `krx-etf`, `krx-etn` | `kr.etp.daily@1` |
| KRX | `krx-stock-info` | `market.instrument@1` |
| KRX | `krx-bond-index`, `krx-deriv-index` | `market.index@1` |
| KRX | `krx-futures` | `kr.derivatives.futures@1` |
| KRX | `krx-options` | `kr.derivatives.options@1` |
| KRX | `krx-bond`, `krx-kts` | `kr.bond.daily@1` |

The table covers **10 KIS command names** and **13 KRX command names / 14 API IDs**. `krx-stock-info` selects KOSPI or KOSDAQ service by board. KIS mapping-only contracts have no live provider until each read-only response is normalized. The `sector-flow`, `battery-signal`, and `etf-price` demonstrations are plugin graphs under `plugins/kr-flow-composites/`; they compose existing contracts and do not add core graph functions. Their one-day or representative-basket outputs explicitly state how they differ from the original skill calculations.

## Read-only boundary

The active Toss and KIS graph providers call OAuth and quotation endpoints only. They have no order or account endpoint, no order method, and no `cred:toss.account_seq`/`cred:kis.account` lookup. Tests scan both provider modules for prohibited order/account paths and assert their fixed-response network calls are quotation-only. The ARG memo keeps the exact disclaimer “정보 제공·판단 보조이며 투자 권유 아님”.

KRX publishes a [service catalogue](https://openapi.krx.co.kr/contents/OPP/INFO/service/OPPINFO004.cmd) and [terms](https://openapi.krx.co.kr/contents/OPP/INFO/OPPINFO002.jsp); an API key alone does not prove service approval. OP's `KRX-SPEC-FROM-KR-FLOW-1109.md` has 14 API IDs: 13 CLI commands, with `krx-stock-info` selecting one of two board-specific IDs. `AUTH_KEY` is a URL query parameter in that source, not an HTTP header. Production response shape and service entitlement still need live verification. Yahoo's chart endpoint is public but is not a guaranteed official feed, so usage terms and reliability need owner review. The [KIS official configuration](https://github.com/koreainvestment/open-trading-api/blob/main/kis_devlp.yaml) distinguishes production and VTS hosts and shows separate paper credentials, so VTS live use must be checked against the user's actual enrollment.
