# Contributing to Clarvis

Thank you for helping improve Clarvis. This guide covers the human-facing contribution workflow;
[`AGENTS.md`](AGENTS.md) is the repository-wide operating contract for both human and AI coding
agents.

## Before opening a change

- Search the [issue tracker](https://github.com/getclarvis/clarvis/issues) for existing work.
- Open a feature issue to discuss a substantial behavior, dependency, persistence, or architecture
  change before investing in an implementation.
- Never include provider keys, subscription tokens, private prompts, raw diagnostic bundles, or
  proprietary repository content in an issue or pull request.
- Read the README of every package you may change, then use [`specs/README.md`](specs/README.md) to
  find the authoritative contract and [`specs/known-issues.md`](specs/known-issues.md) to avoid
  misdiagnosing a known environmental failure.
- Public product guides and the site deployment live in
  [`getclarvis/docs`](https://github.com/getclarvis/docs), not in this monorepo.

## Development setup

Clarvis development requires Git and Bun exactly `1.4.0`. The version is pinned in `mise.toml`; using
[mise](https://mise.jdx.dev/) is the simplest way to install it. `rg` is recommended for navigating
the monorepo.

```bash
git clone https://github.com/getclarvis/clarvis.git
cd clarvis
mise install
./dev-install.sh
```

The development installer performs the frozen dependency install, configures `.githooks`, and
creates a managed `clarvis-develop` launcher in
`${CLARVIS_DEV_BIN_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}`. It records this checkout and Bun binary,
so the command can be run from another project's directory while loading the current Clarvis
TypeScript sources instead of a release or stale bundle:

```bash
cd /path/to/project-under-test
clarvis-develop
```

Re-run `./dev-install.sh` after moving the checkout or changing Bun installations. It updates only a
launcher carrying its ownership marker and refuses an unrelated file with the same name.
`./dev-install.sh --uninstall` removes that launcher. `clarvis-develop --empty-workspace` creates a
new empty `/tmp/clarvis-development-temp/workspace-*` directory and starts the app there.
`clarvis-develop --clear` permanently deletes the effective global state (`$CLARVIS_HOME`, or
`~/.clarvis`) and the complete authenticated temporary-workspace root, then exits. Combine
`--clear --empty-workspace` to clean first and start in a newly allocated workspace. Cleanup refuses
a global target outside the user home, the home itself, a symlink, or a non-directory, and never
removes another workspace's `.clarvis` tree. The temporary root also requires its installer marker
and current-user ownership before removal.

Confirm that the repository hook is active:

```bash
git config --local --get core.hooksPath
```

It must print `.githooks`.

## Branch workflow

The default branch, `develop`, integrates completed work for the next release. Outside an
authorized release in progress, `main` points to the exact source commit of the latest published
release tag. Immutable signed tags preserve every published version. Documentation and CI changes
follow the same task-branch flow as code changes. Both branches require pull requests, passing CI, an up-to-date base, and resolved
review conversations. Direct pushes, force pushes, and deletion are blocked without bypass actors.
The single-maintainer workflow does not require another person's approving review.

Start each ordinary task from an updated `develop` in a short-lived branch:

```bash
git fetch origin
git switch develop
git pull --ff-only origin develop
git switch -c feat/short-description
```

Check `git status --short` before switching branches and preserve any existing work. When pushing
a task branch, explicitly name that branch and set its upstream to the same remote branch; do not
reuse an inherited `origin/develop` upstream.

For an existing clone without a local `develop`, first use `git switch --track origin/develop`.
Use `fix/`, `refactor/`, `docs/`, or `chore/` for the corresponding task, and open its PR against
`develop`. Squash merging is suitable for one bounded task; a merge commit is also allowed.

Promotions into `main` and synchronization back into `develop` use merge commits to retain shared
ancestry. Do not squash or rebase those PRs. A `release/<major.minor.patch>` branch stabilizes each version while `develop` advances.
Prepare and commit its final product version before the first push. Open its PR into `main` to start candidates. Every new commit while that PR is open gets
the next signed source-candidate tag (`v0.2.0-rc.1`, `v0.2.0-rc.2`, and so on); retries reuse the
same commit tag. Candidates publish qualified runtime images and a source-repository prerelease; they do not publish stable installers. Use `hotfix/<version>` from the latest published tag for an urgent
patch, target `main`, and include only the patch and its release preparation. Hotfixes must also reach
`develop` and any active release branch. Follow [RELEASING.md](RELEASING.md) for version preparation,
qualification, and explicitly authorized publication. Merging a release-branch PR into `main`
starts final publication automatically after CI passes on that exact merge commit. Stage hotfixes
on `release/<patch-version>` before promotion; ordinary task PRs never start publication.

## Make a focused change

1. Start a task branch from current `develop` and check `git status --short` before editing.
2. Keep the change bounded. Do not reformat or repair unrelated code in the same pull request.
3. Add or update tests at the appropriate level: unit, component, contract, integration,
   architecture, or end-to-end.
4. Update the owning package README and specification in the same iteration whenever public
   behavior, configuration, formats, failure handling, ownership, dependencies, or invariants
   change.
5. Re-read the owning docs even when no documentation edit appears necessary, and explain that
   disposition in the pull request.

Public APIs and non-obvious contracts use TSDoc. Source files use their real TypeScript extension in
relative imports. Diagnostics go through the shared logger and must not contain secrets.

## Validate locally

Run the smallest checks that cover the change while iterating. Common examples:

```bash
bun --filter @clarvis/code build
bun --filter @clarvis/code typecheck
bun --filter @clarvis/code test
bun run check:specs
bun run check:graph
```

Use `bun run test`, not a raw root `bun test`, for the supported complete suite. Markdown changes run
`bun run check:specs`; package or dependency-edge changes also run `bun run check:graph`.

Interactive Code changes must be exercised in a real PTY. Build the current artifact first, run
`bun run smoke`, and include a screenshot or concise interaction record when a visual behavior
changed.

The installed Git hook owns the complete pre-commit gate. Do not bypass it with `--no-verify`.

## Open a pull request

Complete the pull-request template with:

- the user-visible outcome and linked issue;
- the package README and specs reviewed, including docs that needed no change;
- exact commands and results from validation;
- screenshots or terminal captures for visible TUI changes;
- platforms actually tested and any unverified platform-specific behavior;
- remaining risks, known issues, or intentional follow-up decisions.

If AI materially assisted the change, disclose the tool and the parts you personally reviewed. The
author remains responsible for correctness, licensing, security, tests, and every submitted line.

By contributing, you agree that your contribution is provided under the repository's
[MIT License](LICENSE).
