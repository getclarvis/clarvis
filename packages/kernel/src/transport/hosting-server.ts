import { suppressSecondaryRejection, sanitizeErrorMessage } from "@clarvis/capability";
import type {
  ElicitationResponse,
  HostedRunAttachment,
  HostingService,
  Message,
} from "@clarvis/protocol";
import { kernelError } from "../core/errors.ts";
import { M, N } from "./wire.ts";
import {
  wireId,
  wireRecord,
  type HostedAttachmentReply,
  type HostedObservationNote,
} from "./hosting-codec.ts";
import type { NotificationSender } from "./server.ts";

/** Connection-owned subscriptions onto a host-owned registry; no source RunHandle is consumed here. */
export function createHostingDispatcher(options: {
  service(): HostingService;
  notify: NotificationSender;
}) {
  const observations = new Map<string, HostedRunAttachment>();
  const seen = new Set<string>();
  let preparing = 0;
  let closed = false;

  const send = (note: HostedObservationNote): Promise<void> =>
    Promise.resolve(options.notify(N.hostedObservation, note));

  const pump = (id: string, attachment: HostedRunAttachment): void => {
    const { handle } = attachment;
    const offQuestion = handle.onElicit((request) => {
      suppressSecondaryRejection(
        send({ subscription_id: id, kind: "elicitation", request }),
        "the kernel notification channel",
      );
    });
    const offSettled = handle.onElicitSettled?.((elicitation_id) => {
      suppressSecondaryRejection(
        send({ subscription_id: id, kind: "settled", elicitation_id }),
        "the kernel notification channel",
      );
    });
    const failure = (error: unknown): Promise<void> =>
      send({
        subscription_id: id,
        kind: "error",
        message: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
      });
    const stream = (async () => {
      try {
        for await (const frame of handle.events)
          await send({ subscription_id: id, kind: "event", frame });
        await send({ subscription_id: id, kind: "end" });
      } catch (error) {
        await failure(error);
      }
    })();
    const result = handle.done.then(
      (value) => send({ subscription_id: id, kind: "result", result: value }),
      failure,
    );
    suppressSecondaryRejection(
      Promise.all([stream, result, handle.closed]).then(async () => {
        if (typeof offQuestion === "function") offQuestion();
        offSettled?.();
        observations.delete(id);
        await send({ subscription_id: id, kind: "closed" });
      }, failure),
      "the hosted observation terminal channel",
    );
  };

  return {
    async handle(method: string, params: Record<string, unknown>): Promise<unknown> {
      if (closed) throw kernelError("unavailable", "hosted observation connection is closed");
      const service = options.service();
      const id = params.subscription_id;
      if (!wireId(id)) throw kernelError("invalid_request", "invalid hosted subscription id");
      if (method === M.hostingStart || method === M.hostingAttach) {
        if (seen.has(id)) throw kernelError("conflict", "hosted subscription id cannot be reused");
        if (observations.size + preparing >= 4 || seen.size >= 256)
          throw kernelError("resource_exhausted", "hosted observation connection limit reached");
        if (!wireRecord(params.input))
          throw kernelError("invalid_request", "hosted admission requires an input object");
        if (method === M.hostingStart && !wireRecord(params.input.params))
          throw kernelError("invalid_request", "hosted start requires run parameters");
        seen.add(id);
        preparing++;
        try {
          const attachment =
            method === M.hostingStart
              ? await service.start(
                  params.input as unknown as Parameters<HostingService["start"]>[0],
                )
              : await service.attach(
                  params.input as unknown as Parameters<HostingService["attach"]>[0],
                );
          if (closed) {
            await service.releaseObservation(attachment.observation_id);
            throw kernelError(
              "unavailable",
              "connection closed during hosted admission; reconcile its outcome",
            );
          }
          observations.set(id, attachment);
          pump(id, attachment);
          const { handle: _handle, ...reply } = attachment;
          return { subscription_id: id, ...reply } satisfies HostedAttachmentReply;
        } finally {
          preparing--;
        }
      }
      const handle = observations.get(id)?.handle;
      if (handle === undefined)
        throw kernelError("not_found", "hosted observation is no longer active");
      switch (method) {
        case M.hostingSteer:
          if (typeof params.message !== "string" && !wireRecord(params.message))
            throw kernelError("invalid_request", "hosted steering requires a message");
          await handle.steer(params.message as Message | string);
          break;
        case M.hostingCompact:
          if (params.request !== undefined && typeof params.request !== "string")
            throw kernelError("invalid_request", "hosted compaction request must be text");
          await handle.compact(params.request);
          break;
        case M.hostingCancel:
          await handle.cancel();
          break;
        case M.hostingRespond:
          if (!wireRecord(params.response) || !wireId(params.response.id))
            throw kernelError(
              "invalid_request",
              "hosted response requires an elicitation identity",
            );
          await handle.respond(params.response as unknown as ElicitationResponse);
          break;
        default:
          throw kernelError("invalid_request", "unknown hosted observation operation");
      }
      return {};
    },
    close(): void {
      if (closed) return;
      closed = true;
      for (const attachment of observations.values())
        suppressSecondaryRejection(
          options.service().releaseObservation(attachment.observation_id),
          "the hosted connection retirement channel",
        );
      observations.clear();
    },
  };
}
