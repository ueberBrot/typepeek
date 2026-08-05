import { execa } from "execa";
import { describe, expect, it } from "vite-plus/test";

describe("typepeek CLI", () => {
  it("presents the initial command", async () => {
    const result = await execa(process.execPath, ["src/cli.ts", "--help"]);

    expect(result.stdout).toContain("typepeek");
    expect(result.stdout).toContain(
      "Describe the TypeScript-visible Public Interface of Inspectable Modules.",
    );
  });
});
