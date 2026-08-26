import { describe, expect, it } from "bun:test";
import { SkillError, fsError } from "../../src/errors.ts";

describe("SkillError", () => {
  it("carries a code and structured fields", () => {
    const err = new SkillError("invalid_skill", "bad", { path: "/x" });
    expect(err.name).toBe("SkillError");
    expect(err.code).toBe("invalid_skill");
    expect(err.fields).toEqual({ path: "/x" });
  });
});

describe("fsError", () => {
  it("maps ENOENT to not_found", () => {
    const err = fsError({ code: "ENOENT", message: "nope" } as NodeJS.ErrnoException, "/p");
    expect(err.code).toBe("not_found");
  });

  it("maps EISDIR and ENOTDIR to not_a_file", () => {
    expect(fsError({ code: "EISDIR", message: "" } as NodeJS.ErrnoException, "/p").code).toBe(
      "not_a_file",
    );
    expect(fsError({ code: "ENOTDIR", message: "" } as NodeJS.ErrnoException, "/p").code).toBe(
      "not_a_file",
    );
  });

  it("maps any other errno to io_error", () => {
    const err = fsError({ code: "EACCES", message: "denied" } as NodeJS.ErrnoException, "/p");
    expect(err.code).toBe("io_error");
    expect(err.message).toMatch(/EACCES/);
  });

  it("falls back to EIO when the errno carries no code", () => {
    const err = fsError({ message: "weird" } as NodeJS.ErrnoException, "/p");
    expect(err.code).toBe("io_error");
    expect(err.message).toMatch(/EIO/);
  });
});
