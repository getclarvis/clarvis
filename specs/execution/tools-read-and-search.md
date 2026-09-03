# Reading, listing, globbing, grepping and diffing a workspace

> Implemented at `packages/tools/src/**` and `packages/tools/tests/**`. Every claim below is
> anchored to a file and line. Open questions are collected in the final section.

## 1. Purpose

`@clarvis/tools` ships nine model-facing tools that **observe** a workspace without changing it —
`read_file`, `read_image`, `read_files`, `list_dir`, `glob`, `grep`, `diff`, `file_stat`, `tree` — plus
the library those tools and their mutating siblings share. Each is declared in one table with a
`readOnly` bit (`packages/tools/src/tools/registry.ts:42-67`), and the read-only surface is *derived*
from that bit rather than maintained separately (`packages/tools/src/tools/registry.ts:73-81`).

The problem the subsystem solves is bounded, confined observation. Every answer a tool returns is
bounded in bytes, in files touched, in directory entries retained, and — for the in-process regex
scanner — in regular-expression CPU time. When confinement is enabled, every path is proven to stay
under the workspace or an explicitly configured temporary root; `read_file` and `read_files`
also admit the machine-local state root so the model can read a spill it was handed
(`packages/tools/src/lib/paths.ts:53-62`, `packages/tools/src/config.ts:89-101`). Content reads routed
through `readRawFile` re-establish that proof against the *open descriptor* rather than trusting only
the pathname (`packages/tools/src/lib/files.ts:121-153`, `:226-278`).

The subsystem also owns a **ripgrep-parity contract**: `grep` has two engines — an out-of-process `rg`
child and an in-process JavaScript scanner — and a conformance suite asserts they produce the same
tool output for the same request (`packages/tools/tests/contract/grep-parity.test.ts`). Which engine
runs is decided by confinement, not by preference: a confined *directory* search always takes the
in-process path (`packages/tools/src/lib/rg.ts:164`).

Dispatch, argument validation, guard gating, the `RuntimeConfig` shape and its limit resolution belong
to **tools-contract-and-dispatch**; mutation (`write_file`, `edit_file`, `multi_edit`, `apply_patch`,
`replace`, `move`, `copy`, `mkdir`, `remove`) belongs to **tools-mutation-and-patching**; how an image
part reaches a model belongs to **vision-prepass-and-image-routing**.

## 2. Surface

### 2.1 The nine read-only tools

| Tool | `bounded`? | Required args | Optional args (schema default) | Source |
| --- | --- | --- | --- | --- |
| `read_file` | yes (`:40`) | `path` | `offset` (1), `limit` (2000) | `packages/tools/src/tools/read-file.ts:31` |
| `read_image` | no | `path` | — | `packages/tools/src/tools/read-image.ts:22` |
| `read_files` | yes (`:36`) | `paths` (array, 1..64) | — | `packages/tools/src/tools/read-files.ts:62` |
| `list_dir` | no | — | `path` (`"."`) | `packages/tools/src/tools/list-dir.ts:24` |
| `glob` | no | `pattern` | `path` (`"."`), `respect_gitignore` (`true`) | `packages/tools/src/tools/glob.ts:26` |
| `grep` | yes (`:64`) | `pattern` | `path`, `glob`, `output_mode` (`files_with_matches`), `ignore_case` (`false`), `multiline` (`false`), `context` (0), `before_context`, `after_context`, `head_limit`, `offset` (0) | `packages/tools/src/tools/grep.ts:54` |
| `diff` | no | `from`, `to` | — | `packages/tools/src/tools/diff.ts:21` |
| `file_stat` | no | `path` | — | `packages/tools/src/tools/file-stat.ts:34` |
| `tree` | no | — | `path` (`"."`), `depth` (0 → 4), `respect_gitignore` (`true`) | `packages/tools/src/tools/tree.ts:193` |

`bounded: true` tells the dispatcher not to re-clamp the handler's text
(`packages/tools/src/tools/types.ts:43`, applied at `packages/tools/src/core.ts:79-85`). The other six
are re-clamped to `config.maxOutputBytes` on the way out.

Schema defaults are materialised by Ajv with `useDefaults: true` before the handler runs
(`packages/tools/src/core.ts:49`), which is why each handler reads e.g. `args.respect_gitignore` as a
plain `boolean` (`packages/tools/src/tools/glob.ts:67`).

### 2.2 The supporting library (package-internal)

None of these are re-exported from `packages/tools/src/index.ts`; they are internal to the package and
reachable only by deep path (which is what tests do).

| Symbol | Signature / kind | Source |
| --- | --- | --- |
| `grepSearch(params, config): Promise<GrepResult>` | the two-engine grep driver | `packages/tools/src/lib/rg.ts:132` |
| `GrepParams` / `Match` / `GrepResult` | request, one emitted row, and result+three flags (`truncated`, `budgetExhausted`, `walkCapped`) | `packages/tools/src/lib/rg.ts:14`, `:34`, `:56` |
| `loadIgnore(workspaceRoot): Matcher` | composed gitignore semantics | `packages/tools/src/lib/ignore.ts:125` |
| `MAX_IGNORE_FILE_BYTES` | `1024 * 1024` | `packages/tools/src/lib/ignore.ts:12` |
| `listFiles(base, workspaceRoot, opts): Promise<FileListing>` | bounded glob walk | `packages/tools/src/lib/files.ts:317` |
| `createGlobTool(listFilesImpl = listFiles): ToolDef` / `globTool` | DI factory for the `glob` handler, and the default instance built from it | `packages/tools/src/tools/glob.ts:26`, `:113` |
| `readRawFile(target, relForError, maxBytes, limitHint?, options?)` | descriptor-bounded byte read | `packages/tools/src/lib/files.ts:217` |
| `readFileOptions(config, alsoAllow?)` | derives post-open confinement policy | `packages/tools/src/lib/files.ts:47` |
| `openReadHandle(target, noFollow?)` | non-blocking (`O_NONBLOCK`), optionally `O_NOFOLLOW`, open | `packages/tools/src/lib/files.ts:67` |
| `statDirectory(absPath, relForError)` | stat + assert directory | `packages/tools/src/lib/files.ts:182` |
| `mapLimit(items, limit, fn)` / `STAT_CONCURRENCY = 32` | order-preserving bounded fan-out | `packages/tools/src/lib/files.ts:282`, `:17` |
| `readTextFile` / `readTextBuffer` | throwing vs. best-effort text read | `packages/tools/src/lib/textfile.ts:38`, `:62` |
| `isBinary` / `isUtf16Bom`, `SCAN_BYTES = 8000` | NUL heuristic and BOM recogniser | `packages/tools/src/lib/binary.ts:14`, `:35`, `:2` |
| `decodeText` / `splitLines` / `countNewlines` | decoding and line arithmetic | `packages/tools/src/lib/text.ts:47`, `:115`, `:127` |
| `renderNumberedSlice(lines, start, hardEnd, maxBytes)`; `MAX_LINE = 2000` | `cat -n` rendering under a byte budget | `packages/tools/src/lib/render-lines.ts:39`, `:1` |
| `createScanBudget(budgetMs): ScanBudget` | regex-time allowance | `packages/tools/src/lib/scan-budget.ts:60` |
| `unifiedDiff(rel, before, after, maxInputBytes?)`; `DEFAULT_DIFF_TIMEOUT_MS = 2000` | unified patch | `packages/tools/src/lib/unified-diff.ts:21`, `:5` |
| `sniffImageMime(buf): string \| null` | magic-byte image detection | `packages/tools/src/lib/image.ts:10` |
| `findCascadeMatch(text, oldString)` / `scanLineBlocks` / `trimEnds` | four-tier fuzzy block locator | `packages/tools/src/lib/match-cascade.ts:191`, `:54`, `:17` |
| `resolvePath` / `displayPath` / `assertWithinWorkspace` | path resolution and confinement | `packages/tools/src/lib/paths.ts:27`, `:51`, `:133` |
| `bound(text, maxBytes)` | head truncation with a marker | `packages/tools/src/lib/output.ts:50` |

`match-cascade.ts` has **no consumer among the read tools** — its only production importer is
`edit_file` (`packages/tools/src/tools/edit-file.ts:7`), which belongs to
**tools-mutation-and-patching**. It is inventoried here as library, not as behaviour of this
subsystem. Likewise `unifiedDiff` is used by `write_file` and `replace`
(`packages/tools/src/tools/write-file.ts:7`, `packages/tools/src/tools/replace.ts:7`); the `diff` tool
imports only the timeout constant from it and calls `createTwoFilesPatch` directly
(`packages/tools/src/tools/diff.ts:1`, `:7`, `:80`).

### 2.3 Config keys this subsystem reads

Resolution and validation belong to tools-contract-and-dispatch; the fields consumed here are:

| Key | Default | Where it bites |
| --- | --- | --- |
| `maxOutputBytes` | `131072` (`packages/tools/src/config.ts:138`) | every rendered result; the `rg` stream cap is this × 8 (`packages/tools/src/lib/rg.ts:102`, `:233`) |
| `maxFileBytes` | `20_000_000` (`packages/tools/src/config.ts:142`) | every text/raw read; also passed to `rg --max-filesize` (`packages/tools/src/lib/rg.ts:203`) |
| `maxImageBytes` | `5_000_000` (`packages/tools/src/config.ts:144`) | `read_image` only (`packages/tools/src/tools/read-image.ts:52`) |
| `maxTraversalEntries` | `50_000` (`packages/tools/src/config.ts:146`) | `list_dir`, `glob`, `tree`, and the grep file walk |
| `maxDiffInputBytes` | `8 * 1024 * 1024` (`packages/tools/src/config.ts:150`) | `diff` combined operand size (`packages/tools/src/tools/diff.ts:70`) |
| `regexScanBudgetMs` | `5000` (`packages/tools/src/config.ts:171`) | in-process grep only (`packages/tools/src/lib/rg.ts:374`) |
| `ripgrepAvailable` | probed by `rg --version` (`packages/tools/src/config.ts:187-194`) | grep engine choice (`packages/tools/src/lib/rg.ts:164`) |
| `confineToWorkspace` | `true` (`packages/tools/src/config.ts:353`) | path confinement **and** grep engine choice |
| `stateRoot` | `workspaceStatePaths(workspaceRoot).root` (`packages/tools/src/config.ts:503`) | extra read root, passed by `read_file`/`read_files` only |
| `temporaryRoots` | `[]` (`resolveConfig`) | extra confined roots admitted by all nine tools; the product loop pre-seeds run scratch plus host system temp roots, and the list may grow after a verified shell-created `mktemp -d` |
| `readOnly` | `false` (`packages/tools/src/config.ts:352`) | selects the nine-tool surface (`packages/tools/src/core.ts:233`) |

