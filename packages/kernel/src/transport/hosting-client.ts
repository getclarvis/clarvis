import { randomUUID } from "node:crypto";
import { detachObserved, suppressSecondaryRejection, type Logger } from "@clarvis/capability";
import type {
  ElicitationRequest,
  HostedRunAttachment,
  HostedRunFrame,
  HostingService,
  KernelTransport,
  RunResult,
} from "@clarvis/protocol";
import { createEventStream, type EventStream } from "../core/event-stream.ts";
import { kernelError } from "../core/errors.ts";
import {
  coalesceRunEvents,
  sizeOfRunEvent,
  sizeOfCoalescedRunEvent,
} from "../runs/coalesce-events.ts";
import { createServiceProxy, OPERATIONS } from "./operations.ts";
import { M, N } from "./wire.ts";
import {
  decodeHostedNote,
  validHostedAttachment,
  type HostedObservationNote,
} from "./hosting-codec.ts";

interface Subscription {
  id: string;
  executionId: string;
  stream: EventStream<HostedRunFrame>;
  done: PromiseWithResolvers<RunResult>;
  closed: PromiseWithResolvers<void>;
  questions: Map<string, ElicitationRequest>;
  questionListeners: Set<(request: ElicitationRequest) => void>;
  settledListeners: Set<(id: string) => void>;
  early: HostedObservationNote[];
  earlyBytes: number;
  sequence?: number;
  observationId?: string;
  resultReceived: boolean;
  streamEnded: boolean;
  retired: boolean;
}

/**
 * Connection-local observations, never source execution owners. Disconnect rejects observation
 * promises as unavailable; it cannot manufacture a RunResult or replay a start/handoff request.
 */
