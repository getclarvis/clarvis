import { expect, test } from "bun:test";
import { NOTICE_TONES, type Notice } from "../../src/ui/notice.ts";

test("NOTICE_TONES is the complete presentation-neutral severity vocabulary", () => {
  const notice: Notice = { message: "saved", tone: NOTICE_TONES[1] };

  expect(NOTICE_TONES).toEqual(["info", "success", "warn", "error"]);
  expect(notice).toEqual({ message: "saved", tone: "success" });
});
