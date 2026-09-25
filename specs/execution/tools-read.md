# File reading and directory listing

`@clarvis/tools` exposes three observing tools: `read_file`, `read_image` and
`list_dir`. A read-only run advertises exactly these tools. Relative paths resolve
from the workspace root; absolute paths use host filesystem permissions.

Production: `toolDescriptors` in [registry.ts](../../packages/tools/src/tools/registry.ts)
and `resolveToolPath` in [paths.ts](../../packages/tools/src/lib/paths.ts).
Test: [tool-surface.test.ts](../../packages/tools/tests/component/tool-surface.test.ts)
and [open-authority.test.ts](../../packages/tools/tests/integration/open-authority.test.ts).

## Operations

| Tool | Input | Result |
| --- | --- | --- |
| `read_file` | `path`, optional one-based `offset` and `limit` | Numbered text lines, bounded by the file and output limits |
| `read_image` | `path` | Image part after byte-level format validation |
| `list_dir` | Optional `path` (default `.`) | One level of directory entries under the traversal and output limits |

`read_file` opens a descriptor without blocking on a FIFO, rejects non-regular
files, reads no more than the configured file limit plus one byte, and numbers
the selected lines. A zero-byte file returns `(empty file)`. The `maxFileBytes`
and `maxOutputBytes` settings bound the read and its rendered result. The same
`readRawFile` primitive supports trusted host consumers.

Production: `readFile` in [read-file.ts](../../packages/tools/src/tools/read-file.ts),
`readRawFile` in [files.ts](../../packages/tools/src/lib/files.ts), and
`renderNumberedSlice` in [render-lines.ts](../../packages/tools/src/lib/render-lines.ts).
Test: [read-file.test.ts](../../packages/tools/tests/integration/read-file.test.ts)
and [bounded-read.test.ts](../../packages/tools/tests/integration/bounded-read.test.ts).

`read_image` recognizes PNG, JPEG, GIF and WebP from bytes, including PNG chunk
validation, and respects `maxImageBytes`. `list_dir` reads only the selected
directory; it does not recursively discover files. It limits retained entries
with `maxTraversalEntries` and sorts the result.

Production: `readImage` in [read-image.ts](../../packages/tools/src/tools/read-image.ts),
`sniffImageMime` in [image.ts](../../packages/tools/src/lib/image.ts), and
`listDir` in [list-dir.ts](../../packages/tools/src/tools/list-dir.ts).
Test: [read-image.test.ts](../../packages/tools/tests/integration/read-image.test.ts)
and [list-dir.test.ts](../../packages/tools/tests/integration/list-dir.test.ts).

Dispatch, input validation and configuration are specified in
[tools-contract.md](tools-contract.md); file changes in
[tools-mutation.md](tools-mutation.md).
