/** Direct physical-resource restrictions for in-memory tests and explicitly pure helpers. */
export const fastTestResourceRules = {
  "no-restricted-imports": [
    "error",
    {
      patterns: [
        {
          group: [
            "node:fs",
            "node:fs/*",
            "node:child_process",
            "node:net",
            "node:http",
            "node:https",
            "node:tls",
            "node:dgram",
            "bun:sqlite",
          ],
          allowTypeImports: true,
          message: "Move physical resource tests to integration or contract/physical.",
        },
      ],
    },
  ],
  "no-restricted-syntax": [
    "error",
    {
      selector:
        "CallExpression[callee.object.name='Bun'][callee.property.name=/^(spawn|spawnSync|serve|file|write)$/]",
      message: "Fast tests must use in-memory adapters instead of Bun physical APIs.",
    },
    {
      selector:
        "CallExpression[callee.object.name='process'][callee.property.name=/^(chdir|kill|on|once)$/]",
      message: "Fast tests must not mutate process-global state or signal processes.",
    },
    {
      selector:
        "AssignmentExpression[left.object.object.name='process'][left.object.property.name='env']",
      message: "Fast tests must not mutate process.env.",
    },
    {
      selector:
        "UnaryExpression[operator='delete'] > MemberExpression[object.object.name='process'][object.property.name='env']",
      message: "Fast tests must not delete process.env entries.",
    },
    {
      selector: "AssignmentExpression[left.object.name='globalThis']",
      message: "Fast tests must not assign globalThis properties.",
    },
    {
      selector: "CallExpression[callee.object.name='vi'][callee.property.name='stubGlobal']",
      message: "Fast tests must pass an explicit adapter instead of stubbing a global.",
    },
    {
      selector: "CallExpression[callee.name='spyOn'][arguments.0.name=/^(process|globalThis)$/]",
      message: "Fast tests must observe process channels through an explicit adapter.",
    },
    {
      selector:
        "CallExpression[callee.object.name='vi'][callee.property.name='spyOn'][arguments.0.object.name=/^(process|globalThis)$/]",
      message: "Fast tests must observe process channels through an explicit adapter.",
    },
  ],
};
