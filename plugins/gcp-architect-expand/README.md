# GCP architect expand — declaration + offline simulation

`plugin.json` and `graph.yaml` describe the future workflow. Every bundled executable recipe fails closed; no GCP connector is included. Installing this skeleton cannot provision a cloud resource.

From the repository root run `bun src/ux-sim/gcp-architect-expand-fake-world.ts`. The simulation creates temporary fake project/cost records, calls the existing resource lease ledger, checks the approval gate and deletes its temporary files. `realGcpCalls` must be `0`.

Design: [RFC](../../내부 문서 `RFC-gcp-expand-architect-plugin`) · [official source decision table](../../packs/gcp-architect-expand/content/decision-table.md).

Membership feature grants are declared in `entitlements.json` with a deny-by-default policy. The current skeleton does not expose paid workflows or implement a membership resolver; a later host integration must check this table before selecting a graph or knowledge pack. No plugin code branches on membership tier.
