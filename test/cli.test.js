import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runPool } from "../src/cli.js";

describe("CLI Worker Pool", () => {
  it("processes items concurrently and preserves original array order", async () => {
    const items = [10, 20, 30, 40, 50];
    const delays = [50, 10, 40, 20, 30];

    const results = await runPool(items, 3, async (val, index) => {
      await new Promise((resolve) => setTimeout(resolve, delays[index]));
      return val * 2;
    });

    assert.deepEqual(results, [20, 40, 60, 80, 100]);
  });

  it("handles empty item lists gracefully", async () => {
    const results = await runPool([], 5, async (x) => x);
    assert.deepEqual(results, []);
  });

  it("catches errors in worker functions without crashing the pool", async () => {
    const items = ["ok", "boom", "ok2"];

    const results = await runPool(items, 2, async (val) => {
      if (val === "boom") throw new Error("Worker failed");
      return `Processed: ${val}`;
    });

    assert.equal(results[0], "Processed: ok");
    assert.deepEqual(results[1], { error: "Worker failed" });
    assert.equal(results[2], "Processed: ok2");
  });
});
