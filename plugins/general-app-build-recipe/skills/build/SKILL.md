---
name: general-app-build-recipe/build
description: Build any new application from a local architecture document through frontend, backend, persistent synthetic seed, green tests and supported deployment.
---

# Build a new application from its architecture

Use this recipe for a request to make a new app or service, especially when the user asks to populate it with synthetic data and run or deploy it. Keep the user's domain and requirements; do not substitute a canned product, sample domain or legacy absolute workspace path. Resolve the current work directory before creating files. Record whether data, cloud resources, member connection and public publication were actually requested and available.

Work in this order. Keep a phase receipt with elapsed time, paths, tool result and exit code. A failed phase remains failed until a rerun of that phase passes; do not skip forward or report completion from generated files alone.

## 1. Architecture document first

Write a local, application-specific `ARCHITECTURE.md` before implementation. Local runtime and deployment are required design choices even when a cloud expansion is requested. Treat GCP expansion as an optional additional design; if there is no cloud connection, state that no resources were observed or created. Never invent an existing resource, live cost or measured capacity.

Apply the architecture-deliverables quality rubric to the design:

- State background, user requirements and assumptions; show frontend, backend/API, data model and persistence, local runtime, deployment boundary, and the main user flows. Explain each component's role and the service alternatives and decisions.
- Show users, edge, application, data, observability and security layers; system/project/account, zone/region and network/VPC boundaries where applicable; numbered and labeled data flows, legend, title and version. Every flow must connect actual source and target components. Cloud variants use verified official icon assets; local variants use editable generic shapes.
- Include security classification, capacity assumptions and their evidence status, cost estimate only when grounded in stated assumptions, cost reduction options, alternatives and decision record. Label unknown or unmeasured values explicitly. A local single-host design must not claim measured large-scale concurrency.
- When `architecture_deliverables` is available, prepare its structured design JSON from the requirements and render editable Excalidraw and draw.io, SVG, PNG, HTML and integrated PDF from that same source. Check `verification.json` and hashes before citing the bundle. The PDF must have a cover, contents, executive summary, embedded diagram, tables, appendix, and the background/requirements/components/data flow/security/cost/savings/alternatives/decisions sections. If the renderer is unavailable or verification fails, retain the local Markdown design and report the missing diagram/PDF as an incomplete quality item; do not cite nonexistent files.

## 2. Implement the documented application

Use the approved app creation capability when available. Give it the complete `ARCHITECTURE.md` and model-authored frontend, backend/API, database schema/access code and runtime metadata as one coherent file artifact. The code must match the architecture's data flows, routes and local start command. A backend-only service is incomplete when a user-facing app was requested. If the creation capability is unavailable, report that boundary instead of claiming a tool call occurred.

## 3. Populate persistent synthetic data

Create an explicit, repeatable seed script for the selected persistent store. Mark the data as synthetic in the UI/API and documentation. A restart must retain the seeded records; a second seed run must not silently duplicate them. Use a transaction for related records so interruption does not leave a partial set. Keep user supplied values distinct from defaults and assumptions. In-memory sample objects alone do not satisfy a request to populate an application.

## 4. Run, test, repair and recheck

Install dependencies in the isolated project, run the actual tests, and capture the direct exit code without a pipe that hides it. Exercise a local health check, the frontend entry and one representative end-to-end workflow against the real local process. Inspect failures, repair the app, and rerun the failing test and affected workflow until green or the execution budget is exhausted. Never invert a failing expectation to make a broken workflow green. Record remaining failures and stop the success claim if tests or user flow remain red.

## 5. Deploy only through a supported path

After green local evidence, use the registered publication capability and its owner/confirmation rules. Verify the returned public HTTPS URL, expected marker and undo receipt when publication is actually available. If publication or a member connection is unavailable, return the local result with the exact blocker and no public URL. Local HTTP 200, file generation and a proposed relay do not count as public deployment.
