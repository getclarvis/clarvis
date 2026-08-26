import { createSignal } from "solid-js";
import type { Attachment, AttachmentStore } from "../../core/attachments.ts";
import { attachmentBytes, checkAttachmentAdmission } from "../../core/attachments.ts";

export {
  attachmentAdmissionMessage,
  base64DecodedBytes,
  composeWithAttachments,
  formatAttachmentBytes,
  nextAttachmentId,
  type Attachment,
  type AttachmentAdmission,
  type AttachmentAdmissionFailure,
  type AttachmentStore,
  type ImageLoader,
} from "../../core/attachments.ts";

/**
 * Creates the Solid-backed {@link AttachmentStore} the input dock uses.
 *
 * @remarks
 * Stage-1 temporary surface: the pure composition logic lives in
 * `../../core/attachments.ts` and is re-exported above unchanged; this
 * function only supplies the reactive signal backing.
 */
export function createAttachmentStore(): AttachmentStore {
  const [items, setItems] = createSignal<Attachment[]>([]);
  return {
    list: () => items(),
    canAddImage(bytes) {
      return checkAttachmentAdmission(items(), bytes);
    },
    add(attachment) {
      const admission = checkAttachmentAdmission(items(), attachmentBytes(attachment));
      if (!admission.ok) return admission;
      setItems((prev) => [...prev, attachment]);
      return admission;
    },
    remove(id) {
      setItems((prev) => prev.filter((a) => a.id !== id));
    },
    clear() {
      setItems([]);
    },
  };
}
