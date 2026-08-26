/** A single tool invocation observed during a run, as adapted by the host. */
export interface ToolCallEvent {
  call_id?: string;
  tool_name: string;
  server?: string;
  arguments: unknown;
  /** Result excerpt, truncated by the host (recommended ≤ 2000 chars). */
  result_excerpt: string;
  error: string | null;
  started_at: number;
  ended_at: number;
  subagent?: string;
}

/** Version-control state captured with a finished run. */
export interface WorkspaceState {
  vcs?: "git";
  branch?: string;
  commit?: string;
  dirty?: boolean;
}

/** A finished run, adapted by the host for the memory indexer. */
export interface RunSnapshot {
  run_id: string;
  workspace: string;
  status: string;
  started_at: number;
  ended_at: number;
  task: string;
  final_answer?: string;
  tool_calls: ToolCallEvent[];
  steering?: string[];
  workspace_state?: WorkspaceState;
}
