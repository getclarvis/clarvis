/** A model reference split into its provider and model-id halves. */
export interface ModelRef {
  /** The provider segment (the text before the first `/`). */
  provider: string;
  /** The model-id segment (the text after the first `/`; `""` when absent). */
  modelId: string;
}

/**
 * Split a `provider/model-id` string into a {@link ModelRef}.
 *
 * @param model - the reference string; only the first `/` is significant.
 * @returns the parsed halves; when there is no `/`, the whole string is the
 *   `provider` and `modelId` is `""`.
 */
export function parseModelRef(model: string): ModelRef {
  const slash = model.indexOf("/");
  if (slash === -1) return { provider: model, modelId: "" };
  return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
}
