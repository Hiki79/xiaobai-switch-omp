import { describe, expect, it } from "vitest";
import { reorderList } from "./reorder";

describe("reorderList", () => {
  it("moves an item to a new index and keeps the rest in order", () => {
    expect(reorderList(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(reorderList(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(reorderList(["a", "b", "c"], 1, 1)).toEqual(["a", "b", "c"]);
  });

  it("ignores out-of-range indexes", () => {
    expect(reorderList(["a", "b"], -1, 0)).toEqual(["a", "b"]);
    expect(reorderList(["a", "b"], 0, 9)).toEqual(["a", "b"]);
  });
});
