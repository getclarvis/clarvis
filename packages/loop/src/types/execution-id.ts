/**
 * The character set a caller-supplied `execution_id` must match: ASCII letters,
 * digits, and the punctuation `.`, `_`, `:`, `-` (one or more, no whitespace).
 */
export const EXECUTION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

/** Minimum length (in characters) of a valid `execution_id`. */
export const EXECUTION_ID_MIN = 1;

/** Maximum length (in characters) of a valid `execution_id`. */
export const EXECUTION_ID_MAX = 128;
