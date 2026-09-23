# When configuration is rejected or pending

1. For an invalid settings document, inspect the exact validation error, check the supported fields in the settings reference and the Settings interface, then correct the requested scope and retry the reviewed file operation. Do not move the same bytes to another path.
2. For untrusted workspace configuration, inspect the workspace trust status through the operator Settings surface. Only the operator's existing trust control can approve the specific executable inputs; editing a file or loading this skill cannot do it.
3. For a selected profile mismatch, inspect the effective Extension Profile and its exact standalone skill or plugin references. A file present in a root may still be inactive because it was not selected, is withheld by trust or belongs to a different scope.
4. For a disabled capability, compare the entry agent's grants and immutable ceiling with the selected runtime placement. An unavailable `load_skill` or file tool cannot be restored by skill text.
5. For a write that succeeded but is not effective, check whether the result says refresh pending or reconnect required. A captured run keeps its old skill/resources; a later safe snapshot can see a refreshed catalog. Provider, placement or profile changes may need reconnect.
