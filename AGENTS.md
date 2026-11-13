# AGENTS.md — QualityLoop (Codegeist 2026)

This file briefs any coding agent (Codex) working in this repository. Read it fully before every task.

## What we are building

QualityLoop is an Atlassian Forge app for Jira and Jira Service Management, category "Apps for Specialized Industries".

When a quality engineer saves defect details on a nonconformance (NC), QualityLoop immediately finds corrective actions (CAPAs) that were already closed and that share the same failure signature. It shows the evidence and records the engineer's decision.

- It never claims a CAPA failed.
- It never changes a CAPA's status.
- It does not monitor in the background.

### The four core capabilities (P0)

1. **Capture.** An issue panel form saves the record type (NC or CAPA), part number, failure mode, supplier, line, dates, and an effectiveness-evidence link. Data lives in one Jira issue property with key `qualityloop`.
2. **Match.** On save, JQL runs *as the viewing user* to find closed CAPAs with the same signature. Matching is deterministic and uses no AI.
3. **Inspect evidence.** A card shows the matched fields, dates, and whether effectiveness evidence is present or absent. Only issues the viewer can browse are shown.
4. **Approve follow-up.** The engineer chooses Confirm recurrence, Not a recurrence, or Raise effectiveness concern. Decisions are stored in Forge Custom Entity Store with versioned pair state; confirmed follow-ups retain task and repair metadata.

### States (never blur them)

- **Possible recurrence:** the system flags it from matching fields only.
- **Engineer-confirmed recurrence:** an explicit human action, with a reason and evidence.
- **Effectiveness concern:** an explicit human action. It creates a re-review task only after the user confirms.

## Hard rules

- Never edit docs/review/** or an earlier docs/tasks/T*.md. They are records. Add a new note instead.
- **Platform.** Forge, with UI Kit (`@forge/react`, `render: native`), `@forge/resolver`, `@forge/api`, `@forge/bridge`, and `@forge/kvs` when storage is needed. Node.js 22.x or 24.x. JavaScript unless the scaffold is TypeScript.
- **Use the `forge` MCP server tools** before writing manifest entries or using an API you have not verified in this repo:
  - `forge-development-guide`, `list-forge-modules`, `forge-app-manifest-guide`, `forge-backend-developer-guide`
  - `forge-ui-kit-developer-guide`, `list-ui-kit-components`, `get-ui-kit-component-reference`
  - `fetch-api-operation` and `get-api-required-scopes` for every Jira REST call and its scopes
  - `search-forge-docs` for anything else
  - `diagnose-forge-error` for lint, deploy or runtime errors

  Do not invent module properties, scopes or API shapes. If unsure, say so in your summary instead of guessing.
- **Use no other MCP tools.** Do not use GitHub, Gmail, Google Drive, Calendar, Contacts, sites, plugin-management or any other connector. Do not send email, create issues or pull requests, or deploy anything. Git is used only locally, and only if the owner asks.
- **Permissions.**
  - All user-facing reads and writes use `asUser()`.
  - Never use `asApp()` to read data that will be shown to a user.
  - Take the issue ID from resolver context (`req.context.extension.issue.id`), never from the frontend payload. Any ID that does arrive in a payload must be re-authorised by fetching that issue `asUser()` first. On 403 or 404, return nothing.
  - Never reveal counts or titles of records the viewer cannot browse.
- **No AI cost.** No `@forge/llm`. No external network egress. The app must qualify as Runs on Atlassian.
- **Out of scope.** No background triggers or scheduled triggers, unless a task explicitly asks for one.
- **Identifier matching is conservative.**
  - Always keep the original part-number string.
  - "Exact" means equal after trimming, collapsing inner whitespace, and uppercasing.
  - A different revision is "related", never "exact".
  - Never fuzzy-match typos silently.
- **Writes require confirmation.** Never write to an issue other than the current one without a confirmation dialog that lists the write.
- **Search.** Use the enhanced JQL search endpoint (`POST /rest/api/3/search/jql`), not the deprecated `/rest/api/3/search`.
- **Tests.** Put pure logic (normalisation, matching rules) in `src/lib/` with Jest unit tests. Run `npm test` before finishing. Run `forge lint` if it is available offline.
- **Do not run** `forge login`, `forge deploy`, `forge install` or `forge tunnel`. The human owner runs these. Never ask for, read, print or store API tokens or passwords.
- **Do not edit** the `app.id` in `manifest.yml`.
- **Evaluation data.** Do not open or modify `eval/test/`. That is the hidden evaluation split.

## Every task ends with a summary containing

1. Files changed, and why.
2. Manifest changes, especially new **scopes**. A scope change needs `forge deploy` followed by `forge install --upgrade` by the owner.
3. Exact commands for the owner to run, in order.
4. Anything you could not verify against Forge documentation.
5. Exactly what the owner should click or check to test the change.
