# File-tool and shell access

File tools resolve relative paths from the workspace and accept absolute paths. In Host placement, reads and writes follow the process's operating-system permissions. Clarvis does not run a command approval, semantic reviewer, or configuration-file mutation review for these tools.

When a native sandbox is configured, shell and file tools execute inside it. `workspace-write` admits writes to the workspace and selected temporary roots; `workspace-read-only` keeps the workspace read-only. Configured read-only paths and network restrictions still apply. If the native backend is unavailable, the configured sandbox fails closed.

Use the scope requested by the operator. Inspect the current file before editing, preserve unrelated content, and validate the result. Settings, Agent Profiles, Extension Profiles, skills and workflows still have their own schemas and effective-state rules; direct file edits can leave invalid configuration that the host will reject when it loads the file.
