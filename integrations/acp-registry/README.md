# ACP registry submission (Zed · JetBrains)

This directory holds the Elanous entry prepared for the [ACP agent registry](https://github.com/agentclientprotocol/registry). It is not published there yet.

1. Before each release, set `elanous/agent.json` `version` to the released `package.json` version and `distribution.npx.package` to `elanous@<that version>`; ensure that npm has the corresponding package version available.
2. Run `bun test test/integrations-acp-registry.test.ts` and check the 16px icon against the V6 mark in `docs/brand/icon/`.
3. After 대표 confirmation for external publication, fork `agentclientprotocol/registry`, copy the `elanous/` folder to the root of the registry fork (alongside the other agent folders), and open a PR to the registry. Do not submit or push to a public repository before that confirmation.

Release note (internal · next): ACP registry entry (agent.json and a 16px icon) is ready to submit for Zed and JetBrains.
