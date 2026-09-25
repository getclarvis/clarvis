# File-tool and shell access

File tools resolve relative paths from the workspace and accept absolute paths. Reads and writes follow the host process's operating-system permissions. Clarvis does not run a command approval, semantic reviewer, or configuration-file mutation review for these tools.

Use the scope requested by the operator. Inspect the current file before editing, preserve unrelated content, and validate the result. Settings, Agent Profiles, Extension Profiles, skills and workflows still have their own schemas and effective-state rules; direct file edits can leave invalid configuration that the host will reject when it loads the file.