## 3. Data and formats

Nothing in this subsystem persists state. Everything below is the *wire text* a tool returns.

### 3.1 `read_file` / `read_files` rendering

Each row is a six-wide right-padded 1-based line number, a tab, then the content
(`packages/tools/src/lib/render-lines.ts:56`). Real output, pinned:

```
     1	alpha
     2	beta
     3	gamma
```
(`packages/tools/tests/integration/read-file.test.ts:82`)

Sentinels and footers:

| Condition | Emitted text | Source |
| --- | --- | --- |
| zero-byte file | `(empty file)` | `packages/tools/src/tools/read-file.ts:86` |
| more lines remain | `[... 2 of 5 lines shown; continue with offset=4 ...]` | `packages/tools/src/tools/read-file.ts:117`, pinned at `packages/tools/tests/integration/read-file.test.ts:89` |
| single line over `MAX_LINE` (2000 chars) | ` [... line truncated ...]` appended | `packages/tools/src/lib/render-lines.ts:2`, `:54` |
| `read_files` per-file header | `==> a.txt <==` | `packages/tools/src/tools/read-files.ts:121` |
| `read_files` per-entry failure | `==> ../secret — path_escape: … <==` | `packages/tools/src/tools/read-files.ts:146-149`, pinned at `packages/tools/tests/integration/read-files.test.ts:61` |
| `read_files` file cut by shared budget | `[... N of M lines shown; use read_file for the rest ...]` | `packages/tools/src/tools/read-files.ts:32`, appended at `:142` |
| `read_files` budget spent | `[... N more file(s) not shown; call read_files with fewer paths ...]` | `packages/tools/src/tools/read-files.ts:20`, appended at `:156` |

Sections in `read_files` are joined by a blank line (`packages/tools/src/tools/read-files.ts:158`).
Both notices, and the marker `bound` appends past its own ceiling, are **reserved out of the budget
before** the section that may be the last one is filled (`:94`-`:102`, `:126`-`:130`) — the tool is
`bounded: true`, so nothing downstream would correct an overrun.

### 3.2 `list_dir` and `tree`

`list_dir` renders a directory as `name/` and a file as `name<TAB>size`, directories first then
name-ascending (`packages/tools/src/tools/list-dir.ts:88-96`). Pinned example:

```
sub/
.hidden	1
a.txt	2
b.txt	3
```
(`packages/tools/tests/integration/list-dir.test.ts:32`)

`tree` prints the root's display path, then box-drawing rows with `├── `/`└── ` connectors and
`│   `/`    ` continuation padding (`packages/tools/src/tools/tree.ts:148`, `:164`). A symlink renders
as `name@` (`packages/tools/src/tools/tree.ts:90`). Pinned example:

```
.
├── src/
│   └── a.ts	2
└── b.txt	1
```
(`packages/tools/tests/integration/tree.test.ts:31`)

Sentinels: `(empty directory)` (`packages/tools/src/tools/list-dir.ts:93`), `(no entries)`
(`packages/tools/src/tools/tree.ts:247`), and three distinct truncation footers —
`[listing incomplete: stopped at N entries]` (`packages/tools/src/tools/list-dir.ts:98`),
`[tree incomplete: stopped at N entries or M output bytes]` (`packages/tools/src/tools/tree.ts:250`),
`[tree incomplete: a directory held more than N entries and was listed in part]`
(`packages/tools/src/tools/tree.ts:254`).

### 3.3 `glob`

One workspace-relative path per line, newest `mtime` first, ties broken by ascending path
(`packages/tools/src/tools/glob.ts:100`). `(no matches)` on an empty result — a *success*
(`packages/tools/src/tools/glob.ts:98`; `packages/tools/tests/integration/glob.test.ts:68-73`).
Truncation footer: `[search incomplete: traversal stopped at N entries]`
(`packages/tools/src/tools/glob.ts:103`).

### 3.4 `grep`

Three renderings selected by `output_mode`:

| Mode | Row shape | Unit for pagination | Source |
| --- | --- | --- | --- |
| `files_with_matches` (default) | `path` | one file | `packages/tools/src/tools/grep.ts:240-250` |
| `count` | `path:count` | one file | `packages/tools/src/tools/grep.ts:252-264` |
| `content` | `path:line:text` for a match, `path-line-text` for a context line | one match anchor | `packages/tools/src/tools/grep.ts:309-310` |

`content` mode inserts a bare `--` between non-adjacent context blocks, but only when context was
requested (`packages/tools/src/tools/grep.ts:300-308`). Pinned rendering:

```
a.txt-1-pre
a.txt:2:MATCH
a.txt-3-post
--
b.txt-1-before
b.txt:2:MATCH
b.txt-3-after
```
(`packages/tools/tests/integration/grep.test.ts:262-272`)

Footers, mutually exclusive, in the order `composeResult` tests them
(`packages/tools/src/tools/grep.ts:336-382`):

| Condition | Footer |
| --- | --- |
| `truncated && budgetExhausted` | `[... search incomplete: the pattern exhausted the regex time budget … Nested quantifiers such as \`(a+)+\` … ...]` (`:346`) |
| `truncated && walkCapped` | `[... search incomplete: the directory walk hit its entry cap, so whole files were never opened. Narrowing the pattern will not help … ...]` (`:351-353`) |
| `truncated` (output cap) | `[... search incomplete: the scan hit its output cap; some matching files were not scanned. …]` (`:354-355`) |
| `offset >= unitTotal` | `(no results at offset 50; 1 total)` (`:357`; pinned `packages/tools/tests/integration/grep.test.ts:418`) |
| page bytes > `maxOutputBytes` | `[... page exceeded 300 bytes and was cut; set or reduce head_limit …]` (`:361`) |
| more units remain | `[... showing 0..2 of 5; call again with offset=2 for more ...]` (`:366`) |
| nothing matched | `(no matches)` (`:230`) |

### 3.5 `file_stat`

A JSON string, not prose. Four shapes, decided by `lstat` then by the opened descriptor:

