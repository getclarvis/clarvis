# Candidate and publication evidence

Read only the section for the selected channel. [RELEASING.md](../../../../RELEASING.md) owns the
release sequence and [AGENTS.md](../../../../AGENTS.md#publication-authorization) owns authorization.
Do not create tags, prepare versions, push branches or publish as a side effect of verification.

## Source candidates

An RC labels a source snapshot with `v<prepared-version>-rc.<number>`; the manifest keeps the
prepared final version. Candidates publish a source prerelease in `getclarvis/clarvis` and do not
publish stable installers. Inspect [candidate.yml](../../../../.github/workflows/candidate.yml)
and `candidateIdentity` in [candidate.ts](../../../../tooling/release/candidate.ts).

1. Resolve the supplied tag to its exact commit and verify its signed identity using the repository's
   signing policy. For an untagged candidate proposal, record that tag/signature evidence is not yet
   available rather than inventing an RC number. Do not mutate a dirty worktree to inspect a tag;
   use read-only Git objects or an isolated checkout when execution needs that source.
2. On the exact selected source, the nonpublishing identity command is:

   ```bash
   GITHUB_REF_NAME="$candidate_tag" GITHUB_SHA="$candidate_commit" GITHUB_REPOSITORY=getclarvis/clarvis bun run tooling/release/candidate.ts validate
   ```

   `candidate_tag` and `candidate_commit` must be the verified inputs, not ambient CI values or an
   unrelated HEAD. This validates tag/version/repository/SHA shape and consistency; it does not
   cryptographically verify a tag, prove cleanliness or establish remote publication.

3. Run `check:release` and enclosing local gates with `RELEASE_TAG` explicitly unset. The stable
   checker rejects any value other than `v<root version>`; changing it to accept an RC merely to
   pass would conflate channels. Do not invoke `candidate.ts publish` during validation.
4. For an already published candidate, compare the source prerelease's tag and
   `source-candidate.json` with the verified commit/version/repository. A local manifest alone is
   not remote evidence. Source-install qualification, when requested, uses a disposable checkout
   and launcher through the current candidate installer contract, not a stable portable archive.

## Stable artifacts and publication

The final source tag is `v<root version>` in `getclarvis/clarvis`; distribution assets are published
in `getclarvis/clarvis-releases`. A draft or RC is not a stable publication. A local preflight may
qualify a proposed final tag string without proving that the tag exists remotely.

For an authorized publication workflow, follow the runbook's sequence and inspect existing remote
state before retrying. A release-branch merge starts asynchronous tag/build/publication work;
successful merge alone does not complete the outcome. If the final tag exists but downstream
publication failed, inspect the failed run and retry only the relevant authorized stage. Do not
move/recreate the tag, assume tag creation emits another push event, or assemble partial assets
manually under the same version.

When publication verification is requested:

- Compare the signed source tag's peeled commit, the distribution release's disclosed source
  identity, and the intended release commit. At completion of the current promotion, verify remote
  `main` matches too; for an older release, use that release's lineage rather than today's `main`.
- Confirm the distribution release is public and not a draft/prerelease. Derive required assets
  from current release contracts/tooling for that version, check the complete set, manifest target
  identities, checksums, notices and map-free constraints. Match CI runs to the exact source/artifact.
- Separate metadata inspection, downloaded-byte verification, native install/boot evidence and
  real-account canaries. Do not claim the latter from filenames or green upload jobs. Execute
  requested install checks only in disposable roots and record platform gaps.
- Report source/develop synchronization and public-site version propagation when they are required
  by the requested release outcome. A verification request does not authorize merges or site edits;
  perform them only under existing publication authorization. Preserve their pending status otherwise.

Remote access failures leave publication unverified; local tags and manifests cannot fill that gap.
Use [doc-health's release records](../../clarvis-doc-health/references/release-records.md) to keep
changelog and known-issues language aligned with the observed state without rewriting release history.
