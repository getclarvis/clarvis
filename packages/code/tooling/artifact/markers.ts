/** Parser-free boot frame marker, absent after the complete application mounts. */
export const BOOT_SHELL_MARKER = "Clarvis · code · starting";

/** Focused startup composer marker, available before the complete application graph hydrates. */
export const STARTUP_READY_MARKER = "Queue a task…";

/** Complete application header marker, absent from the parser-free boot frame. */
export const APP_PAINT_MARKER = "◆ Clarvis";

/** Usable Unicode composer marker, absent from the parser-free boot frame. */
export const APP_READY_MARKER = "New task…";