```json
{"path":"a.txt","type":"file","size":5,"mtime":"…","mode":"0644","binary":false,"mime":null}
{"path":"link.txt","type":"symlink","size":…,"mtime":"…","mode":"…","symlink_target":"…/real.txt"}
{"path":"d","type":"directory","size":…,"mtime":"…","mode":"…"}
{"path":"s.sock","type":"other","size":…,"mtime":"…","mode":"…"}
```
(`packages/tools/src/tools/file-stat.ts:80-96`, `:132-140`; pinned in
`packages/tools/tests/integration/file-stat.test.ts` by "reports a regular text file",
"reports the descriptor type when a regular pathname changes during open", "reports a symlink
without following it", and "reports a non-regular file (socket) as type other".) `mode` is
`"0"` + three octal digits of `mode & 0o777` (`packages/tools/src/tools/file-stat.ts:11-13`); `mtime`
is ISO-8601 (`:70`).

### 3.6 `diff`

`createTwoFilesPatch` with 3 lines of context and the two workspace-relative display paths as labels
(`packages/tools/src/tools/diff.ts:78-91`); `(no differences)` when the *decoded* contents are equal
(`:66`).

### 3.7 `read_image`

A single base64 `ImagePart` carrying the sniffed MIME type
(`packages/tools/src/tools/read-image.ts:64`, part shape at
`packages/tools/src/tools/content.ts:9-13`). Its flattened text is the empty string
(`packages/tools/src/tools/content.ts:58`; pinned at
`packages/tools/tests/integration/read-image.test.ts:34-38`).

### 3.8 `rg --json` events consumed

Only `type: "match"` and `type: "context"` lines are kept; anything else, and any line that fails to
`JSON.parse`, is skipped (`packages/tools/src/lib/rg.ts:327-336`). From each, `data.path.text`,
`data.line_number` and `data.lines.text` are read, with a trailing `\r?\n` stripped
(`packages/tools/src/lib/rg.ts:337-344`, `:549-551`). An event missing `path.text` or `line_number` is
dropped (`:307`) — which is how a non-UTF-8 filename disappears from the result
(`packages/tools/tests/integration/rg.test.ts:111-121`), and a non-UTF-8 *line* yields an empty `text`
(`packages/tools/tests/integration/rg.test.ts:95-109`).

## 4. Behavior

### 4.1 The shared prologue every read tool runs

1. `resolvePath(input, workspaceRoot, confineToWorkspace, alsoAllow, logger)` normalises the argument
   (absolute kept, relative joined to the root) and, when confined, calls `assertWithinWorkspace`
   (`packages/tools/src/lib/paths.ts:34-36`).
2. `assertWithinWorkspace` canonicalises *both* sides through `canonicalizeAllowingMissing`, folds
   case on Windows only, and accepts on equality or on a `root + path.sep` prefix
   (`packages/tools/src/lib/paths.ts:141-149`). The trailing separator is what stops `C:\Projects\x`
   passing as a child of `C:\Proj` (`:101-103`).
3. `canonicalizeAllowingMissing` walks up until `realpathSync.native` succeeds, then re-appends the
   unresolved tail; if a *skipped* segment is itself a symlink it returns `undefined` and the caller
   refuses (`packages/tools/src/lib/paths.ts:248-260`).
4. On refusal a `debug` record `tools.path_refused` is emitted with `input`, `reason`
   (`unresolvable` | `outside_root`) and `allow_roots_count`, then a `path_escape` `ToolError` is
   thrown (`packages/tools/src/lib/paths.ts:151-166`).

Every read tool passes `config.temporaryRoots` to `resolvePath`; `read_file` and `read_files` add
`config.stateRoot` as their one extra allowance
(`packages/tools/src/tools/read-file.ts:67-71`, `packages/tools/src/tools/read-files.ts:106-110`).
Content readers also feed the same temporary roots into the descriptor-time policy through
`readFileOptions`; the two spill readers again add `stateRoot`
(`packages/tools/src/lib/files.ts`, `packages/tools/src/tools/read-file.ts`,
`packages/tools/src/tools/read-files.ts`). This admits only the configured roots. A standalone caller
that supplies one exact run root still refuses its parent; the product loop deliberately also
configures the environment-selected system temp and POSIX `/tmp`, allowing host-native temp output
without learning a path from an earlier result (`packages/tools/tests/integration/api.test.ts`,
"lets native tools read scratch created by shell inside the run-owned temporary root" and "reuses a
bare mktemp result from the host temp root in a later native tool").

### 4.2 `readRawFile` — the descriptor-bound read

Order matters and is explicit in the code
(`packages/tools/src/lib/files.ts:217-269`):

| Step | Call | Failure |
| --- | --- | --- |
| 1 | `openReadHandle(target, noFollow)` — `O_RDONLY\|O_NONBLOCK` on POSIX, `"r"` on Windows (`:67-74`) | `fsError` |
| 2 | `handle.stat()`; refuse a non-regular file (`:235-236`) | `not_a_file` |
| 3 | if confinement is on, `assertOpenedFileConfined` (`:237-239`) | `path_escape` |
| 4 | size vs `maxBytes` (`:240-242`) | `too_large` |
| 5 | `readHandleBounded(handle, maxBytes)` — reads at most `maxBytes + 1` from the descriptor cursor (`:155-170`) | — |
| 6 | if more than `maxBytes` came back, re-`stat` the descriptor and report the larger figure (`:245-249`) | `too_large` |
| 7 | close; a close error is surfaced only when nothing failed earlier (`:255-262`) | — |

`assertOpenedFileConfined` re-`realpath`s the target, stats the *open handle* with `bigint: true`,
stats the canonical path, asserts containment, then compares `dev`/`ino`; a mismatch is
`path_escape` with the message "Path changed while it was being opened"
(`packages/tools/src/lib/files.ts:112-144`).

Step 5's extra byte and step 6's re-stat are pinned directly:
`readRawFile` requests exactly `[9]` bytes for `maxBytes = 8`, stats twice, closes once, and reports
`size: 32` from the second stat (`packages/tools/tests/integration/bounded-read.test.ts:36-49`).

`readTextFile` layers a binary rejection on top: a UTF-16 BOM exempts the buffer, otherwise a NUL
anywhere in the scan windows is `is_binary` (`packages/tools/src/lib/textfile.ts:16-23`, `:44-46`).
`readTextBuffer` is the best-effort twin — every failure collapses to `null` **except** `path_escape`,
which is re-thrown (`packages/tools/src/lib/textfile.ts:62-75`).

### 4.3 `read_file`

`packages/tools/src/tools/read-file.ts:65-121`, in order:

1. resolve + `readTextFile` (`:67`, `:78`).
2. empty content → `(empty file)` (`:86`).
3. `splitLines` → `total` (`:87-88`).
4. `offset === 0` → `invalid_input` (`:90-96`).
5. `offset < 0` → `start1 = max(1, total + offset + 1)`, i.e. clamped to the first line
   (`:98-99`; pinned `packages/tools/tests/integration/read-file.test.ts:165-169`).
6. `offset > total` → `invalid_input` carrying `line_count` (`:101-107`).
7. `hardEnd = min(total, start + limit)`; `renderNumberedSlice` may stop earlier on bytes (`:112-113`).
8. footer when `end < total` (`:116-119`).

`limit` itself is defaulted with the same falsy-OR fallback as `offset`'s sibling in `grep`'s
`head_limit`: `const limit = (args.limit as number | undefined) || DEFAULT_LIMIT;` (`:75`). An explicit
`limit: 0` is therefore coerced to the default 2000-line window rather than returning zero lines. Unlike
`grep`'s `head_limit: 0` case, no test in `packages/tools/tests` exercises `read_file`'s `limit: 0` (§8
item 13).

`renderNumberedSlice` always emits the `start` row even if it alone exceeds the budget (`i > start` in
the break test, `packages/tools/src/lib/render-lines.ts:60`), byte-caps each individual row on a UTF-8
boundary (`:57`, `:4-11`), and clips a >2000-char line without splitting a surrogate pair
(`:50-55`; pinned `packages/tools/tests/unit/render-lines.test.ts:43-49`).

### 4.4 `read_files`

Sequential over `paths`, sharing one `remaining = config.maxOutputBytes` budget
(`packages/tools/src/tools/read-files.ts:86-158`):

| Event | Effect |
| --- | --- |
| no room left for a section plus the notices it may need | record `stoppedAt = idx`, break (`:98-102`, `:131-134`) |
| entry throws a `ToolError` | render `==> <path> — <code>: <message> <==`, capped, and continue (`:144-149`) |
| entry throws anything else | rethrow, failing the whole call (`:145`) |
| entry read fits | header + numbered body; if `byteCapped`, append the `use read_file for the rest` note (`:121-142`) |
| after each entry | `remaining -= byteLength(section) + 2` (`:153`) |
| `stoppedAt >= 0` | append the `N more file(s) not shown` line, whose bytes the loop already held back (`:156`) |

### 4.5 `list_dir`

`statDirectory` first (`packages/tools/src/tools/list-dir.ts:52`), then `opendir` with a hard stop at
`maxTraversalEntries` retained dirents (`:57-68`), then a bounded `stat` fan-out at
`STAT_CONCURRENCY = 32` (`:73-86`). A `stat` failure demotes the entry to a non-directory of size 0
(`:81-83`) — which is how a broken symlink renders as `zlink\t0`
(`packages/tools/tests/integration/list-dir.test.ts:66-73`). A symlink *to* a directory is followed
for classification and therefore renders as a directory
(`packages/tools/src/tools/list-dir.ts:76-80`;
`packages/tools/tests/integration/list-dir.test.ts:58-64`). Dotfiles are included and `.gitignore`
is not consulted at all (`packages/tools/src/tools/list-dir.ts:19-20` and the absence of any
`loadIgnore` import in that file).

### 4.6 `glob`

1. resolve base, `statDirectory` (`packages/tools/src/tools/glob.ts:60-69`).
2. `listFiles(base, workspaceRoot, { pattern, respectGitignore, maxEntries })`; any throw becomes
   `invalid_input` naming the pattern (`:74-85`).
3. `mapLimit` stat fan-out; an entry that fails to stat between enumeration and sorting is silently
   dropped (`:87-93`), which is exactly the case where `glob` legitimately returns `(no matches)`
   (`packages/tools/tests/integration/glob.test.ts:86-99`).
4. sort newest-first, tie-break ascending path (`:100`).

`listFiles` itself (`packages/tools/src/lib/files.ts:317-368`) is an explicit LIFO stack walk:
`picomatch(pattern, { dot: true, windows: false })` matches against the **base**-relative POSIX path
(`:328`, `:361-362`), while the ignore matcher is consulted on the **workspace**-relative path
(`:355`, `:357`, `:362`) — a directory is pruned by testing `workspaceRel + path.sep` (`:357`). The
counter `visited` increments per *dirent*, and reaching `maxEntries` sets `truncated` and breaks the
labelled `scan` loop (`:336-339`, `:349-352`). Symlinks are collected as candidate files
(`:360`) but never descended.

### 4.7 `tree`

`walk` is recursive and carries a mutable `budget` with two distinct flags
(`packages/tools/src/tools/tree.ts:131-175`):

| State | Event | Next state | Effect |
| --- | --- | --- | --- |
| walking | a rendered line would push `budget.entries >= maxTraversalEntries` or `budget.bytes + n > maxOutputBytes` | `exhausted` | set `truncated` **and** `exhausted`, return immediately (`:137-144`) |
| walking | `readEntries` reported this level capped | walking | set `truncated` only, keep walking siblings (`:161`) |
| `exhausted` | any further entry or recursion | `exhausted` | return without rendering (`:128`, `:132`) |
| walking | entry is a directory and `depth < maxDepth` | walking (deeper) | recurse with extended prefix (`:148-159`) |
| walking | entry is a symlink | walking | rendered as `name@`, never descended (`:67`, `:90`) |

`readEntries` counts **raw dirents before the ignore matcher runs**
(`packages/tools/src/tools/tree.ts:50-53` vs. the matcher at `:65`), so a directory of ignored build
artifacts reports itself truncated while contributing no rendered line. Promoting that to a global
stop would discard later siblings; the test
`packages/tools/tests/integration/tree.test.ts:146-162` pins that it does not.

Depth: `requestedDepth = args.depth || DEFAULT_TREE_DEPTH` — so `0` and omitted both mean 4 — then
`min(requested, MAX_TREE_DEPTH = 20)` (`packages/tools/src/tools/tree.ts:232-233`, `:95-108`; pinned
`packages/tools/tests/integration/tree.test.ts:95-102`).

### 4.8 `grep` end to end

**Handler-level argument normalization** (`packages/tools/src/tools/grep.ts:156-161`), run before engine
selection:

- `context`/`before_context`/`after_context` are read only when `output_mode === "content"`; in every
  other mode all three are forced to `0` regardless of what was passed (`:150-152`) — a `grep` call in
  `files_with_matches` or `count` mode that also sets `context` silently ignores it.
- Within `content` mode, `context` is a shared default for both sides, and `before_context`/
  `after_context` each independently **override** it on their own side only —
  `before = args.before_context ?? ctx; after = args.after_context ?? ctx` (`:151-152`), pinned by
  "after_context overrides context for the after side (precedence)"
  (`packages/tools/tests/integration/grep.test.ts:323-332`).
- `head_limit: 0` is coerced to "unlimited" by a falsy-OR fallback,
  `(args.head_limit as number | undefined) || undefined` (`:154`) — the same quirk as `read_file`'s
  `limit` (§4.3) — rather than being rejected or treated as "zero results". Pinned by "treats
  head_limit 0 as unlimited (no rejection)" (`packages/tools/tests/integration/grep.test.ts:421-426`).

**Engine selection** (`packages/tools/src/lib/rg.ts:133-181`):

1. `fs.stat(searchRoot)`; failure → `fsError` (`:104-109`).
2. Not a directory and not a regular file → empty result (`:114-117`).
3. A single-file target is pre-read into a `Buffer` via `readRawFile`, and a binary one returns empty
   (`:118-128`). Any other throw returns empty **except** `path_escape`, which propagates (`:129-132`).
4. `useRipgrep = config.ripgrepAvailable && (!isDir || !config.confineToWorkspace)` (`:135`).
5. A `debug` record `tools.grep_path` names the chosen engine (`:136-144`).

| `ripgrepAvailable` | target | `confineToWorkspace` | engine |
| --- | --- | --- | --- |
| false | any | any | in-process |
| true | file | any | ripgrep (stdin snapshot) |
| true | directory | true | **in-process** |
| true | directory | false | ripgrep (child in `cwd = searchRoot`) |

**Ripgrep path** (`packages/tools/src/lib/rg.ts:196-321`): argv is
`--no-config --json --hidden -g !.git --max-filesize <maxFileBytes>`, plus `-i`, `--multiline
--multiline-dotall`, `-B n`, `-A n` as requested, then `-- <pattern> <target>` (`:173-190`). For a
directory the child runs with `cwd = searchRoot` and searches `.` (so the caller's process cwd is
irrelevant — pinned at `packages/tools/tests/contract/grep-parity.test.ts:52-58`, which `chdir`s to
`tmpdir()` first). For a single file the target is `-` and the pre-read snapshot is handed to
`Bun.spawn` as a `Blob` stdin (`:186-189`, `:240-253`), so ripgrep never reopens the pathname. Both
variants abort at `maxOutputBytes * 8` raw JSON bytes, `SIGKILL` the child and set `truncated`
(`:73`, `:204-213`, `:267-279`). Exit code `2` with zero parsed matches and no truncation becomes
`invalid_input` carrying ripgrep's stderr (`:219-226`, `:286-290`); a spawn failure is `io_error`
(`:215`, `:258-262`).

**In-process path** (`packages/tools/src/lib/rg.ts:347-444`):

1. File set: for a directory, `gatherFiles` globs with `respectGitignore: true` and sorts the paths
   (`:500-513`); a bare `glob` without a slash is rewritten to `**/<glob>` (`:502-504`) — the ripgrep
   semantics the tool advertises, pinned at `packages/tools/tests/integration/grep.test.ts:68-74`.
2. Flags: `gms`/`gmsi` when `multiline`, otherwise `i` or `""` (`:329-335`). A pattern JavaScript
   cannot compile is `invalid_input` (`:336-342`).
3. Per file: stop if `truncated`; stop if `scanBudget.exhausted()`, setting **both** `truncated` and
   `budgetExhausted` (`:363-369`). A walk stopped at `maxTraversalEntries` folds into `truncated`
   too, but carries `walkCapped` beside it so the warning can name the right remedy (`:421-426`).
4. Non-multiline: `re.test` once per line, each charged through the budget, with an exhaustion check
   between lines so a scan can stop mid-file (`:372-379`). Context rows are added around hits, never
   overwriting a hit (`:382-392`).
5. Multiline: `emitMultiline` walks `content.matchAll(re)`, ignores zero-length matches (`:439`), maps
   offsets to lines by binary search over newline positions (`:424-433`), coalesces adjacent matched
   lines into runs, and emits a run that contains any genuinely multi-line match as **one** anchor
   spanning `start..end` (`:451-474`). A run of only single-line matches stays one anchor per line
   (`:469-472`) — which is what keeps `count` mode equal to the per-line engine
   (`packages/tools/tests/integration/grep.test.ts:575-583`).
6. `used > budget` after a file sets `truncated` (`:407`), so the *next* file is not scanned.
7. The listing's own truncation is OR-ed in (`:409`).

**Formatting and paging** (`packages/tools/src/tools/grep.ts:232-315`): rows are display-pathed and
sorted by `(file, lineNumber)` (`:277-279`); anchors are the `kind === "match"` rows; `paginate` slices
`[offset, offset + headLimit)` (`:204-207`); each paged-in anchor re-expands its own context window,
with a multiline anchor's `after` measured from `lineNumber + countNewlines(text)` (`:286-289`).

### 4.9 `diff`

Read both operands with `readTextFile` (rejecting binary and oversized), compare the *normalised*
content — so CRLF vs LF is "no differences"
(`packages/tools/src/tools/diff.ts:62-66`;
`packages/tools/tests/integration/diff.test.ts:41-46`) — then check the combined byte size against
`maxDiffInputBytes` before calling `createTwoFilesPatch` (`:68-76`). A `undefined` patch (the library's
timeout signal) becomes `timeout` (`:92-97`).

### 4.10 `file_stat`

`lstat` decides symlink / directory / other first, and a symlink's `readlink` failure degrades to
`symlink_target: null` rather than an error (`packages/tools/src/tools/file-stat.ts:64-88`). For a
regular file the handler opens with `noFollow = true` (`:100`), re-derives `type`/`size`/`mtime`/`mode`
from the **opened descriptor** (`:107-127`), and reads at most `HEAD_BYTES = 8192` from offset 0 to
compute `binary` and `mime` (`:9`, `:129-140`). That is why it works on a file far larger than
`maxFileBytes` (`packages/tools/tests/integration/file-stat.test.ts`, "works on a file larger than
maxFileBytes") and why a pathname race cannot mismatch the metadata and the head (same file,
"reports metadata and content from the same opened file after a pathname race").

### 4.11 `loadIgnore`

Construction (`packages/tools/src/lib/ignore.ts:125-135`): find the ignore root by walking up to the
nearest ancestor holding `.git`, falling back to the workspace itself (`:77-85`); seed a base matcher
with `INTERNAL_IGNORE_PATTERNS` — `[".git", ".clarvis", ".clarvis-tmp-*"]`
(`packages/paths/src/constants.ts:110`); add `.git/info/exclude`; add the global excludes at
`$XDG_CONFIG_HOME/git/ignore` or `~/.config/git/ignore` (`:94-100`).

Query (`:182-200`): empty and `"."` are never ignored; `../` and absolute paths are never ignored; any
path component named `.git` is always ignored (`:188`); otherwise the base decision is folded through
every directory's `.gitignore` from the ignore root down to the path's parent, nearer directories
winning and a negation forcing `false` (`:173-179`, `:190-199`). Per-directory matchers are read and
cached lazily on first query into that directory (`:136-153`).

Every ignore source is read through `readFileSafe` (`:34-68`): a descriptor is opened with
`O_NONBLOCK` (so a FIFO cannot park the synchronous matcher), the descriptor is `fstat`ed, a
non-regular or over-`MAX_IGNORE_FILE_BYTES` source yields `undefined`, and the read stops at the cap.
The boundary is detected the same way `readRawFile` detects it (RS-24): each chunk read requests
`min(READ_CHUNK_BYTES, MAX_IGNORE_FILE_BYTES - total + 1)` — one byte more than the cap allows — so a
source of exactly the cap size is distinguished from one that exceeds it by whether that extra byte
ever arrives (`:49-50`). An existing-but-unreadable `.gitignore` produces one `tools.ignore_unreadable`
warning and is treated as absent (`:144-149`).

### 4.12 `createScanBudget`

`charge(run)` times `run` with `Date.now()` and adds the delta to `spent`; `run` is executed
unconditionally, even after exhaustion, so callers decide what to skip
(`packages/tools/src/lib/scan-budget.ts:60-72`). Nothing outside `charge` is billed — not a `stat`,
not a read, not the directory walk — which is what stops a slow disk from reporting a legitimate scan
as incomplete (`packages/tools/tests/unit/scan-budget.test.ts:28-35`).

## 5. Invariants

Numbering: **RS-n** are derived here; **INV-041** and **INV-300 – INV-302** are the catalog invariants this document owns.

| # | Rule | Production | Pinned by |
| --- | --- | --- | --- |
| **INV-041** | Ripgrep must be installed wherever this suite runs. A missing `rg` is a CI *environment* gap, not a grep-vs-ripgrep behavioural difference: the parity suite `skipIf`s itself away without it, so a missing binary would silently delete the entire parity contract instead of failing it. Under `process.env.CI` the guard asserts `rg` is present. | engine choice at `packages/tools/src/lib/rg.ts:164`; probe at `packages/tools/src/config.ts:187-194` | `packages/tools/tests/contract/grep-parity.test.ts:15` ("ripgrep must be installed in CI (TEST-01)") |
| **RS-1 (INV-300)** | For the same request, the ripgrep engine and the in-process engine return the **same tool output** — across all three output modes, glob forms, regex metacharacters, `ignore_case`, symmetric and asymmetric context, multiline (dot-all, `^`/`$` anchors, coalescing, pagination), `maxFileBytes` skipping, and hidden/`.git`/nested/parent `.gitignore` handling. | `packages/tools/src/lib/rg.ts:174-181` | `packages/tools/tests/contract/grep-parity.test.ts:44-223` |
| **RS-2** (the precondition INV-300 depends on) | A **confined directory** grep never spawns ripgrep, however available `rg` is. (Consequence: the parity suite can only compare the two engines with `confineToWorkspace: false`.) | `packages/tools/src/lib/rg.ts:164` | ~~indirectly — every parity case builds `withRg()` as `{ ripgrepAvailable: true, confineToWorkspace: false }` (`packages/tools/tests/contract/grep-parity.test.ts:40`); no test asserts the refusal directly (**partially unpinned**)~~ **pinned 2026-08-22**: `packages/tools/tests/unit/observability.test.ts` asserts the chosen engine on the `tools.grep_path` diagnostic across all four combinations of `ripgrepAvailable` × `confineToWorkspace`, plus the single-confined-file case where ripgrep *is* used |
| **RS-3** | The read-only tool surface is exactly nine tools, derived from the single `readOnly` bit in `toolDescriptors` — never a second list. | `packages/tools/src/tools/registry.ts:42-81` | `packages/tools/tests/component/tool-surface.test.ts:33`; `packages/tools/tests/component/read-only.test.ts:32-44` |
| **RS-4** | A tool hidden by the read-only surface and a name that never existed fail identically (`not_found`), so the surface leaks no information about what was withheld. | `packages/tools/src/core.ts:233-236` | `packages/tools/tests/component/read-only.test.ts:46-57` |
| **RS-5** | A read-only session leaves the workspace byte-identical. | the nine handlers perform no write syscall | `packages/tools/tests/component/read-only.test.ts:76-86` |
| **RS-6** | The four text read/search tools behave identically under a full and a read-only config. | `packages/tools/src/core.ts:233` (surface only gates *presence*) | `packages/tools/tests/component/read-only.test.ts:59-74` |
| **RS-7** | "No results" is a **success**, not an error: `(no matches)` for `grep`/`glob`, `(empty directory)` for `list_dir`, `(no entries)` for `tree`, `(empty file)` for `read_file`, `(no differences)` for `diff`. | `packages/tools/src/tools/grep.ts:238`, `packages/tools/src/tools/glob.ts:98`, `packages/tools/src/tools/list-dir.ts:93`, `packages/tools/src/tools/tree.ts:247`, `packages/tools/src/tools/read-file.ts:86`, `packages/tools/src/tools/diff.ts:66` | `packages/tools/tests/integration/grep.test.ts:62-66`, `packages/tools/tests/integration/glob.test.ts:68-73`, `packages/tools/tests/integration/list-dir.test.ts:51-56`, `packages/tools/tests/integration/tree.test.ts:65-70`, `packages/tools/tests/integration/read-file.test.ts:200-209`, `packages/tools/tests/integration/diff.test.ts:34-39` |
| **RS-8** | A truncated *scan* always reports incompleteness even when the page is non-empty, and it is never combined with the pagination footer. | `packages/tools/src/tools/grep.ts:351-365` | `packages/tools/tests/integration/grep.test.ts:122-129` (asserts the `offset` hint is absent) |
| **RS-9** | An exhausted regex budget, a capped directory walk and a hit output cap produce **three different** warnings; the budget warning names the pattern and never says "output cap", and the walk warning says narrowing the pattern will not help. | `packages/tools/src/tools/grep.ts:352-362` | `packages/tools/tests/integration/rg.test.ts:160-166`, `packages/tools/tests/integration/grep.test.ts:181-199` |
| **RS-10** | The regex budget charges regex time only — never a `stat`, a read, or the directory walk — so machine load cannot turn a legitimate scan into a reported-incomplete one. | `packages/tools/src/lib/scan-budget.ts:63-67`; charge sites at `packages/tools/src/lib/rg.ts:396`, `:407` | `packages/tools/tests/unit/scan-budget.test.ts:28-35`, `:43-50`; `packages/tools/tests/integration/rg.test.ts:172-181` |
| **RS-11** | Neither `budgetExhausted` nor `walkCapped` is ever set on the ripgrep path, nor on a single-file search — neither walks a tree, and ripgrep is linear-time and out of process. | `packages/tools/src/lib/rg.ts:145`, `:156`, `:160`, `:256`, `:320` | unpinned (asserted only implicitly, by the budget suite forcing `ripgrepAvailable: false` — `packages/tools/tests/integration/rg.test.ts:140`) |
| **RS-12** | A single-file grep target that is oversized, binary, a FIFO, or unreadable yields `(no matches)` rather than an error — but a `path_escape` from that pre-read still propagates. A FIFO is caught by the earlier `!stat.isFile()` guard and never enters the `readRawFile` try/catch at all; only the oversized/binary/unreadable cases actually call `readRawFile`. | non-regular-file (incl. FIFO) branch: `packages/tools/src/lib/rg.ts:143-146`; oversized/binary/unreadable branch (calls `readRawFile`): `:147-161` | `packages/tools/tests/integration/grep.test.ts:148-210` (four cases, FIFO at `:181-192`); the `path_escape` re-throw at `:130` is **unpinned** |
| **RS-13** | `readTextBuffer` collapses every ordinary failure to `null` but re-throws `path_escape`, so a confinement race cannot masquerade as an empty search result. | `packages/tools/src/lib/textfile.ts:71-73` | `packages/tools/tests/integration/textfile.test.ts:21-43` covers the `null` half; the re-throw is **unpinned** |
| **RS-14 (INV-301)** | Both grep engines search hidden files, never `.git`, and honour `.gitignore` at, below, and **above** the workspace root. | `rg -g !.git` at `packages/tools/src/lib/rg.ts:202`; `.git` component rule at `packages/tools/src/lib/ignore.ts:188`; ignore root walk at `:77-85` | `packages/tools/tests/integration/grep.test.ts:683-708`; `packages/tools/tests/contract/grep-parity.test.ts:205-223` |
| **RS-15** | A `glob` argument to `grep` without a `/` matches at any depth (`**/<name>`), matching ripgrep's semantics. | `packages/tools/src/lib/rg.ts:536-538` | `packages/tools/tests/integration/grep.test.ts:68-74`; `packages/tools/tests/contract/grep-parity.test.ts:52-58` |
| **RS-16** | `grep` pagination units are files in `files_with_matches`/`count` and match anchors in `content`; context rows never count, and the unit set is independent of the context settings. | `packages/tools/src/tools/grep.ts:249`, `:256`, `:307` | `packages/tools/tests/integration/grep.test.ts:384-403` |
| **RS-17** | A multi-line match counts as **one** unit; a run of only single-line matches is not coalesced, so `count` agrees with the per-line engine. | `packages/tools/src/lib/rg.ts:498-508` | `packages/tools/tests/integration/grep.test.ts:519-527`, `:559-583` |
| **RS-18** | `read_file` rejects `offset: 0` and a positive `offset` past EOF (reporting `line_count`), but clamps an over-long negative offset to line 1. | `packages/tools/src/tools/read-file.ts:90-108` | `packages/tools/tests/integration/read-file.test.ts:152-175` |
| **RS-19** | `renderNumberedSlice` always emits at least the `start` row, and never splits a UTF-8 sequence or a surrogate pair when truncating. | `packages/tools/src/lib/render-lines.ts:52-60`, `:4-11` | `packages/tools/tests/unit/render-lines.test.ts:23-56`; `packages/tools/tests/integration/read-file.test.ts:70-76`, `:211-234` |
| **RS-20** | A per-entry failure in `read_files` degrades that entry only; a non-`ToolError` throw fails the whole call. | `packages/tools/src/tools/read-files.ts:144-150` | `packages/tools/tests/integration/read-files.test.ts:42-62`; the rethrow branch is **unpinned** |
| **RS-21** | A UTF-16 BOM exempts a buffer from the binary rejection, so a UTF-16LE/BE file reads as text. | `packages/tools/src/lib/textfile.ts:17`; detection at `packages/tools/src/lib/binary.ts:35-39` | `packages/tools/tests/integration/read-file.test.ts:27-39`; `packages/tools/tests/unit/binary.test.ts:31-37` |
| **RS-22** | The binary heuristic scans only the first and last 8000 bytes, so a NUL buried in the middle of a larger file is **not** detected. | `packages/tools/src/lib/binary.ts:2`, `:15-24` | `packages/tools/tests/unit/binary.test.ts:24-28` (asserts the miss explicitly) |
| **RS-23** | A confined `readRawFile` proves the opened descriptor is the same filesystem object the canonical path names (`dev` + `ino`); a mismatch is `path_escape`, not a silent redirect. | `packages/tools/src/lib/files.ts:121-153`, `:226-278` | **unpinned** in `@clarvis/tools` |
| **RS-24** | `readRawFile` reads at most `maxBytes + 1` bytes from one handle and detects growth after the initial stat. | `packages/tools/src/lib/files.ts:164-178`, `:244-257` | `packages/tools/tests/integration/bounded-read.test.ts:36-49` |
| **RS-25** | Only `read_file` and `read_files` admit `config.stateRoot`; every read tool separately admits the complete configured `temporaryRoots`, and nothing receives the state root merely because temporary access is enabled. | `packages/tools/src/tools/read-file.ts`, `packages/tools/src/tools/read-files.ts` vs. the `config.temporaryRoots` argument in the other seven handlers | `packages/tools/tests/unit/read-confinement-allowance.test.ts` pins the state-root half; `packages/tools/tests/integration/api.test.ts` pins exact scratch and opt-in system-temp configurations |
| **RS-26** | The `path_escape` refusal never tells the model how to lift the boundary; it states the boundary is fixed before the run. | `packages/tools/src/lib/paths.ts:160-166` | `packages/tools/tests/architecture/no-bypass-hints.test.ts:76-84` (and `:86-90`, which proves the detector recognises the old wording) |
| **RS-27** | Confinement folds case on Windows only, compares canonicalised forms on both sides, and requires a `root + sep` prefix so a sibling whose name merely starts with the root's is refused. | `packages/tools/src/lib/paths.ts:137-149` | `packages/tools/tests/integration/paths.test.ts:78-99` |
| **RS-28** | A path that cannot be canonicalised *because a skipped segment is a symlink* is refused, not admitted — otherwise a `0o311` link out of the workspace would be writable. | `packages/tools/src/lib/paths.ts:254` | `packages/tools/tests/integration/paths.test.ts:155-166` |
| **RS-29** | `displayPath` is always forward-slashed, including on Windows, because it is model-facing text and not a filesystem argument. | `packages/tools/src/lib/paths.ts:54-61` | `packages/tools/tests/integration/paths.test.ts:57-60` |
| **RS-30** | A `tree` level that hit its dirent cap marks the output incomplete but does **not** stop the walk; only the global entry/byte budget does. | `packages/tools/src/tools/tree.ts:150-157` vs. `:174` | `packages/tools/tests/integration/tree.test.ts:146-162` |
| **RS-31** | A directory holding exactly `maxTraversalEntries` is not reported as truncated; one extra dirent is consumed solely to tell the two apart. | `packages/tools/src/tools/tree.ts:50-53` | `packages/tools/tests/integration/tree.test.ts:118-144` |
| **RS-32** | `tree` lists a symlinked directory but never traverses it. | `packages/tools/src/tools/tree.ts:67`, `:161` | `packages/tools/tests/integration/tree.test.ts:57-63` |
| **RS-33** | `tree` treats `depth: 0` and an omitted `depth` as the default 4, and clamps any request to 20. | `packages/tools/src/tools/tree.ts:232-233` | `packages/tools/tests/integration/tree.test.ts:95-102`; the 20-clamp is **unpinned** |
| **RS-34** | `glob` sorts newest-`mtime` first with ascending-path tie-break, and drops an entry whose `stat` fails between enumeration and sorting. | `packages/tools/src/tools/glob.ts:87-100` | `packages/tools/tests/integration/glob.test.ts:29-49`, `:86-99` |
| **RS-35** | `list_dir` includes dotfiles and does not consult `.gitignore`; `glob`, `tree` and the in-process grep do (the first two by opt-out flag, grep unconditionally). | `list-dir.ts` (no ignore import); `packages/tools/src/tools/glob.ts:74-78`; `packages/tools/src/tools/tree.ts:238`; `packages/tools/src/lib/rg.ts:542` | `packages/tools/tests/integration/list-dir.test.ts:26-33`; `packages/tools/tests/integration/glob.test.ts:51-66`; `packages/tools/tests/integration/tree.test.ts:34-44`; `packages/tools/tests/integration/grep.test.ts:691-697` |
| **RS-36** | `file_stat` reports type, size, mtime and mode from the **same descriptor** it reads the head from, and refuses a pathname that became a symlink between `lstat` and `open`. | `packages/tools/src/tools/file-stat.ts:100-140` | `packages/tools/tests/integration/file-stat.test.ts`, "reports metadata and content from the same opened file after a pathname race" and "fails closed when a regular pathname becomes a symlink before open" |
| **RS-37** | `diff` compares EOL-normalised content, so CRLF vs LF is `(no differences)`, and rejects a combined input above `maxDiffInputBytes` before running the algorithm. | `packages/tools/src/tools/diff.ts:62-76` | `packages/tools/tests/integration/diff.test.ts:41-46`, `:82-91` |
| **RS-38** | `read_image` decides the MIME type from magic bytes, never the extension, and recognises exactly PNG / JPEG / GIF87a+89a / WebP; a `RIFF` container that is not `WEBP` is not an image. | `packages/tools/src/lib/image.ts:10-51`; call site `packages/tools/src/tools/read-image.ts:56-63` | `packages/tools/tests/unit/image.test.ts:5-44`; `packages/tools/tests/integration/read-image.test.ts:23-45` |
| **RS-39** | An ignore source is read from a non-blocking descriptor and capped at 1 MiB; a FIFO cannot block the matcher and an oversized `.gitignore` is treated as absent with a warning. | `packages/tools/src/lib/ignore.ts:34-68`, `:144-149` | `packages/tools/tests/integration/ignore.test.ts:101-114`, `:151-163`, `:182-189` |
| **RS-40** | `loadIgnore` never ignores `""`, `"."`, a `../`-relative or an absolute path, and always ignores anything under a `.git` component. | `packages/tools/src/lib/ignore.ts:183-188` | `packages/tools/tests/integration/ignore.test.ts:62-66`, `:167-178` |
| **RS-41** | `findCascadeMatch` tries four tiers in decreasing strictness and returns the first tier with at least one surviving span; a span disproportionate to the source block (≥2× its line count, or ≥500 extra characters) is discarded within its tier. | `packages/tools/src/lib/match-cascade.ts:197-209`, `:153-159` | `packages/tools/tests/unit/match-cascade.test.ts:88-125` |
| **RS-42** | `grep`'s `head_limit: 0` is coerced to "unlimited" by a falsy-OR fallback, not rejected and not treated as "zero results". | `packages/tools/src/tools/grep.ts:161` | `packages/tools/tests/integration/grep.test.ts:421-426` ("treats head_limit 0 as unlimited (no rejection)") |
| **RS-43** | `before_context`/`after_context` each independently override the shared `context` default on their own side only; the other side keeps `context`'s value. | `packages/tools/src/tools/grep.ts:158-159` | `packages/tools/tests/integration/grep.test.ts:323-332` ("after_context overrides context for the after side (precedence)") |
| **RS-44** | `context`/`before_context`/`after_context` are read only in `output_mode: "content"`; in `files_with_matches` or `count` mode all three are forced to `0` and silently ignored. | `packages/tools/src/tools/grep.ts:157-159` | **unpinned** — no test in `packages/tools/tests` sets `context` alongside a non-`content` `output_mode`; inferred from the unconditional ternary at `:150-152` |
| **RS-45** | `blockSpan` extends a matched span to swallow the following line's newline when `oldString` itself ends in `\n` — except when the matched block is the text's final line, where there is no following newline to swallow. | `packages/tools/src/lib/match-cascade.ts:89-101` | `packages/tools/tests/unit/match-cascade.test.ts:66-74` ("extends the span to include the trailing newline"), `:76-82` ("does not over-extend when old ends in newline but the block is the final line") |
| **RS-46** | `scanLineBlocks` treats a sparse-array hole in either the haystack window or the needle as an empty string (`eq(hay[i+j] ?? "", need[j] ?? "")`), rather than skipping it or throwing. | `packages/tools/src/lib/match-cascade.ts:61` | `packages/tools/tests/unit/match-cascade.test.ts:29-34` ("treats a hole in the haystack window as an empty line"), `:36-39` ("treats a hole in the needle as an empty line") |
| **RS-47 (INV-302)** | Both grep engines apply `maxFileBytes` identically **and in both directions**: a file over the ceiling is skipped in a directory search (a small sibling still matches), and naming that same oversized file directly yields `(no matches)` on both paths rather than an error. | `packages/tools/src/lib/rg.ts:203` (`--max-filesize`); `:147-161` (the single-file `readRawFile` bound, whose failure resolves to an empty result rather than a throw) | `packages/tools/tests/contract/grep-parity.test.ts:179-203` |
| **RS-48** | Temporary observation follows configuration, not tool history: a standalone exact run root leaves its parent as `path_escape`, while the product loop pre-authorizes host system temp parents so a bare native `mktemp` result is immediately searchable. A verified explicit `mktemp -d /tmp/name-XXXXXX` result is still registered exactly for ownership/cleanup. | `packages/tools/src/config.ts`; `packages/tools/src/sandbox.ts` (`systemTemporaryRoots`); `packages/loop/src/runtime/capabilities/tools.ts` (`accessibleTemporaryRoots`, `ownedTemporaryRoots`); all nine handlers' `resolvePath` calls; `packages/tools/src/lib/files.ts` | `packages/tools/tests/integration/api.test.ts`, "lets native tools read scratch created by shell inside the run-owned temporary root", "reuses a bare mktemp result from the host temp root in a later native tool", and "adopts an explicit mktemp directory created by this shell call"; `packages/tools/tests/integration/guard-dispatch.test.ts`, "treats the configured run temporary root as confined without widening generic /tmp"; `packages/loop/tests/integration/command-guard-wiring.test.ts`, "preauthorizes the host temp across shell and native tools without owning its parent" |

## 6. Failure modes and degradation

### 6.1 Error codes this subsystem produces

All are members of the package's closed `ErrorCode` union
(`packages/tools/src/errors.ts:8-26`) and are serialised in-band as
`{"error":"<code>","message":"…", …fields}` by the dispatcher
(`packages/tools/src/errors.ts:67`, `packages/tools/src/core.ts:75-77`) — a read tool never throws
out of `dispatch`.

| Code | Raised by | Cause |
| --- | --- | --- |
| `not_found` | `fsError` (`packages/tools/src/errors.ts:100`) | `ENOENT` — missing file, missing `glob` base, missing grep root |
| `not_a_file` | `packages/tools/src/errors.ts:101-104`, `packages/tools/src/lib/files.ts:76-85`, `packages/tools/src/lib/files.ts:189-191` | `EISDIR`/`ENOTDIR`, a non-regular file (incl. a FIFO), or `statDirectory` on a file |
| `is_binary` | `packages/tools/src/lib/textfile.ts:19` | NUL in the scan windows and no UTF-16 BOM |
| `not_an_image` | `packages/tools/src/tools/read-image.ts:58` | magic bytes match no supported format |
| `too_large` | `packages/tools/src/lib/files.ts:87-99`, `packages/tools/src/tools/diff.ts:71` | file over `maxFileBytes`/`maxImageBytes`, or diff inputs over `maxDiffInputBytes` |
| `invalid_input` | `packages/tools/src/tools/read-file.ts:91`/`:102`, `packages/tools/src/tools/glob.ts:82`, `packages/tools/src/lib/rg.ts:250`/`:316`/`:368` | offset 0 / past EOF, unusable glob pattern, ripgrep usage error, uncompilable JS regex |
| `path_escape` | `packages/tools/src/lib/paths.ts:159-192`, `packages/tools/src/lib/files.ts:138` | target outside every permitted root, or the opened object is not the one the path named |
| `timeout` | `packages/tools/src/tools/diff.ts:94` | `createTwoFilesPatch` returned `undefined` at 2000 ms |
| `io_error` | `packages/tools/src/errors.ts:115` | any errno the mapping does not recognise |

An unmapped errno additionally emits a `debug` record `tools.fs_error_unmapped` carrying
`errno_code`, `syscall`, `path` and `platform` (`packages/tools/src/errors.ts:105-114`, pinned in
`packages/tools/tests/unit/observability.test.ts` by "names the errno behind an unmapped filesystem
failure") — the errno itself is otherwise visible only to the model.

Anything thrown that is not a `ToolError` is collapsed to `{"error":"internal","message":"internal
error"}` with the real stack going to the warn sink (`packages/tools/src/errors.ts:69-75`).

### 6.2 What degrades silently

| Situation | Degradation | Handler |
| --- | --- | --- |
| `rg` not on `PATH` (probe throws or non-zero) | every grep runs in process; no error, no warning to the model | `packages/tools/src/config.ts:187-193` |
| single-file grep target oversized / binary / FIFO / unreadable | empty result, reported as `(no matches)` | `packages/tools/src/lib/rg.ts:147-161` |
| a file in an in-process directory grep that `readTextBuffer` cannot read | skipped (`if (!decoded) continue`) | `packages/tools/src/lib/rg.ts:391` |
| a `list_dir` entry whose `stat` fails | reported as a size-0 non-directory | `packages/tools/src/tools/list-dir.ts:81-83` |
| a `tree` entry whose `stat` fails | rendered with `size: 0` | `packages/tools/src/tools/tree.ts:70-74` |
| a `glob` match whose `stat` fails | dropped from the result entirely | `packages/tools/src/tools/glob.ts:88-93` |
| an unreadable directory during `listFiles` | skipped, walk continues | `packages/tools/src/lib/files.ts:341-346` |
| an existing but unreadable `.gitignore` | treated as absent, one warning | `packages/tools/src/lib/ignore.ts:144-152` |
| an unreadable global excludes file | treated as absent, **no** warning | `packages/tools/src/lib/ignore.ts:132-134`; pinned `packages/tools/tests/integration/ignore.test.ts:191-201` |
| a `readlink` failure on a `file_stat` symlink | `symlink_target: null` | `packages/tools/src/tools/file-stat.ts:76-79` |
| an unparseable `rg --json` line | skipped | `packages/tools/src/lib/rg.ts:328-332` |
| an `rg` match with a non-UTF-8 path | dropped (no `path.text`) | `packages/tools/src/lib/rg.ts:334-336` |
| a directory handle that fails to close | swallowed | `packages/tools/src/tools/list-dir.ts:67`, `packages/tools/src/tools/tree.ts:57`, `packages/tools/src/lib/files.ts:365` |

### 6.3 What fails hard

- A confinement violation, at resolve time or after `open` — `path_escape`, and it propagates even out
  of the otherwise-swallowing `readTextBuffer` and single-file grep pre-scan
  (`packages/tools/src/lib/textfile.ts:71`, `packages/tools/src/lib/rg.ts:159`).
- `statDirectory` on a non-directory for `list_dir`, `glob`, `tree` (`packages/tools/src/lib/files.ts:189`).
- A non-`ToolError` thrown by a `read_files` entry (`packages/tools/src/tools/read-files.ts:145`).
- A ripgrep spawn failure — `io_error`, not a fallback to the in-process engine
  (`packages/tools/src/lib/rg.ts:244`, `:287`).

### 6.4 Bounds, and what happens when each is reached

| Bound | Reached during | Result |
| --- | --- | --- |
| `maxFileBytes` | any read | `too_large`; but in a directory grep the file is simply skipped |
| `maxOutputBytes` | `renderNumberedSlice` | slice stops, `byteCapped` set, footer names the continuation |
| `maxOutputBytes` | in-process grep accumulation | `truncated`, scan stops before the next file (`packages/tools/src/lib/rg.ts:436`) |
| `maxOutputBytes × 8` | ripgrep raw JSON stream | child `SIGKILL`ed, `truncated` (`packages/tools/src/lib/rg.ts:233-242`, `:296-308`) |
| `maxOutputBytes` | grep page rendering | head-truncated by `bound`, "page exceeded … and was cut" footer |
| `maxOutputBytes` | any non-`bounded` tool's text parts | head-truncated by the dispatcher (`packages/tools/src/core.ts:79-85`) |
| `maxTraversalEntries` | `list_dir`, `glob`, `tree`, grep's file walk | truncation footer / `truncated` flag; grep additionally sets `walkCapped` and says so in its own words |
| `maxDiffInputBytes` | `diff` | `too_large` |
| `regexScanBudgetMs` | in-process grep | `truncated` + `budgetExhausted`, pattern-specific warning |
| `MAX_IGNORE_FILE_BYTES` | any ignore source | source treated as absent |
| 2000 ms | `createTwoFilesPatch` in `diff` | `timeout` |

There are **no retries and no timeouts** anywhere in this subsystem apart from the diff library's own
2000 ms budget and the regex scan budget: no read is re-attempted, no `rg` invocation is retried, and
no `AbortSignal` is threaded into any of the nine handlers (the `signal` parameter exists on `ToolDef`
at `packages/tools/src/tools/types.ts:58` and none of them declare it). `listFiles` accepts an
`opts.signal` (`packages/tools/src/lib/files.ts:324`) but no caller in this subsystem passes one
(`packages/tools/src/tools/glob.ts:74-78`, `packages/tools/src/lib/rg.ts:540-544`).

## 7. Coupling

### 7.1 Outbound (what this subsystem depends on)

| Dependency | Kind | What forces it |
| --- | --- | --- |
| `@clarvis/paths` → `INTERNAL_IGNORE_PATTERNS` | runtime, static | `packages/tools/src/lib/ignore.ts:6`, `:129` — the built-in ignore seed is not spelled here |
| `@clarvis/paths` → `resolveCommand` | runtime, static | `packages/tools/src/lib/rg.ts:11`, `:226`, `:277` — `rg` is resolved against `PATH` once and memoised (`packages/paths/src/which.ts:100-111`) |
| `@clarvis/paths` → `workspaceStatePaths` | runtime, static | `packages/tools/src/config.ts:7`, `:503` — supplies `stateRoot` |
| `ignore` (npm) | runtime, `createRequire` | `packages/tools/src/lib/ignore.ts:9` |
| `picomatch` (npm) | runtime, `createRequire` | `packages/tools/src/lib/files.ts:14`, `:328` |
| `diff` (npm) | runtime, static | `packages/tools/src/tools/diff.ts:1`; `packages/tools/src/lib/unified-diff.ts:1`; `packages/tools/src/lib/text.ts:1` |
| `ajv` (npm) | runtime, `createRequire` | `packages/tools/src/core.ts:47` — schema defaulting/coercion happens before any handler runs |
| `rg` binary | runtime, `spawn`/`Bun.spawn` | `packages/tools/src/lib/rg.ts:226`, `:277`; probed at `packages/tools/src/config.ts:187-193` |
| Bun's `Bun.spawn` | runtime, **hard Bun coupling** | `packages/tools/src/lib/rg.ts:277` — the single-file snapshot path uses Bun's native subprocess API because "Bun's Node-compatible `child_process` currently closes a piped stdin before queued writes reach the child" (`packages/tools/src/lib/rg.ts:265-267`) |

The package's manifest declares exactly `@clarvis/paths`, `ajv`, `diff`, `ignore`, `picomatch`
(`packages/tools/package.json` dependencies) — there is no source-code parser, and
`packages/tools/tests/architecture/no-tree-sitter.test.ts` fails if one reappears.

### 7.2 Inbound (what depends on this subsystem)

| Consumer | Kind | What forces it |
| --- | --- | --- |
| `@clarvis/loop` → `READ_ONLY_TOOL_NAMES` | runtime, static | `packages/loop/src/runtime/tools/builtin/names.ts:1`, `:14` — the loop's read/edit split is *derived* from `readOnlyTools` rather than restated, so a tool's `readOnly` bit here decides which agents may call it |
| `@clarvis/loop` → `AGENT_TOOL_NAMES`, `EDIT_TOOL_NAMES` | runtime, static | `packages/loop/src/runtime/tools/builtin/names.ts:4`, `:18-20` |
| `@clarvis/loop` tool spill | runtime | `packages/loop/src/runtime/context/tool-spill.ts` names `RuntimeConfig`'s state-root allowance in its own doc comment — the read tools' `alsoAllow` is what lets the model read a spilled result back |
| `@clarvis/kernel` | runtime, static | `packages/kernel/src/file-kernel.ts`, `packages/kernel/src/local.ts` import `@clarvis/tools` |

The direction is one-way and structural: `@clarvis/tools` imports nothing from `loop`, `kernel`,
`capability` or `protocol` — its only internal dependency is `@clarvis/paths`, which is itself a leaf.

### 7.3 Internal coupling worth naming

- `lib/rg.ts` is the only module that reaches all of `binary`, `files`, `text`, `textfile` and
  `scan-budget` at once (`packages/tools/src/lib/rg.ts:5-9`); it is the integration point of the
  library.
- `lib/files.ts` imports `lib/ignore.ts` (`:6`) and `lib/paths.ts` (`:7`), so the glob walker and the
  confinement re-check are not separable from the ignore semantics.
- The read tools reach the library only through `resolvePath`/`displayPath`, `readFileOptions`,
  `readTextFile`/`readRawFile`, `renderNumberedSlice`, `statDirectory`/`mapLimit`/`listFiles`,
  `loadIgnore`, `grepSearch`, `isBinary`, `sniffImageMime` — none of them touch `node:fs` for content
  except `list_dir`/`tree`/`glob`/`file_stat`, which need `opendir`/`lstat`/`stat` directly.

## 8. Open questions

1. ~~**Two tool descriptions claim a truncation behaviour the code does not implement.**~~
   **Resolved:** the descriptions were stale — no function in the package has ever dropped a middle —
   and all **three** now name the end the reader actually loses. `read_file`
   (`packages/tools/src/tools/read-file.ts:37`-`:39`) and `grep`
   (`packages/tools/src/tools/grep.ts:62`-`:63`) say the result loses its **tail**, which is what
   `renderNumberedSlice` (`packages/tools/src/lib/render-lines.ts:48`-`:64`) and `bound`
   (`packages/tools/src/lib/output.ts:50`-`:56`) do. `shell` was wrong in the other direction and
   was corrected with them: it bounds through `boundOrSpill`/`bufferTail`, so it loses its **head**
   (`packages/tools/src/tools/shell.ts:142`-`:144`). Both sentences are now pinned per tool
   (`packages/tools/tests/component/core.test.ts:143`-`:157`), including the negative — that none of
   the three claims a middle-drop again.
2. **RS-2 is only pinned by construction.** No test asserts that a *confined* directory grep refuses
   ripgrep; the parity suite merely disables confinement so it can compare the engines
   (`packages/tools/tests/contract/grep-parity.test.ts:40`). A regression that started spawning `rg`
   for confined directories would keep the whole suite green.
3. ~~**The `stateRoot` read allowance (RS-25) is untested in both packages.** `rg -n stateRoot` over
   `packages/tools/tests` returns only the fixture default
   (`packages/tools/tests/helpers/fixtures.ts:83`), and `packages/loop/tests/integration/tool-spill.test.ts`
   contains no `read_file` round-trip. The one behaviour the widening exists for — a model reading back
   a spilled result — has no executable evidence.~~ **Resolved 2026-08-22** in `@clarvis/tools`, which
   is where the allowance lives: a state root that is a genuine sibling of the workspace, a file
   written into it, and both read tools opening it with `confineToWorkspace: true`. The two negative
   controls are what make it mean something — a third directory is still refused, and `write_file`
   against the same spill path fails.
4. ~~**The `tools.grep_path` debug record is untested.** `packages/tools/tests/unit/observability.test.ts`
   pins `tools.path_refused`, `tools.fs_error_unmapped` and `tools.spill_failed`, but not the engine
   record at `packages/tools/src/lib/rg.ts:165-173`, whose message claims "the two do not share regex
   semantics, so which one ran decides what a pattern means".~~ **Resolved 2026-08-22.** The record is
   now pinned in that same file — and it turned out to be the right instrument for RS-2 above, since
   it is the only seam that observes the engine decision without reaching into the module.
5. ~~**Which engine runs for a given call is fully determined; how far the two engines' regex
   dialects overlap is not, and the code itself says so.**~~ **Resolved 2026-08-22, by measuring
   rather than by reasoning.** The engine half was never ambiguous: `useRipgrep`
   (`packages/tools/src/lib/rg.ts:164`) is a pure function of `config.ripgrepAvailable`, `isDir` and
   `config.confineToWorkspace`, which is RS-2. The grammar half was, and the entry was right that
   settling it from source alone is impossible — a full JS `RegExp` versus Rust `regex` grammar diff
   is knowledge external to this repository. So it was settled the other way, by running both
   engines through the real tool and writing down what each returned:
   `packages/tools/tests/contract/regex-dialect.test.ts` is an 84-row table, one row per construct,
   each carrying the exact output both engines produced, graded
   `shared | js_only | rg_only | neither | divergent | unicode_class`. It changes no behaviour; it
   records the boundary, so a construct that later converges or diverges further turns the suite red.

   Three of its properties are what make it evidence rather than decoration. It self-checks: each
   row's hand-written grade must equal the grade its two recorded outcomes imply, so a row cannot be
   mislabelled quietly. It proves the two configurations really select different engines, without
   which the whole table would be measuring one engine twice. And the ripgrep half is
   `skipIf(!rgAvailable)` while the JavaScript half runs unconditionally, so a host without ripgrep
   still exercises the side it can.

   The measuring corrected the received account of this boundary in five places, each verified
   through `callTool("grep", …)`. `(?P<name>)` was never "the one known divergence" — there are 22
   JavaScript-only constructs and 10 ripgrep-only ones. `[[]`, the ordinary way to match a literal
   `[`, is **JavaScript-only**: ripgrep rejects it as an unclosed character class. `(?P=name)` works
   in *neither*, because the Rust crate has no backreferences at all. `\s`/`\S` are shared, not
   ASCII-versus-Unicode; only `\d`/`\w`/`\b`/`.` and their negations are. And `\uXXXX` is shared
   while the braced `\u{...}` is not.

   Two things deliberately did **not** happen. No classifier rejects a pattern: an earlier proposal
   would have refused every construct graded divergent, which would have turned `[[]` — a search that
   works today and returns the right answer — into an error. And the residual is stated rather than
   hidden: this is a **sampled** diff, so a construct the table does not list is *unclassified*,
   never portable by default. What did change is one string —
   `grep`'s `pattern` description (`packages/tools/src/tools/grep.ts:68-81`) previously told the model
   to "use syntax shared by JavaScript and ripgrep/Rust" without ever saying where the sharing stops,
   which is advice a model cannot act on. It now names the three classes and the portable spelling
   for each.

6. **`MAX_TREE_DEPTH = 20` is unexercised.** No test requests a depth above 4
   (`packages/tools/tests/integration/tree.test.ts`), so the clamp at
   `packages/tools/src/tools/tree.ts:233` is unpinned.
7. ~~**`read_files` budget accounting is approximate and unexplained.**~~ **Resolved:** every line
   the tool appends is now reserved before the section that might be the last one is filled, so a
   `bounded: true` tool no longer returns more than `maxOutputBytes`. Three appends were escaping the
   budget, not one: the trailing `N more file(s) not shown`
   (`packages/tools/src/tools/read-files.ts:96`, `:156`), the per-section
   `N of M lines shown` (`:130`, `:142`), and `bound`'s own truncation marker on an error section,
   which it writes *past* the ceiling it is given (`:40`, `:148`). The `+ 2` for the `\n\n` join
   stays and is deliberately conservative — it is charged once per section while the join adds it
   only between them. Pinned across four ceilings, and separately for the error path
   (`packages/tools/tests/integration/read-files.test.ts:87`-`:112`).
8. ~~**`GrepResult.truncated` from a `listing.truncated` is indistinguishable, to the model, from an
   output-cap truncation.**~~ **Resolved:** the file-walk cap carries its own flag,
   `GrepResult.walkCapped` (`packages/tools/src/lib/rg.ts:70`-`:82`, set at `:442`), and its own
   warning, which tells the model that narrowing the pattern will not help and to narrow the path
   instead (`packages/tools/src/tools/grep.ts:357`-`:360`). It stays accompanied by `truncated` —
   the shape `budgetExhausted` already had — so a caller that knows only the size cap still reports
   the search as incomplete. Never set on the ripgrep path or a single-file search, neither of which
   walks a tree. The two warnings are pinned apart
   (`packages/tools/tests/integration/grep.test.ts:181`-`:199`).
9. **`match-cascade.ts` and `unifiedDiff` are in this document's scope but have no read-tool consumer.**
   Their only production importers are the mutation tools (`packages/tools/src/tools/edit-file.ts:7`, `packages/tools/src/tools/write-file.ts:7`,
   `packages/tools/src/tools/replace.ts:7`). Their *use* — ambiguity resolution, dry-run previews, metadata diffs — belongs to
   **tools-mutation-and-patching**; only their contracts are inventoried above.
10. **`RG_JSON_OVERHEAD = 8` is an unexplained magic number.** `packages/tools/src/lib/rg.ts:102` sets
    the raw-JSON stream cap at eight times `maxOutputBytes`; nothing in the code or tests states how
    the factor was chosen or what it is protecting against beyond "a larger raw JSON stream"
    (`:90-92`).
11. **Windows behaviour of this subsystem is unverified here.** `openReadHandle` takes a Node `"r"`
    branch on `win32` (`packages/tools/src/lib/files.ts:68`), losing both `O_NONBLOCK` and
    `O_NOFOLLOW`; `forCompare` folds case only there (`packages/tools/src/lib/paths.ts:77-79`); the
    drive-letter prefix case is explicitly declared untestable on a POSIX host
    (`packages/tools/tests/integration/paths.test.ts:63-68`). Whether those paths run correctly on a
    Windows runner is not determinable from the sources read.
12. **`glob`'s error message names a library that is no longer used.** `packages/tools/src/tools/glob.ts:82`
    produces "Invalid glob pattern: …", and its test fixture calls the injected failure "simulated
    tinyglob failure" (`packages/tools/tests/integration/glob.test.ts:114`), while the real enumerator
    uses `picomatch` (`packages/tools/src/lib/files.ts:14`). The residue suggests a replaced backend;
    the code does not say when or why.
13. **`read_file`'s `limit: 0` → default-2000 coercion (§4.3) is untested, unlike `grep`'s parallel
    `head_limit: 0` case.** `rg -n "limit: 0|limit:0"` over `packages/tools/tests` finds nothing for
    `read_file`, whereas `grep`'s identical falsy-OR quirk on `head_limit` has a dedicated test
    (`packages/tools/tests/integration/grep.test.ts:421-426`). Whether the asymmetry in test coverage is
    deliberate is not stated anywhere in the code.
