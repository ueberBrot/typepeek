import { describe, expect, it, vi } from "vite-plus/test";

import { requireDefined } from "#typepeek/defined-value";
import { resolveFocusedExportSymbol } from "#typepeek/inspection/focused-export";
import { inspectPackageDocumentation } from "#typepeek/inspection/package-documentation";

import { createFixtureProgram } from "./helpers/native-compiler.ts";

const selectedExport = (text: string) => {
  const fileName = "/documentation/index.d.ts";

  const program = createFixtureProgram(
    [fileName],
    { noEmit: true, noLib: true },
    [[fileName, text]]
  );

  const { checker } = program.getProject();

  const moduleSymbol = requireDefined(
    checker.getSymbolAtLocation(requireDefined(program.getSourceFile(fileName)))
  );

  const exportedSymbol = requireDefined(
    checker.getExportsOfModule(moduleSymbol)[0]
  );

  return {
    checker,
    ...resolveFocusedExportSymbol(checker, exportedSymbol, moduleSymbol),
  };
};

describe("package documentation queries", () => {
  it.each(["Reads a value.", ""])(
    "reads an unaliased symbol once, including empty documentation: %s",
    (comment) => {
      const { checker, exportedSymbol, targetSymbol, aliasDeclaration } =
        selectedExport(
          `/** ${comment} */ export declare function read(): void;`
        );

      expect(exportedSymbol.getDocumentationComment).toBeTypeOf("function");
      expect(exportedSymbol.getJsDocTags).toBeTypeOf("function");

      const documentationRead = vi.spyOn(
        exportedSymbol,
        "getDocumentationComment"
      );

      const tagsRead = vi.spyOn(exportedSymbol, "getJsDocTags");

      try {
        const documentation = inspectPackageDocumentation(
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

  it("stops at attached alias documentation before querying native symbol documentation", () => {
    const { checker, exportedSymbol, targetSymbol, aliasDeclaration } =
      selectedExport(
        [
          "/** Target guidance. */ declare function read(): void;",
          "/** Alias guidance. */ export { read as selected };",
        ].join("\n")
      );

    expect(exportedSymbol.getDocumentationComment).toBeTypeOf("function");
    expect(targetSymbol.getDocumentationComment).toBeTypeOf("function");
    const exportRead = vi.spyOn(exportedSymbol, "getDocumentationComment");
    const targetRead = vi.spyOn(targetSymbol, "getDocumentationComment");

    try {
      expect(
        inspectPackageDocumentation(
          checker,
          exportedSymbol,
          targetSymbol,
          aliasDeclaration
        )?.text
      ).toBe("Alias guidance.");
      expect(exportRead).not.toHaveBeenCalled();
      expect(targetRead).not.toHaveBeenCalled();
    } finally {
      exportRead.mockRestore();
      targetRead.mockRestore();
    }
  });
});
