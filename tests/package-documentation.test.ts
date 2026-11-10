import { describe, expect, it, vi } from "vite-plus/test";

import { inspectPackageDocumentation } from "#typepeek/inspection/projection/package-documentation";
import { resolveFocusedExportSymbol } from "#typepeek/inspection/queries/focused-export";
import { requireDefined } from "#typepeek/shared/defined-value";

import { createFixtureProgram } from "./helpers/native-compiler.ts";

const selectedExport = async (text: string) => {
  const fileName = "/documentation/index.d.ts";

  const program = await createFixtureProgram(
    [fileName],
    { noEmit: true, noLib: true },
    [[fileName, text]]
  );

  const { checker } = program.getProject();

  const moduleSymbol = requireDefined(
    await checker.getSymbolAtLocation(
      requireDefined(await program.getSourceFile(fileName))
    )
  );

  const exportsOfModule = await checker.getExportsOfModule(moduleSymbol);
  const exportedSymbol = requireDefined(exportsOfModule[0]);

  return {
    checker,
    ...(await resolveFocusedExportSymbol(
      checker,
      exportedSymbol,
      moduleSymbol
    )),
  };
};

describe("package documentation queries", () => {
  it.each(["Reads a value.", ""])(
    "reads an unaliased symbol once, including empty documentation: %s",
    async (comment) => {
      const { checker, exportedSymbol, targetSymbol, aliasDeclaration } =
        await selectedExport(
          `/** ${comment} */ export declare function read(): void;`
        );

      const documentationRead = vi.spyOn(
        exportedSymbol,
        "getDocumentationComment"
      );

      const tagsRead = vi.spyOn(exportedSymbol, "getJsDocTags");

      try {
        const documentation = await inspectPackageDocumentation(
          checker,
          exportedSymbol,
          targetSymbol,
          aliasDeclaration
        );

        expect(documentation?.text).toBe(comment || undefined);
        expect(documentationRead).toHaveBeenCalledOnce();
        expect(tagsRead).toHaveBeenCalledOnce();
      } finally {
        documentationRead.mockRestore();
        tagsRead.mockRestore();
      }
    }
  );

  it("stops at attached alias documentation before querying native symbol documentation", async () => {
    const { checker, exportedSymbol, targetSymbol, aliasDeclaration } =
      await selectedExport(
        [
          "/** Target guidance. */ declare function read(): void;",
          "/** Alias guidance. */ export { read as selected };",
        ].join("\n")
      );

    const exportRead = vi.spyOn(exportedSymbol, "getDocumentationComment");
    const targetRead = vi.spyOn(targetSymbol, "getDocumentationComment");

    try {
      const inspectPackageDocumentationResult =
        await inspectPackageDocumentation(
          checker,
          exportedSymbol,
          targetSymbol,
          aliasDeclaration
        );

      expect(inspectPackageDocumentationResult?.text).toBe("Alias guidance.");
      expect(exportRead).not.toHaveBeenCalled();
      expect(targetRead).not.toHaveBeenCalled();
    } finally {
      exportRead.mockRestore();
      targetRead.mockRestore();
    }
  });
});
