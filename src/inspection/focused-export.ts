import ts from "@typescript/typescript6";

import { UnsupportedInspectionError } from "#typepeek/inspection/errors";
import { memberDeclarationSpaceSchema } from "#typepeek/inspection/member-path";
import type { DeclarationSpace } from "#typepeek/inspection/protocol";
import { bitwiseAnd } from "#typepeek/integer-bits";

const SYMBOL_FLAGS_BY_SPACE: Readonly<
  Record<DeclarationSpace, ts.SymbolFlags>
> = {
  namespace: ts.SymbolFlags.Namespace,
  type: ts.SymbolFlags.Type,
  value: ts.SymbolFlags.Value,
};

export type AliasDeclaration =
  | ts.ExportAssignment
  | ts.ExportDeclaration
  | ts.ExportSpecifier
  | ts.ImportEqualsDeclaration
  | ts.NamespaceExport;

export interface FocusedExportResolution {
  readonly aliasDeclaration: AliasDeclaration | undefined;
  readonly aliasTargetName?: string;
  readonly exportedSymbol: ts.Symbol;
  readonly spaces: readonly DeclarationSpace[];
  readonly targetSymbol: ts.Symbol;
  readonly valueAccessible: boolean;
}

/** Resolves an alias target without requiring export-alias presentation evidence. */
export const resolveFocusedExportTarget = function resolveFocusedExportTarget(
  checker: ts.TypeChecker,
  symbol: ts.Symbol
): ts.Symbol {
  if (bitwiseAnd(symbol.flags, ts.SymbolFlags.Alias) === 0) {
    return symbol;
  }

  const targetSymbol = checker.getAliasedSymbol(symbol);

  if (
    targetSymbol.declarations === undefined ||
    targetSymbol.declarations.length === 0
  ) {
    throw new UnsupportedInspectionError(
      "The selected Module Export alias could not be resolved from Installed Evidence."
    );
  }

  return targetSymbol;
};

/** Retains type-only access through reexports and intervening import aliases. */
const isTypeOnlyExport = function isTypeOnlyExport(
  checker: ts.TypeChecker,
  exportedSymbol: ts.Symbol
): boolean {
  const visited = new Set<ts.Symbol>();

  for (
    let symbol: ts.Symbol | undefined = exportedSymbol;
    symbol !== undefined &&
    bitwiseAnd(symbol.flags, ts.SymbolFlags.Alias) !== 0 &&
    !visited.has(symbol);
    symbol = checker.getImmediateAliasedSymbol(symbol)
  ) {
    visited.add(symbol);

    if (
      symbol.declarations?.some(ts.isTypeOnlyImportOrExportDeclaration) ??
      false
    ) {
      return true;
    }
  }

  return false;
};

/** Property lookup retains the compiler's contextual type-only export-star restrictions. */
const isModuleExportValueAccessible = function isModuleExportValueAccessible(
  checker: ts.TypeChecker,
  moduleSymbol: ts.Symbol,
  exportedSymbol: ts.Symbol,
  targetSymbol: ts.Symbol
): boolean {
  const declaration =
    moduleSymbol.valueDeclaration ?? moduleSymbol.declarations?.[0];

  if (declaration === undefined) {
    throw new UnsupportedInspectionError(
      "The selected Module Export has no module declaration provenance."
    );
  }

  const moduleType = checker.getTypeOfSymbolAtLocation(
    moduleSymbol,
    declaration
  );

  const property = checker.getPropertyOfType(
    moduleType,
    exportedSymbol.getName()
  );

  return (
    property !== undefined &&
    resolveFocusedExportTarget(checker, property) === targetSymbol
  );
};

const isAliasDeclaration = function isAliasDeclaration(
  declaration: ts.Declaration
): declaration is AliasDeclaration {
  return (
    ts.isExportAssignment(declaration) ||
    ts.isExportSpecifier(declaration) ||
    ts.isImportEqualsDeclaration(declaration) ||
    ts.isNamespaceExport(declaration)
  );
};

const findFocusedExportAliasDeclaration =
  function findFocusedExportAliasDeclaration(
    exportedSymbol: ts.Symbol
  ): AliasDeclaration | undefined {
    if (bitwiseAnd(exportedSymbol.flags, ts.SymbolFlags.Alias) === 0) {
      return undefined;
    }

    const declaration = exportedSymbol.declarations?.find(isAliasDeclaration);

    if (declaration === undefined) {
      throw new UnsupportedInspectionError(
        "The selected Module Export alias has no declaration provenance."
      );
    }

    return declaration;
  };

