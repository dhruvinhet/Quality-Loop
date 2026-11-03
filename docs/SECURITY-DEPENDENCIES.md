# Production dependency triage — T19 / R-06

Reviewed 2026-11-03 against the installed lockfile. `npm audit --omit=dev --json` reports **14 affected package entries: 9 high, 5 moderate, 0 critical**. These include propagated findings on Forge/Atlaskit parents; there are **7 distinct advisory IDs across 4 vulnerable leaf packages**. An audit exit status of 1 is expected for these findings. No dependency versions, overrides, or lockfile entries were changed. `npm audit fix` was not run.

## Evidence and reachability

Executed `npm ls <package> --all --omit=dev` separately for `glob`, `minimatch`, `markdown-it`, and `prosemirror-view`, plus a combined tree and an expanded tree of their Forge/Atlaskit parents. Local evidence is generated under ignored `dist/t19/`: `audit-production.json`, `ls-*.txt`, `advisory-chains.txt`, `chains.json`, and `bundle-inclusion.json`.

`node scripts/audit-dependency-paths.js` statically bundles the actual five entry points with installed dependencies included, tree shaking enabled, and no package externals. It inspects esbuild's input graph without executing the resulting bundle. Each of these entries contains **zero files from all four vulnerable leaf packages**:

| Entry | Classification | glob | minimatch | markdown-it | prosemirror-view |
| --- | --- | ---: | ---: | ---: | ---: |
| `src/index.js` | Resolvers / event handlers | 0 | 0 | 0 | 0 |
| `src/frontend/index.jsx` | UI Kit issue panel | 0 | 0 | 0 | 0 |
| `src/frontend/issueContext.jsx` | UI Kit side view | 0 | 0 | 0 | 0 |
| `src/frontend/projectPage.jsx` | UI Kit project page | 0 | 0 | 0 | 0 |
| `src/frontend/adminPage.jsx` | UI Kit admin page | 0 | 0 | 0 | 0 |

Source inspection also found no application use of Markdown parsing, a ProseMirror editor/paste handler, filesystem globbing, or minimatch. The SDK implementation barrels do not import the manifest/schema/editor packages that appear in their installed dependency/type graphs. **Inference:** the advisory-specific code paths are not reachable from the current application bundles. This is stronger evidence than assigning risk solely from `dependencies` versus `devDependencies`, but it is a local static analysis, not an inspection of Forge's hosted bundles or a guarantee about future SDK/platform behavior. The Forge CLI is not installed here. Re-run the check when changing dependencies, entry points, or adding Markdown, rich-text editing, manifest processing, or filesystem patterns.

## Full dependency chains

All paths below start at `qualityloop@1.0.0`. Shared prefixes and suffixes are expanded explicitly so that npm's `deduped` nodes do not conceal the parent relationships.

**G — glob / minimatch.** Each of these four complete prefixes ends at the same `glob` installation:

```text
qualityloop -> @forge/api@8.4.0 -> @forge/manifest@13.8.0 -> glob@13.0.6
qualityloop -> @forge/kvs@2.1.1 -> @forge/api@8.4.0 -> @forge/manifest@13.8.0 -> glob@13.0.6
qualityloop -> @forge/bridge@7.2.1 -> @forge/manifest@13.8.0 -> glob@13.0.6
qualityloop -> @forge/react@12.4.0 -> @forge/bridge@7.2.1 -> @forge/manifest@13.8.0 -> glob@13.0.6
```

Append `-> minimatch@10.2.6` to each G path for the minimatch advisory. The affected copies are nested under `node_modules/@forge/manifest/node_modules/`. These are installed through Forge's manifest/configuration dependency graph; the vulnerable code is absent from the resolver and UI graphs above. They are not application runtime glob calls. `@forge/manifest@13.8.0` declares `glob: ^13.0.0`, so glob 14 is outside its supported dependency range.

**S — full schema prefixes used by Markdown and ProseMirror dependencies:**

```text
S1: qualityloop -> @forge/bridge@7.2.1 -> @atlaskit/adf-schema@56.7.3
S2: qualityloop -> @forge/react@12.4.0 -> @forge/bridge@7.2.1 -> @atlaskit/adf-schema@56.7.3
S3: qualityloop -> @forge/react@12.4.0 -> @atlaskit/adf-schema@56.7.3
S4: qualityloop -> @forge/react@12.4.0 -> @atlaskit/adf-utils@20.6.2 -> @atlaskit/adf-schema@57.0.1
S5: qualityloop -> @forge/react@12.4.0 -> @atlaskit/forge-react-types@2.13.0 -> @atlaskit/adf-schema@57.7.27
```

Each of S1–S4 has a direct edge to `@atlaskit/editor-prosemirror@8.0.3`; S5 has a direct edge to `@atlaskit/editor-prosemirror@9.0.0`. Each of S1–S5 also has an edge through `@atlaskit/adf-schema-generator@4.0.0 -> @atlaskit/editor-prosemirror@8.0.3`. Thus the generator path is also included for S5, even though its direct editor dependency is version 9.

**M — Markdown.** For every schema prefix that reaches editor 8, the full terminal path is:

```text
S1/S2/S3/S4 -> @atlaskit/editor-prosemirror@8.0.3 -> prosemirror-markdown@1.13.2 -> markdown-it@14.3.0
S1/S2/S3/S4/S5 -> @atlaskit/adf-schema-generator@4.0.0 -> @atlaskit/editor-prosemirror@8.0.3 -> prosemirror-markdown@1.13.2 -> markdown-it@14.3.0
```

