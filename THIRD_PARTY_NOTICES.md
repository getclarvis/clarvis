# Third-party notices

Clarvis source code is distributed under the [MIT License](LICENSE). A portable Clarvis archive and
the isolated-runtime standalone artifact also bundle third-party software and data needed to run
without a separately installed language runtime or package manager.

This document is an inventory and routing aid, not a replacement for the license texts or legal
review.

## Bun 1.4.0

Portable archives include the Bun executable used by the native packaging job; the isolated worker
is a Bun-compiled standalone executable. The release toolchain is pinned to Bun `1.4.0`
(`1.4.0+34cbb9a40`). Bun itself is MIT-licensed and its executable statically links or embeds other
components, including LGPL-licensed JavaScriptCore/WebKit and TinyCC.

The upstream notice, linked-library inventory, embedded-polyfill inventory, WebKit source location,
and relinking instructions are preserved verbatim in [`third-party/bun/LICENSE.md`](third-party/bun/LICENSE.md).
The corresponding Bun source tag is
[`bun-v1.4.0`](https://github.com/oven-sh/bun/tree/bun-v1.4.0); Bun's notice links the patched WebKit
source and describes how to build a Bun binary with a modified JavaScriptCore/WebKit.

Release maintainers must review this notice and the exact native Bun artifact for every release.
Including the notice closes the identified packaging omission; it does not by itself constitute a
legal conclusion about every redistribution obligation.

## mise 2026.8.2

The runnable isolated-runtime image includes the official `mise` 2026.8.2 Linux binary as its
on-demand toolchain bootstrap. Image construction downloads the architecture-specific release
archive, verifies its source-owned SHA-256, and copies no language runtime installed by mise into
the image. mise is MIT-licensed, copyright Jeff Dickey; the verified release archive's license is
preserved in the image at `/usr/share/licenses/mise/LICENSE`. The corresponding immutable upstream
release is [`v2026.8.2`](https://github.com/jdx/mise/releases/tag/v2026.8.2).

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

## Croner 10.0.1

The terminal UI bundles Croner for conversation prompt calendar calculations. The exact dependency
version is pinned in `packages/code/package.json` and `bun.lock`. Its upstream MIT license is
preserved here so the notice travels with the compiled UI even when the library is not an external
package in the portable runtime closure. Source: [Croner](https://github.com/Hexagon/croner).

```text
The MIT License (MIT)

Copyright (c) 2015-2021 Hexagon <github.com/Hexagon>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Packaged JavaScript and native dependencies

The portable packager computes the runtime dependency closure for each target. Every archive contains
a generated `THIRD_PARTY_NOTICES.txt` listing those package names, versions, and declared license
identifiers. Complete license files shipped by those packages remain within their respective
`node_modules` directories.

Because the closure can differ by target and dependency version, the generated archive inventory is
the authority for a particular portable binary. Review it together with this static notice before
publishing.

The isolated-runtime carrier preserves every license, licence, copying, and notice file found in the
frozen build install under `/licenses/npm`, retaining each package-relative path. This set is
deliberately conservative: it covers the complete build install rather than guessing which legal
notices a standalone compiler retained. `runtime-release.json` binds the carrier to the exact source
commit and root lockfile history; review that preserved set together with this notice before
publishing the OCI artifact.
