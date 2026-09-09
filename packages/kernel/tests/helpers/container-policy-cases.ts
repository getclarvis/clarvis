import type { RuntimeLaunchSpec } from "../../src/runtime/types.ts";

export function invalidContainerHostPolicies(spec: RuntimeLaunchSpec): Array<[string, unknown]> {
  const scratch = `rw,nosuid,nodev,noexec,size=${spec.limits.storageBytes}`;
  return [
    ["Privileged", true],
    ["ReadonlyRootfs", false],
    ["Memory", spec.limits.memoryBytes * 2],
    ["PidsLimit", 0],
    ["NanoCpus", 0],
    ["NetworkMode", "host"],
    ["CapAdd", ["SYS_ADMIN"]],
    ["CapAdd", undefined],
    ["SecurityOpt", []],
    ["SecurityOpt", ["no-new-privileges=false"]],
    ["SecurityOpt", ["no-new-privileges", "no-new-privileges=false"]],
    ["SecurityOpt", ["no-new-privileges", {}]],
    ["Tmpfs", {}],
    ["Tmpfs", { "/tmp": "rw,exec,size=99999999" }],
    ["Tmpfs", { "/tmp": `${scratch},exec` }],
    ["Tmpfs", { "/tmp": `${scratch},size=1` }],
    ["Tmpfs", { "/tmp": scratch, "/extra": "rw" }],
  ];
}
