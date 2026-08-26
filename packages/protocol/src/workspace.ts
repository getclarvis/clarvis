/**
 * WorkspaceService — read-only view of the run workspace.
 *
 * Used for the file picker and image references, with paths confined server-side.
 * On a hosted kernel the files live on the server and a remote UI reaches them only
 * here (there is no local filesystem).
 */

/** One file or directory entry in the workspace tree. */
export interface WorkspaceEntry {
  /** Workspace-relative path. */
  path: string;
  kind: "file" | "dir";
  /** Byte size when `kind` is `"file"`. */
  size?: number;
}

/** Read-only workspace filesystem surface. */
export interface WorkspaceService {
  /**
   * List workspace entries, optionally filtered.
   *
   * @param query.prefix - Path prefix to restrict the walk.
   * @param query.glob - Glob pattern to match against paths.
   * @param query.limit - Maximum number of entries to return.
   */
  listFiles(query?: { prefix?: string; glob?: string; limit?: number }): Promise<WorkspaceEntry[]>;

  /**
   * Read a text file from the workspace.
   *
   * @param path - Workspace-relative path.
   * @returns The path echoed back plus the file's text content.
   */
  readFile(path: string): Promise<{ path: string; content: string }>;

  /**
   * Read an image for an in-workspace image reference.
   *
   * @param path - Workspace-relative path.
   * @returns Base64 image bytes plus MIME type.
   */
  readImage(path: string): Promise<{ path: string; mime: string; data: string }>;
}