The notation means substitute each complete S prefix in turn, preserving all packages and versions. `prosemirror-markdown` permits `markdown-it: ^14.0.0`; the published patch 14.3.3 is compatible with that range. This is a Forge UI/schema/editor dependency path, not a resolver Markdown path. It is absent from all current runtime entry graphs, and QualityLoop renders captured text through UI Kit `Text`/`TextArea` without importing a Markdown parser.

**P — ProseMirror view.** Append `-> prosemirror-view@1.41.5` to each editor path above (direct editor 8 or 9, or the generator/editor-8 path). npm also reports the editor-8 routes through:

```text
@atlaskit/editor-prosemirror@8.0.3 -> prosemirror-dropcursor@1.8.2 -> prosemirror-view@1.41.5
@atlaskit/editor-prosemirror@8.0.3 -> prosemirror-history@1.5.0 -> prosemirror-view@1.41.5
@atlaskit/editor-prosemirror@8.0.3 -> prosemirror-state@1.4.4 -> prosemirror-view@1.41.5
```

These reuse every schema prefix reaching editor 8 above. Both installed Atlaskit editor versions pin `prosemirror-view` exactly to 1.41.5. This is a Forge UI/type/schema dependency path; it is absent from the local UI and resolver bundles. The app does not instantiate the vulnerable editor or its paste handler.

## Advisory decisions

The affected ranges and advisory IDs below come directly from the npm audit response. The fixed versions were checked against the npm registry using `npm view <package>@<fixed-version> version`; these are upstream package fixes, not claims that a compatible Forge SDK release has shipped them.

| Advisory ID / npm source | Severity | Installed package | Full chain | Vulnerable path and runtime assessment | Available upstream fix | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) / 1244013 | Moderate | `glob@13.0.6` | All G paths | AbortSignal cancellation bypass permits traversal after timeout; manifest/config tooling dependency, absent from resolver/UI bundles. | `glob@14.0.2`; installed manifest range is `^13.0.0`. | **Wait for Forge release** that adopts a fixed glob range. Accept the current non-reachable runtime exposure temporarily; do not force a major transitive override. |
| [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) / 1244012 | Moderate | `minimatch@10.2.6` | Every G path plus minimatch | Globparts amplification DoS; same manifest/configuration path, absent from current runtime bundles. | `minimatch@11.0.1`; requires an upstream compatible glob/manifest update. | **Wait for Forge release**; no untested major override. |
| [GHSA-r7fv-28h4-cvq7](https://github.com/advisories/GHSA-r7fv-28h4-cvq7) / 1242600 | High | `markdown-it@14.3.0` | All M paths | Quadratic smartquotes processing; no Markdown parser in runtime bundles or application use. | `markdown-it@14.3.2` or newer; checked 14.3.3 covers all four Markdown advisories. | **Accept**, temporarily, for this unreachable code path. A reviewed lockfile refresh to 14.3.3 is available; no automatic fix applied. |
| [GHSA-vfgh-jcmw-g37q](https://github.com/advisories/GHSA-vfgh-jcmw-g37q) / 1242646 | Low | `markdown-it@14.3.0` | All M paths | Quadratic inline HTML parsing with HTML enabled; parser absent from runtime bundles. | `markdown-it@14.3.3`. | **Accept**, temporarily, on the same reachability evidence. |
| [GHSA-gfr2-rv44-r23c](https://github.com/advisories/GHSA-gfr2-rv44-r23c) / 1242672 | High | `markdown-it@14.3.0` | All M paths | Quadratic multiline reference rendering; parser absent from runtime bundles. | `markdown-it@14.3.3`. | **Accept**, temporarily, on the same reachability evidence. |
| [GHSA-253c-mchw-3w2r](https://github.com/advisories/GHSA-253c-mchw-3w2r) / 1244221 | Moderate | `markdown-it@14.3.0` | All M paths | Quadratic paths with linkify enabled; parser absent from runtime bundles. | `markdown-it@14.3.1` or newer; checked 14.3.3 covers all four. | **Accept**, temporarily, on the same reachability evidence. |
| [GHSA-c8x8-7fp4-3x9w](https://github.com/advisories/GHSA-c8x8-7fp4-3x9w) / 1241270 | High | `prosemirror-view@1.41.5` | All P paths | Paste-handling XSS; editor/paste code absent from runtime bundles. | `prosemirror-view@1.42.3`; Atlaskit currently pins 1.41.5. | **Wait for Forge release** that updates the pinned editor stack. Do not override its exact version without SDK validation. |

The npm report's low advisory is rolled into the `markdown-it` package's high aggregate severity, explaining why the package summary contains no low entries. Parent findings (`@forge/api`, `@forge/bridge`, `@forge/kvs`, `@forge/manifest`, `@forge/react`, and the affected Atlaskit schema/editor packages) are propagation of these leaf advisories, not additional distinct advisory IDs. npm proposes major-version **downgrades** such as bridge 5.5.0, React 11.4.0, API 6.1.1, or KVS 1.0.5 for several parents; those are not accepted fixes for this app's current SDK APIs.

## Recheck procedure

```powershell
npm audit --omit=dev --json
npm ls glob --all --omit=dev
npm ls minimatch --all --omit=dev
npm ls markdown-it --all --omit=dev
npm ls prosemirror-view --all --omit=dev
node scripts/audit-dependency-paths.js
```

Reassess before adding any feature that imports these packages or after changing the lockfile/Forge SDK. After a deliberate dependency update, rerun tests, ESLint, build, dev evaluation, this audit, and bundle inclusion checks, then have the owner verify the hosted app. This triage does not certify an advisory-free installation and does not assess future platform releases.
