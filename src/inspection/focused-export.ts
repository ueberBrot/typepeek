import ts from "@typescript/typescript6";

import { UnsupportedInspectionError } from "#typepeek/inspection/errors";
import { memberDeclarationSpaceSchema } from "#typepeek/inspection/member-path";
import type { DeclarationSpace } from "#typepeek/inspection/protocol";

const SYMBOL_FLAGS_BY_SPACE: Readonly<Record<DeclarationSpace, ts.SymbolFlags>> = {
  type: ts.SymbolFlags.Type,
  value: ts.SymbolFlags.Value,
  namespace: ts.SymbolFlags.Namespace,
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

export function resolveFocusedExport(
  checker: ts.TypeChecker,
  moduleSymbol: ts.Symbol,
  exportName: string,
): FocusedExportResolution | undefined {
  const exportedSymbol = checker
    .getExportsOfModule(moduleSymbol)
    .find((symbol) => symbol.getName() === exportName);
  if (exportedSymbol === undefined) {
    return undefined;
  }

  return resolveFocusedExportSymbol(checker, exportedSymbol, moduleSymbol);
}

export function resolveFocusedExportSymbol(
  checker: ts.TypeChecker,
  exportedSymbol: ts.Symbol,
  moduleSymbol: ts.Symbol,
): FocusedExportResolution {
  const targetSymbol = resolveFocusedExportTarget(checker, exportedSymbol);
  const typeOnly =
    isTypeOnlyExport(checker, exportedSymbol) ||
    ((targetSymbol.flags & ts.SymbolFlags.Value) !== 0 &&
      !isModuleExportValueAccessible(checker, moduleSymbol, exportedSymbol, targetSymbol));
  const aliasDeclaration =
    findFocusedExportAliasDeclaration(exportedSymbol) ??
    (typeOnly && (targetSymbol.flags & ts.SymbolFlags.Type) === 0
      ? findModuleExportStarDeclaration(checker, moduleSymbol, exportedSymbol, targetSymbol)
      : undefined);
  const aliasTargetName = focusedAliasTargetName(exportedSymbol, targetSymbol, aliasDeclaration);
  return {
    aliasDeclaration,
    exportedSymbol,
    targetSymbol,
    spaces: typeOnly
      ? ["type"]
      : memberDeclarationSpaceSchema.literals.filter(
          (space) => (targetSymbol.flags & SYMBOL_FLAGS_BY_SPACE[space]) !== 0,
        ),
    ...(aliasTargetName === undefined ? {} : { aliasTargetName }),
    valueAccessible: (targetSymbol.flags & ts.SymbolFlags.Value) !== 0 && !typeOnly,
  };
}

/** Resolves an alias target without requiring export-alias presentation evidence. */
export function resolveFocusedExportTarget(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  if ((symbol.flags & ts.SymbolFlags.Alias) === 0) {
    return symbol;
  }
  const targetSymbol = checker.getAliasedSymbol(symbol);
  if (targetSymbol.declarations === undefined || targetSymbol.declarations.length === 0) {
    throw new UnsupportedInspectionError(
      "The selected Module Export alias could not be resolved from Installed Evidence.",
    );
  }
  return targetSymbol;
}

/** Property lookup retains the compiler's contextual type-only export-star restrictions. */
function isModuleExportValueAccessible(
  checker: ts.TypeChecker,
  moduleSymbol: ts.Symbol,
  exportedSymbol: ts.Symbol,
  targetSymbol: ts.Symbol,
): boolean {
  const declaration = moduleSymbol.valueDeclaration ?? moduleSymbol.declarations?.[0];
  if (declaration === undefined) {
    throw new UnsupportedInspectionError(
      "The selected Module Export has no module declaration provenance.",
    );
  }
  const moduleType = checker.getTypeOfSymbolAtLocation(moduleSymbol, declaration);
  const property = checker.getPropertyOfType(moduleType, exportedSymbol.getName());
  return property !== undefined && resolveFocusedExportTarget(checker, property) === targetSymbol;
}

/** Uses the export-star declaration as provenance when a type-only value has no named type declaration. */
function findModuleExportStarDeclaration(
  checker: ts.TypeChecker,
  moduleSymbol: ts.Symbol,
  exportedSymbol: ts.Symbol,
  targetSymbol: ts.Symbol,
): ts.ExportDeclaration {
  const declarations =
    moduleSymbol.exports?.get(ts.InternalSymbolName.ExportStar)?.declarations ?? [];
  for (const declaration of declarations) {
    if (!ts.isExportDeclaration(declaration) || declaration.moduleSpecifier === undefined) continue;
    const source = checker.getSymbolAtLocation(declaration.moduleSpecifier);
    if (source === undefined) continue;
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
  throw new UnsupportedInspectionError(
    "The selected type-only Module Export has no export declaration provenance.",
  );
}

function findFocusedExportAliasDeclaration(
  exportedSymbol: ts.Symbol,
): AliasDeclaration | undefined {
  if ((exportedSymbol.flags & ts.SymbolFlags.Alias) === 0) {
    return undefined;
  }
  const declaration = exportedSymbol.declarations?.find(isAliasDeclaration);
  if (declaration === undefined) {
    throw new UnsupportedInspectionError(
      "The selected Module Export alias has no declaration provenance.",
    );
  }
  return declaration;
}

function focusedAliasTargetName(
  exportedSymbol: ts.Symbol,
  targetSymbol: ts.Symbol,
  aliasDeclaration: AliasDeclaration | undefined,
): string | undefined {
  if (
    aliasDeclaration === undefined ||
    ts.isExportDeclaration(aliasDeclaration) ||
    (ts.isExportSpecifier(aliasDeclaration) && exportedSymbol.getName() === targetSymbol.getName())
  ) {
    return undefined;
  }
  if (!ts.isNamespaceExport(aliasDeclaration)) {
    return targetSymbol.getName();
  }
  const moduleSpecifier = aliasDeclaration.parent.moduleSpecifier;
  return moduleSpecifier !== undefined && ts.isStringLiteralLike(moduleSpecifier)
    ? moduleSpecifier.text
    : "namespace module";
}

function isAliasDeclaration(declaration: ts.Declaration): declaration is AliasDeclaration {
  return (
    ts.isExportAssignment(declaration) ||
    ts.isExportSpecifier(declaration) ||
    ts.isImportEqualsDeclaration(declaration) ||
    ts.isNamespaceExport(declaration)
  );
}

/** Retains type-only access through reexports and intervening import aliases. */
function isTypeOnlyExport(checker: ts.TypeChecker, exportedSymbol: ts.Symbol): boolean {
  const visited = new Set<ts.Symbol>();
  for (
    let symbol: ts.Symbol | undefined = exportedSymbol;
    symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0 && !visited.has(symbol);
    symbol = checker.getImmediateAliasedSymbol(symbol)
  ) {
    visited.add(symbol);
    if (symbol.declarations?.some(ts.isTypeOnlyImportOrExportDeclaration)) {
      return true;
    }
  }
  return false;
}
