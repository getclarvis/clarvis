import { lazy, Suspense, type JSX } from "solid-js";
import type { ViewFactory, ViewHost } from "../../keys/commands.ts";

interface LazyViewProps {
  host: ViewHost;
}

/**
 * Keep a view module outside the startup graph until its route is first mounted.
 *
 * @param load - Dynamic import projected to the module's view factory.
 * @returns A synchronous command view factory with a lightweight loading frame.
 * @remarks The loaded component is cached by Solid, while each mounted subtree
 * remains owned by the route's Solid lifecycle and is disposed when that route
 * unmounts.
 */
export function lazyView(load: () => Promise<ViewFactory>): ViewFactory {
  const Component = lazy(async () => {
    const factory = await load();
    return { default: (props: LazyViewProps): JSX.Element => factory(props.host) };
  });
  return (host) => (
    <Suspense fallback={<text>Loading…</text>}>
      <Component host={host} />
    </Suspense>
  );
}
