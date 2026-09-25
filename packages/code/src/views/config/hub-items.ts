/** Lightweight route metadata shared by command routing and lazily loaded hubs. */
export const SETTINGS_ITEMS = [
  {
    id: "providers",
    label: "Providers",
    desc: "Credentials, models and context limits",
    cmd: "providers.open",
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
    desc: "Run budget",
    cmd: "defaults.open",
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
] as const;
