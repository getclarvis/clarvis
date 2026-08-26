# Third-party notices

Clarvis source code is distributed under the [MIT License](LICENSE). A portable Clarvis archive also
bundles third-party software and data needed to run without a separately installed runtime or package
manager.

This document is an inventory and routing aid, not a replacement for the license texts or legal
review.

## Bun 1.4.0

Portable archives include the Bun executable used by the native packaging job. The release toolchain
is pinned to Bun `1.4.0` (`1.4.0+34cbb9a40`). Bun itself is MIT-licensed and its executable statically
links or embeds other components, including LGPL-licensed JavaScriptCore/WebKit and TinyCC.

The upstream notice, linked-library inventory, embedded-polyfill inventory, WebKit source location,
and relinking instructions are preserved verbatim in [`third-party/bun/LICENSE.md`](third-party/bun/LICENSE.md).
The corresponding Bun source tag is
[`bun-v1.4.0`](https://github.com/oven-sh/bun/tree/bun-v1.4.0); Bun's notice links the patched WebKit
source and describes how to build a Bun binary with a modified JavaScriptCore/WebKit.

Release maintainers must review this notice and the exact native Bun artifact for every release.
Including the notice closes the identified packaging omission; it does not by itself constitute a
legal conclusion about every redistribution obligation.

## models.dev snapshot

Clarvis contains a generated model-catalog snapshot whose recorded source is
[`https://models.dev/api.json`](https://models.dev/api.json). models.dev is provided under the MIT
License, copyright 2025 models.dev; the license text is preserved in
[`third-party/models.dev/LICENSE`](third-party/models.dev/LICENSE).

The current snapshot exists in the Clarvis history from the initial monorepo commit and was last
updated in Clarvis commit `74f88eab75a128bfb1ffdb8ee34e64b99e13e2c0` on 2026-08-20. The snapshot does
not record an upstream commit identifier, so this repository does not claim a more precise upstream
revision.

## Vercel AI SDK

Clarvis uses the `ai` and `@ai-sdk/*` packages from the Vercel AI SDK. Their exact resolved versions
are recorded in `bun.lock`; their code may be incorporated into Code's compiled chunks rather than
copied as external runtime packages. These packages declare the Apache License 2.0, copyright 2023
Vercel, Inc.; the upstream license text is preserved in
[`third-party/vercel-ai-sdk/LICENSE`](third-party/vercel-ai-sdk/LICENSE).

Package-local license files remain in the copied `node_modules` directories when upstream includes
them. The standalone license makes the shared Vercel AI SDK terms available even when a package in
the resolved family is bundled or does not carry its own top-level license file. Each portable
archive's generated `THIRD_PARTY_NOTICES.txt` routes back to this static notice.

## Packaged JavaScript and native dependencies

The portable packager computes the runtime dependency closure for each target. Every archive contains
a generated `THIRD_PARTY_NOTICES.txt` listing those package names, versions, and declared license
identifiers. Complete license files shipped by those packages remain within their respective
`node_modules` directories.

Because the closure can differ by target and dependency version, the generated archive inventory is
the authority for a particular binary. Review it together with this static notice before publishing.
