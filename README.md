# ccmjs component-release

Shared build and release tooling for ccmjs components. A reusable GitHub Actions workflow builds a component from `main` (or an explicit ref), creates a separate build commit and publishes only its version tag. The component's source branch remains unchanged.

## Use from a component repository

After this repository has been pushed and tooling release `v2.0.0` has been tagged, copy [`examples/tag.yml`](examples/tag.yml) into the component repository as `.github/workflows/tag.yml`. Replace any existing release workflow there.

Both `uses: ...@v2.0.0` and `tooling-ref: v2.0.0` must refer to the **same tooling version**. A full commit SHA in both places provides an immutable pin. These references select the release tooling; the source header `@version` selects the component version. Before the first tooling tag exists, use the same published commit SHA in both places.

A reusable workflow runs in the caller's context: checkout would otherwise retrieve only the component repository. `tooling-ref` explicitly pins the separate tooling checkout. See [GitHub's reusable workflow documentation](https://docs.github.com/en/actions/concepts/workflows-and-actions/reusing-workflow-configurations).

Commit the caller workflow to the component's default branch, then open **Actions → Build & Tag → Run workflow**. The version is read from the source; no version input is shown. Start with the default dry run and inspect the uploaded artifact. Disable `dry-run` to publish. No extra token or `secrets: inherit` is required for public repositories; the caller grants `contents: write`. Repository policies must allow these Actions and tag creation. The shared tooling repository must be public for this token-free cross-repository checkout.

### Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `tooling-ref` | required | Same tooling release tag or full SHA used in `uses` |
| `source-ref` | `main` | Component branch, tag or commit to build; the dispatch branch does not override this |
| `main` | automatic | Root `.js` or `.mjs` filename; automatic component selection requires exactly one `ccm.*.mjs`, excluding `.min.mjs` |
| `framework` | `false` | Select `ccm.js`, verify its runtime version and run `node --test test/*.test.cjs` |
| `dry-run` | `true` | Build and validate without publishing |

The workflow returns `url` and `tag`. During dry runs the URL is prospective and is not published. This also applies to development versions, which cannot be published. Every successful build is uploaded as an Actions artifact, even before publication.

## Build contents

For version `1.2.3`, `ccm.hello.mjs` becomes `ccm.hello-1.2.3.min.mjs` plus `ccm.hello-1.2.3.min.mjs.map`. Terser minifies JavaScript and handles `.mjs` as ES modules. Maps embed the transformed source and link to the exact version on jsDelivr.

- `resources/` is included recursively. JS, MJS and CSS are minified **under their original filenames**, preserving resource and import references. JavaScript gets an adjacent `.map`. CSS URLs are not rebased.
- Other resources (including images and HTML) are copied byte for byte.
- `libs/` is copied byte for byte, including library licenses.
- Root `LICENSE`, `LICENCE` and `NOTICE` files, including extensions, are retained.
- README, examples, workflow files and other root content are excluded. No files in the source checkout are removed or modified.

Every `././` marker in the main component and resource JavaScript is replaced with `https://cdn.jsdelivr.net/gh/OWNER/REPO@vVERSION/`. This intentionally changes the old workflow's GitHub Pages behavior: included resources and libraries are now pinned to the component tag. External absolute URLs remain unchanged. Markers in CSS, HTML and unprocessed libraries are not transformed. Use ordinary relative URLs within those files.

No bundling, arbitrary import rewriting, component-object version injection, integrity hashes, GitHub Releases or changelog generation is performed. Extra root modules are not included; put supporting modules in `resources/` or `libs/`. Dependencies that refer back to the unversioned main filename need an explicit adjustment before release. Existing `.map` files next to resource JavaScript are rejected to prevent collisions; supply source resources without stale generated maps. Symbolic links in included trees are rejected.

## Publication

The publisher checks for the exact remote tag, constructs a Git tree from the output using a temporary index, and creates a build commit whose parent is the selected source commit. It pushes that commit directly to `refs/tags/vVERSION` without force. It never pushes a branch, rewrites tags or modifies the checked-out index. Release runs within a component repository are serialized; a raced tag creation is also rejected by Git.

Dry runs perform the same checks and create only a local build commit. They do not verify server-side push permissions or CDN availability. Publication makes the files available for jsDelivr to serve from the GitHub tag; this workflow does not contact or prewarm the CDN.

## Local development

Requires Node.js 22 or newer.

```sh
npm ci
npm test
node scripts/build.mjs --source ../hello --output /tmp/hello-release-1.2.3 --repository ccmjs/hello
```

The output directory must not already exist, its parent must exist, and it must be outside the source directory. Failed builds may leave a partial output directory; inspect it and use a new output path when retrying. Local build commands do not publish anything.

Tests cover versions, executable ES-module output, resource paths and binary assets, source maps, license retention, unsafe paths, ambiguous entry points and publication against a temporary local Git remote. CI runs these tests with Node.js 22.

When releasing this tooling, publish its source tree with a new tooling tag and update both references in consuming repositories together. Do not run the component release workflow on this tooling repository itself.

## Version source and migration from v1

Put exactly one JSDoc `@version` in the leading documentation header of the main file:

```js
/**
 * @overview My component
 * @version 1.2.3
 */
export const component = { /* ... */ };
```

A leading `"use strict"` directive is allowed before the header. Versions must be canonical SemVer without a `v` prefix. Missing, duplicate, misplaced or invalid annotations fail the build. The annotation is preserved in the minified main file and embedded source map. Source files are parsed, never executed to discover their version.

After releasing `1.2.3`, set the next development version (for example `1.3.0-dev`). Prerelease identifiers starting with `dev` (case-insensitive) are only allowed in dry runs. Other prereleases such as `1.3.0-rc.1` may be published. Build metadata is supported. A development version identifies a development line, not an exact commit; use the Git commit to distinguish snapshots. The workflow does not automatically increment versions or modify the source branch.

Before publishing, replace the development version with the intended release version and commit and push it. Select **Run workflow**, first with dry-run enabled, then disabled. The publisher refuses an existing remote tag in both modes.

For framework repositories set `framework: true`. The `ccm.js` header and its `const ccm = { version: "..." }` value must match. For `28.0.0`, output is `ccm-28.0.0.min.js` and its `.map`. Framework source tests under `test/*.test.cjs` must be committed; the workflow fails if they are missing or fail. An explicit `main: ccm.js` also checks version consistency, but use `framework: true` to enable the tests.

This is a breaking workflow-interface change. Publish the tooling source as `v2.0.0` first, then update **both** tooling references in callers to `v2.0.0`, remove the old `version` dispatch input and `with.version`, and add the source annotation. Existing callers pinned to `v1.0.0` continue using the old manual-input workflow. Do not move the old tooling tag.

Locally, builds default to dry-run eligibility. Add `--publish` to the build command to reject development versions (this flag alone does not push anything), and `--framework` for framework selection and version consistency. The local build command does not run source tests; run `node --test test/*.test.cjs` from the framework repository separately.
