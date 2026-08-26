import { expect, test } from "bun:test";
import {
  createWorkspaceCallbackTarget,
  isActiveWorkspaceCallbackTarget,
} from "../../src/app/workspace-runtime.ts";

test("workspace callbacks stop when their single runtime retires", () => {
  const target = createWorkspaceCallbackTarget<{ events: string[] }>();
  const other = createWorkspaceCallbackTarget<{ events: string[] }>();
  const host = { events: [] as string[] };
  const callback = (event: string): void => {
    target.current()?.events.push(event);
  };

  target.bind(host);
  expect(isActiveWorkspaceCallbackTarget(target, target)).toBeTrue();
  expect(isActiveWorkspaceCallbackTarget(target, other)).toBeFalse();
  callback("current event");
  target.clear();
  callback("late event");

  expect(host.events).toEqual(["current event"]);
  expect(isActiveWorkspaceCallbackTarget(target, target)).toBeFalse();
});
