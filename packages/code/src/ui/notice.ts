/** Semantic severity of a transient UI notice. */
export const NOTICE_TONES = ["info", "success", "warn", "error"] as const;

/** One of the supported semantic notice severities. */
export type NoticeTone = (typeof NOTICE_TONES)[number];

/** Presentation-neutral notification produced by a feature presenter. */
export interface Notice {
  message: string;
  tone?: NoticeTone;
}
