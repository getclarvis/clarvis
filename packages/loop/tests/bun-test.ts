export * from "bun:test";

import { vi as bunVi } from "bun:test";

const originalGlobals = new Map<PropertyKey, PropertyDescriptor | undefined>();
const nativeAdvanceTimersByTime = bunVi.advanceTimersByTime.bind(bunVi);
const nativeRunAllTimers = bunVi.runAllTimers.bind(bunVi);
const nativeUseFakeTimers = bunVi.useFakeTimers.bind(bunVi);

interface WaitForOptions {
  interval?: number;
  timeout?: number;
}

type BunVi = typeof bunVi;
type CompatVi = Omit<BunVi, "useFakeTimers"> & {
  advanceTimersByTimeAsync(ms: number): Promise<void>;
  importActual<T>(specifier: string): Promise<T>;
  mocked<T>(value: T): T;
  runAllTimersAsync(): Promise<true>;
  stubGlobal(name: PropertyKey, value: unknown): void;
  unstubAllGlobals(): void;
  useFakeTimers(options?: { now?: Date | number; toFake?: string[] }): void;
  waitFor<T>(callback: () => T | Promise<T>, options?: WaitForOptions): Promise<T>;
};

const compatibilityMethods = {
  async advanceTimersByTimeAsync(ms: number): Promise<void> {
    nativeAdvanceTimersByTime(ms);
    await Promise.resolve();
  },
  async importActual<T>(specifier: string): Promise<T> {
    return (await import(specifier)) as T;
  },
  mocked<T>(value: T): T {
    return value;
  },
  async runAllTimersAsync(): Promise<true> {
    nativeRunAllTimers();
    await Promise.resolve();
    return true;
  },
  stubGlobal(name: PropertyKey, value: unknown): void {
    if (!originalGlobals.has(name)) {
      originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    }
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value,
      writable: true,
    });
  },
  unstubAllGlobals(): void {
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    originalGlobals.clear();
  },
  useFakeTimers(options?: { now?: Date | number; toFake?: string[] }): void {
    nativeUseFakeTimers(options?.now === undefined ? undefined : { now: options.now });
  },
  async waitFor<T>(
    callback: () => T | Promise<T>,
    { interval = 20, timeout = 1000 }: WaitForOptions = {},
  ): Promise<T> {
    const deadline = Date.now() + timeout;
    let lastError: unknown;
    while (Date.now() <= deadline) {
      try {
        return await callback();
      } catch (error) {
        lastError = error;
        await Bun.sleep(interval);
      }
    }
    throw lastError;
  },
};

export const vi = new Proxy(bunVi, {
  get(target, property, receiver) {
    if (property in compatibilityMethods) {
      return compatibilityMethods[property as keyof typeof compatibilityMethods];
    }
    return Reflect.get(target, property, receiver);
  },
}) as unknown as CompatVi;
