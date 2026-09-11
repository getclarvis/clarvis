/** Lightweight route metadata shared by command routing and lazily loaded hubs. */
export const SETTINGS_ITEMS = [
  {
    id: "providers",
    label: "Providers",
    desc: "Credentials, models and context limits",
    cmd: "providers.open",
  },
  {
    id: "capability-providers",
    label: "Feature backends",
    desc: "Choose what powers Memory, Plans and Tasks",
    cmd: "capability-providers.open",
  },
  {
    id: "agents",
    label: "Agents",
    desc: "Permissions, model, delegation and prompt",
    cmd: "agents.open",
  },
  {
    id: "defaults",
    label: "Defaults",
    desc: "Vision and run budget",
    cmd: "defaults.open",
  },
  {
    id: "memory",
    label: "Memory",
    desc: "Enable and configure execution memory",
    cmd: "memory.config",
  },
  { id: "sandbox", label: "Sandbox", desc: "Native command isolation", cmd: "sandbox.config" },
  {
    id: "isolation",
    label: "Isolation",
    desc: "Host, Sandbox, Docker or Podman",
    cmd: "isolation.config",
  },
  { id: "theme", label: "Theme", desc: "Colors, presets, contrast", cmd: "theme.open" },
  {
    id: "keyboard",
    label: "Keyboard",
    desc: "Portable, enhanced and manual Keyboard Profiles",
    cmd: "keyboard.open",
  },
  {
    id: "updates",
    label: "Updates",
    desc: "Automatic version checks",
    cmd: "updates.open",
  },
  {
    id: "controls",
    label: "Run controls",
    desc: "Safety, sandbox, guard, memory and plan retention for the next run",
    cmd: "controls.open",
  },
] as const;
