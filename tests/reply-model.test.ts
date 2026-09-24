import { describe, expect, it } from "vitest";
import { DisallowedModelError, REPLY_MODELS, resolveModel } from "@/lib/reply/suggest";

/**
 * Paul's rule: only haiku or sonnet may draft a message. Kept in code rather
 * than in a habit, so it survives the next person editing this file.
 */
describe("resolveModel", () => {
  it("defaults to sonnet", () => {
    expect(resolveModel(undefined)).toBe(REPLY_MODELS.sonnet);
    expect(resolveModel("")).toBe(REPLY_MODELS.sonnet);
  });

  it("accepts the short names", () => {
    expect(resolveModel("haiku")).toBe(REPLY_MODELS.haiku);
    expect(resolveModel("sonnet")).toBe(REPLY_MODELS.sonnet);
    expect(resolveModel("  haiku  ")).toBe(REPLY_MODELS.haiku);
  });

  it("accepts a full id that is on the list", () => {
    expect(resolveModel(REPLY_MODELS.haiku)).toBe(REPLY_MODELS.haiku);
  });

  it("offers only haiku and sonnet", () => {
    expect(Object.keys(REPLY_MODELS).sort()).toEqual(["haiku", "sonnet"]);
  });

  // Refusing beats falling back. A typo that quietly reverts to the default
  // is how a setting stops meaning anything.
  it("refuses anything else rather than defaulting", () => {
    expect(() => resolveModel("claude-opus-5")).toThrow(DisallowedModelError);
    expect(() => resolveModel("sonent")).toThrow(/Only sonnet or haiku/);
  });
});
