/**
 * Tracks disposal for a controller and gates event emission on it, so a
 * controller torn down mid-async-operation doesn't emit into a dead view.
 */
export interface DisposeGuard<Event> {
  isDisposed: () => boolean;
  emit: (event: Event) => void;
  dispose: () => void;
}

/**
 * Creates a {@link DisposeGuard} that forwards events to `emit` until
 * `dispose()` is called.
 *
 * @param emit - The underlying event sink.
 */
export function createDisposeGuard<Event>(emit: (event: Event) => void): DisposeGuard<Event> {
  let disposed = false;
  return {
    isDisposed: () => disposed,
    emit: (event) => {
      if (!disposed) emit(event);
    },
    dispose: () => {
      disposed = true;
    },
  };
}
