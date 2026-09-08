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

/** Resolves only the symbol facts shared by focused inspection intents. */
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

  return resolveFocusedExportSymbol(checker, exportedSymbol);
}

export function resolveFocusedExportSymbol(
  checker: ts.TypeChecker,
  exportedSymbol: ts.Symbol,
): FocusedExportResolution {
  const targetSymbol = resolveFocusedExportTarget(checker, exportedSymbol);
  const aliasDeclaration = findFocusedExportAliasDeclaration(exportedSymbol);
  const aliasTargetName = focusedAliasTargetName(exportedSymbol, targetSymbol, aliasDeclaration);
  const typeOnly = aliasDeclaration !== undefined && isTypeOnlyAlias(aliasDeclaration);
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

function isTypeOnlyAlias(declaration: AliasDeclaration): boolean {
  if (ts.isExportSpecifier(declaration)) {
    return declaration.isTypeOnly || declaration.parent.parent.isTypeOnly;
  }
  if (ts.isNamespaceExport(declaration)) {
    return declaration.parent.isTypeOnly;
  }
  return ts.isImportEqualsDeclaration(declaration) ? declaration.isTypeOnly : false;
}
