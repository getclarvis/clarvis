/** Non-secret host policy that bounds the guest's shared coding-tool capability. */
export interface RuntimeToolPolicy {
  readonly enabled: boolean;
  readonly confine: boolean;
  readonly maxGrant: "none" | "read" | "edit" | "exec";
}
