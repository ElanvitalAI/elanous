---
name: upstage-solar-decide
description: Provides an explicit Solar Decide beta choice/probability boundary when a caller requests this beta and supplies a confirmed wire adapter.
disable-model-invocation: true
---
# Solar Decide — beta

Use only when explicitly requested. Do not select this plugin as a graph default.

1. Explain that Solar Decide is beta. Obtain explicit beta opt-in and consent to send the judgment input to Upstage.
2. Use U-0 Q10's shared `cred:upstage.api_key` transport. Do not create another slot, read a cache or shell key, or start another fake server. If the key is absent, return shared-key setup guidance without a POST.
3. Activate the installed plugin and invoke its `SolarDecideBeta` tool with `state`, `question`, `choices`, explicit `enableBeta` and `consentToSend`, plus positive `timeoutMs` and `maxResponseBytes`. The host action supplies the U-0 transport to the provider; do not pass keys or executable adapters as tool arguments. A host-owned evidenced `solarDecideWire` must be configured before any POST. Upstream field names are not known; never guess them. Without this contract, keep `wire-contract-required` rather than returning a choice.
4. Fixture contracts are for the test universe only. The known path is `/v1/systemone`; local fixture field names are not upstream documentation.
5. Return only the normalized beta-marked status, offered choice and finite probability. Never repeat a request, raw response, key or transport error. Do not claim live calibration from a fake response.

U-0 PR #37565 is a dependency; upstream schema confirmation is pending. See [the package contract](../../README.md).