export function createHostingClient(options: {
  transport: KernelTransport;
  generation: string;
  workspaceId: string;
  logger: Logger;
  protocolViolation(message: string): void;
}): { service: HostingService; close(reason?: unknown): void } {
  const { transport, logger } = options;
  const subscriptions = new Map<string, Subscription>();
  const requests = createServiceProxy<Omit<HostingService, "start" | "attach">>(
    transport,
    OPERATIONS.hosting,
  );
  let closed = false;

  const release = (subscription: Subscription): void => {
    if (subscription.observationId === undefined || closed) return;
    detachObserved(() => requests.releaseObservation(subscription.observationId!), {
      operation: "hosting.observation.release",
      logger,
    });
  };
  const fail = (subscription: Subscription, error: Error): void => {
    if (subscription.retired) return;
    subscription.retired = true;
    subscriptions.delete(subscription.id);
    subscription.early = [];
    subscription.questions.clear();
    subscription.questionListeners.clear();
    subscription.settledListeners.clear();
    subscription.stream.fail(error);
    subscription.done.reject(error);
    subscription.closed.resolve();
    release(subscription);
  };
  const deliver = <T>(listeners: Set<(value: T) => void>, value: T): void => {
    for (const listener of listeners) {
      try {
        listener(value);
      } catch {
        logger.warn(
          { event: "hosting.observation.listener_failed" },
          "hosted observation listener failed",
        );
      }
    }
  };
  const accept = (subscription: Subscription, note: HostedObservationNote): void => {
    if (subscription.retired) return;
    const invalid = (message: string): void => options.protocolViolation(message);
    switch (note.kind) {
      case "event":
        if (subscription.streamEnded || note.frame.first_sequence !== subscription.sequence! + 1) {
          invalid("hosted tail sequence is not contiguous with its snapshot");
          return;
        }
        subscription.sequence = note.frame.last_sequence;
        subscription.stream.push(note.frame);
        return;
      case "elicitation":
        if (note.request.execution_id !== subscription.executionId) {
          invalid("hosted elicitation belongs to a different execution");
          return;
        }
        subscription.questions.set(note.request.id, note.request);
        if (
          subscription.questions.size > 64 ||
          Buffer.byteLength(JSON.stringify([...subscription.questions.values()])) > 8 * 1024 * 1024
        ) {
          fail(
            subscription,
            kernelError("resource_exhausted", "hosted pending elicitation budget exhausted"),
          );
          return;
        }
        deliver(subscription.questionListeners, note.request);
        return;
      case "settled":
        subscription.questions.delete(note.elicitation_id);
        deliver(subscription.settledListeners, note.elicitation_id);
        return;
      case "result":
        if (note.result.execution_id !== subscription.executionId || subscription.resultReceived) {
          invalid("invalid or duplicate hosted result identity");
          return;
        }
        subscription.resultReceived = true;
        subscription.done.resolve(note.result);
        return;
      case "end":
        subscription.streamEnded = true;
        subscription.stream.close();
        return;
      case "error":
        fail(subscription, kernelError("unavailable", note.message));
        return;
      case "closed":
        if (!subscription.resultReceived || !subscription.streamEnded) {
          fail(
            subscription,
            kernelError("unavailable", "observation closed before outcome reconciliation"),
          );
          return;
        }
        subscriptions.delete(subscription.id);
        subscription.retired = true;
        subscription.questions.clear();
        subscription.questionListeners.clear();
        subscription.settledListeners.clear();
        subscription.closed.resolve();
    }
  };
  const off = transport.onNotification(N.hostedObservation, (value) => {
    const note = decodeHostedNote(value);
    if (note === null) {
      options.protocolViolation("invalid hosted observation notification");
      return;
    }
    const subscription = subscriptions.get(note.subscription_id);
    if (subscription === undefined) return;
    if (subscription.sequence !== undefined) {
      accept(subscription, note);
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(note));
    if (subscription.early.length >= 1024 || subscription.earlyBytes + bytes > 16 * 1024 * 1024) {
      fail(
        subscription,
        kernelError("resource_exhausted", "hosted admission notification buffer exhausted"),
      );
      return;
    }
    subscription.early.push(note);
    subscription.earlyBytes += bytes;
  });

  const subscribe = async (
    method: string,
    input: Parameters<HostingService["start"]>[0] | Parameters<HostingService["attach"]>[0],
    executionId: string,
  ): Promise<HostedRunAttachment> => {
    if (closed) throw kernelError("unavailable", "hosted connection is closed");
    if (subscriptions.size >= 4)
      throw kernelError("resource_exhausted", "hosted client observation limit reached");
    const id = randomUUID();
    const stream = createEventStream<HostedRunFrame>({
      maxBuffered: 1024,
      maxBufferedBytes: 16 * 1024 * 1024,
      sizeOf: (frame) => sizeOfRunEvent(frame.event) + 128,
      sizeOfCoalesced: (previous, incoming, merged, previousBytes, incomingBytes) =>
        sizeOfCoalescedRunEvent(
          previous.event,
          incoming.event,
          merged.event,
          previousBytes - 128,
          incomingBytes - 128,
        ) + 128,
      coalesce: (previous, incoming) => {
        const event = coalesceRunEvents(previous.event, incoming.event);
        return event === undefined
          ? undefined
          : {
              first_sequence: previous.first_sequence,
              last_sequence: incoming.last_sequence,
              event,
            };
      },
      droppable: () => false,
      onSaturated: () =>
        fail(
          subscription,
          kernelError("resource_exhausted", "hosted observer fell behind; attach again"),
        ),
      onAbandoned: () =>
        fail(subscription, kernelError("unavailable", "hosted observation abandoned")),
    });
    const subscription: Subscription = {
      id,
      executionId,
      stream,
      done: Promise.withResolvers<RunResult>(),
      closed: Promise.withResolvers<void>(),
      questions: new Map(),
      questionListeners: new Set(),
      settledListeners: new Set(),
      early: [],
      earlyBytes: 0,
      resultReceived: false,
      streamEnded: false,
      retired: false,
    };
    suppressSecondaryRejection(
      subscription.done.promise,
      "the hosted attachment done promise or failed event stream",
    );
    subscriptions.set(id, subscription);
    try {
      const reply = await transport.request(
        M[method === M.hostingStart ? "hostingStart" : "hostingAttach"],
        { input, subscription_id: id },
      );
      if (
        !validHostedAttachment(reply, {
          subscriptionId: id,
          generation: options.generation,
          workspaceId: options.workspaceId,
          executionId,
        })
      ) {
        options.protocolViolation("invalid hosted attachment identity or snapshot");
        throw kernelError("unavailable", "invalid hosted attachment reply");
      }
      subscription.observationId = reply.observation_id;
      if (subscription.retired || closed) {
        release(subscription);
        throw kernelError(
          "unavailable",
          "observation closed during admission; reconcile its outcome",
        );
      }
      subscription.sequence = reply.snapshot.cursor.sequence;
      for (const question of reply.pending_elicitations)
        subscription.questions.set(question.id, question);
      for (const note of subscription.early.splice(0)) accept(subscription, note);
      subscription.earlyBytes = 0;
      const listen = <T>(
        listeners: Set<(value: T) => void>,
        listener: (value: T) => void,
      ): (() => void) => {
        if (subscription.retired) return () => {};
        if (listeners.size >= 16)
          throw kernelError("resource_exhausted", "hosted observation listener limit reached");
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      };
      const control = (
        controlMethod: string,
        params: Record<string, unknown> = {},
      ): Promise<void> => {
        if (closed || subscription.retired)
          return Promise.reject(kernelError("unavailable", "hosted observation is closed"));
        return transport
          .request(controlMethod, { subscription_id: id, ...params })
          .then(() => undefined);
      };
      return {
        run: reply.run,
        observation_id: reply.observation_id,
        snapshot: reply.snapshot,
        pending_elicitations: [...subscription.questions.values()],
        handle: {
          execution_id: executionId,
          events: stream.iterable,
          done: subscription.done.promise,
          closed: subscription.closed.promise,
          steer: (message) => control(M.hostingSteer, { message }),
          compact: (request) => control(M.hostingCompact, { request }),
          cancel: () => control(M.hostingCancel),
          respond: (response) => control(M.hostingRespond, { response }),
          onElicit(listener) {
            const unsubscribe = listen(subscription.questionListeners, listener);
            for (const question of subscription.questions.values())
              deliver(new Set([listener]), question);
            return unsubscribe;
          },
          onElicitSettled: (listener) => listen(subscription.settledListeners, listener),
          buffered: () => ({
            buffered_items: stream.stats().bufferedItems,
            buffered_bytes: stream.stats().bufferedBytes,
            dropped: 0,
          }),
        },
      };
    } catch (error) {
      fail(subscription, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  };
  return {
    service: {
      ...requests,
      start: (input) => subscribe(M.hostingStart, input, input.params.execution_id),
      attach: (input) => subscribe(M.hostingAttach, input, input.execution_id),
      async releaseObservation(id) {
        for (const subscription of subscriptions.values()) {
          if (subscription.observationId === id) {
            subscription.observationId = undefined;
            fail(subscription, kernelError("unavailable", "hosted observation released"));
          }
        }
        await requests.releaseObservation(id);
      },
    },
    close(reason) {
      if (closed) return;
      closed = true;
      off();
      const error = kernelError(
        "unavailable",
        reason instanceof Error
          ? reason.message
          : "hosted connection closed; execution outcome must be reconciled",
      );
      for (const subscription of subscriptions.values()) fail(subscription, error);
    },
  };
}
