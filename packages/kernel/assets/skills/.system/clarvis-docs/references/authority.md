# File-tool and shell access

File tools resolve relative paths from the workspace and accept absolute paths. Built-in file and shell tools use the run's selected execution policy within the host account's operating-system permissions. The file Kernel defaults to Sandbox with a writable workspace and disabled network. Ordinary reads are broadly allowed; credential directories are not implicitly hidden. Writes are limited to admitted roots. Workspace metadata such as `.git`, `.clarvis`, `.agents` and `.aws` is read-only by default, including linked Git metadata.

Kernel-bound calls are authorized after argument validation. An ordinary action within its policy needs no extra question; eligible additional permissions go to the operator in manual mode or the semantic reviewer in auto mode. Mandatory read-only paths and explicit read denies remain enforced. Configuration files have no special write exemption. Host is an explicit execution choice; Sandbox setup failure never grants Host access automatically.

Use the scope requested by the operator. Inspect the current file before editing, preserve unrelated content, and validate the result. A permission decision authorizes the action, not the configuration's semantic validity: settings, Agent Profiles, Extension Profiles, skills and workflows are validated when loaded. A direct file edit can therefore persist invalid configuration. Loading this guide grants no permission and cannot change workspace trust or the run's tool grants.

After a denial, use its stated reason and the operator's supported approval controls. Do not retry the same effect through another tool or path to evade the decision. After an uncertain outcome, inspect the result before proposing another action; some effects may already have occurred.