/** Uses the export-star declaration as provenance when a type-only value has no named type declaration. */
const findModuleExportStarDeclaration =
  function findModuleExportStarDeclaration(
    checker: ts.TypeChecker,
    moduleSymbol: ts.Symbol,
    exportedSymbol: ts.Symbol,
    targetSymbol: ts.Symbol
  ): ts.ExportDeclaration {
    const declarations =
      moduleSymbol.exports?.get(ts.InternalSymbolName.ExportStar)
        ?.declarations ?? [];

    for (const declaration of declarations) {
      if (
        !ts.isExportDeclaration(declaration) ||
        declaration.moduleSpecifier === undefined
      ) {
        continue;
      }

      const source = checker.getSymbolAtLocation(declaration.moduleSpecifier);

      if (source !== undefined) {
        const sourceExport = checker
          .getExportsOfModule(resolveFocusedExportTarget(checker, source))
          .find((symbol) => symbol.getName() === exportedSymbol.getName());

        if (
          sourceExport !== undefined &&
          resolveFocusedExportTarget(checker, sourceExport) === targetSymbol
        ) {
          return declaration;
        }
      }
    }

    throw new UnsupportedInspectionError(
      "The selected type-only Module Export has no export declaration provenance."
    );
  };

const focusedAliasTargetName = function focusedAliasTargetName(
  exportedSymbol: ts.Symbol,
  targetSymbol: ts.Symbol,
  aliasDeclaration: AliasDeclaration | undefined
): string | undefined {
  if (
    aliasDeclaration === undefined ||
    ts.isExportDeclaration(aliasDeclaration) ||
    (ts.isExportSpecifier(aliasDeclaration) &&
      exportedSymbol.getName() === targetSymbol.getName())
  ) {
    return undefined;
  }

  if (!ts.isNamespaceExport(aliasDeclaration)) {
    return targetSymbol.getName();
  }

  const { moduleSpecifier } = aliasDeclaration.parent;

  return moduleSpecifier !== undefined &&
    ts.isStringLiteralLike(moduleSpecifier)
    ? moduleSpecifier.text
    : "namespace module";
};

export const resolveFocusedExportSymbol = function resolveFocusedExportSymbol(
  checker: ts.TypeChecker,
  exportedSymbol: ts.Symbol,
  moduleSymbol: ts.Symbol
): FocusedExportResolution {
  const targetSymbol = resolveFocusedExportTarget(checker, exportedSymbol);

  const typeOnly =
    isTypeOnlyExport(checker, exportedSymbol) ||
    (bitwiseAnd(targetSymbol.flags, ts.SymbolFlags.Value) !== 0 &&
      !isModuleExportValueAccessible(
        checker,
        moduleSymbol,
        exportedSymbol,
        targetSymbol
      ));

  const aliasDeclaration =
    findFocusedExportAliasDeclaration(exportedSymbol) ??
    (typeOnly && bitwiseAnd(targetSymbol.flags, ts.SymbolFlags.Type) === 0
      ? findModuleExportStarDeclaration(
          checker,
          moduleSymbol,
          exportedSymbol,
          targetSymbol
        )
      : undefined);

  const aliasTargetName = focusedAliasTargetName(
    exportedSymbol,
    targetSymbol,
    aliasDeclaration
  );

  return {
    aliasDeclaration,
    exportedSymbol,
    spaces: typeOnly
      ? ["type"]
      : memberDeclarationSpaceSchema.literals.filter(
          (space) =>
            bitwiseAnd(targetSymbol.flags, SYMBOL_FLAGS_BY_SPACE[space]) !== 0
        ),
    targetSymbol,
    ...(aliasTargetName !== undefined && { aliasTargetName }),
    valueAccessible:
      bitwiseAnd(targetSymbol.flags, ts.SymbolFlags.Value) !== 0 && !typeOnly,
  };
};

export const resolveFocusedExport = function resolveFocusedExport(
  checker: ts.TypeChecker,
  moduleSymbol: ts.Symbol,
  exportName: string
): FocusedExportResolution | undefined {
  const exportedSymbol = checker
    .getExportsOfModule(moduleSymbol)
    .find((symbol) => symbol.getName() === exportName);

  if (exportedSymbol === undefined) {
    return undefined;
  }

  return resolveFocusedExportSymbol(checker, exportedSymbol, moduleSymbol);
};
