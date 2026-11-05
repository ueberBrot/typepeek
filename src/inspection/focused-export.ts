import {
  InternalSymbolName,
  isExportAssignment,
  isExportDeclaration,
  isExportSpecifier,
  isImportEqualsDeclaration,
  isNamespaceExport,
  isStringLiteralLikeNode,
} from "tsrs/ast";
import type {
  Declaration,
  ExportAssignment,
  ExportDeclaration,
  ExportSpecifier,
  ImportEqualsDeclaration,
  NamespaceExport,
} from "tsrs/ast";
import { SymbolFlags } from "tsrs/sync";
import type { Checker, Symbol as CompilerSymbol } from "tsrs/sync";

import {
  declarationsOf,
  valueDeclarationOf,
} from "#typepeek/inspection/compiler-session";
import { isTypeOnlyAlias } from "#typepeek/inspection/compiler-syntax";
import { UnsupportedInspectionError } from "#typepeek/inspection/errors";
import { memberDeclarationSpaceSchema } from "#typepeek/inspection/member-path";
import type { DeclarationSpace } from "#typepeek/inspection/protocol";
import { bitwiseAnd } from "#typepeek/integer-bits";

const SYMBOL_FLAGS_BY_SPACE: Readonly<Record<DeclarationSpace, SymbolFlags>> = {
  namespace: SymbolFlags.Namespace,
  type: SymbolFlags.Type,
  value: SymbolFlags.Value,
};

export type AliasDeclaration =
  | ExportAssignment
  | ExportDeclaration
  | ExportSpecifier
  | ImportEqualsDeclaration
  | NamespaceExport;

export interface FocusedExportResolution {
  readonly aliasDeclaration: AliasDeclaration | undefined;
  readonly aliasTargetName?: string;
  readonly exportedSymbol: CompilerSymbol;
  readonly spaces: readonly DeclarationSpace[];
  readonly targetSymbol: CompilerSymbol;
  readonly valueAccessible: boolean;
}

/** Resolves an alias target without requiring export-alias presentation evidence. */
export const resolveFocusedExportTarget = function resolveFocusedExportTarget(
  checker: Checker,
  symbol: CompilerSymbol
): CompilerSymbol {
  if (bitwiseAnd(symbol.flags, SymbolFlags.Alias) === 0) {
    return symbol;
  }

  const targetSymbol = checker.getAliasedSymbol(symbol);

  if (
    declarationsOf(targetSymbol) === undefined ||
    declarationsOf(targetSymbol).length === 0
  ) {
    throw new UnsupportedInspectionError(
      "The selected Module Export alias could not be resolved from Installed Evidence."
    );
  }

  return targetSymbol;
};

/** Retains type-only access through reexports and intervening import aliases. */
const isTypeOnlyExport = function isTypeOnlyExport(
  checker: Checker,
  exportedSymbol: CompilerSymbol
): boolean {
  const visited = new Set<CompilerSymbol>();

  for (
    let symbol: CompilerSymbol | undefined = exportedSymbol;
    symbol !== undefined &&
    bitwiseAnd(symbol.flags, SymbolFlags.Alias) !== 0 &&
    !visited.has(symbol);
    symbol = checker.getImmediateAliasedSymbol(symbol)
  ) {
    visited.add(symbol);

    if (declarationsOf(symbol).some(isTypeOnlyAlias) ?? false) {
      return true;
    }
  }

  return false;
};

/** Property lookup retains the compiler's contextual type-only export-star restrictions. */
const isModuleExportValueAccessible = function isModuleExportValueAccessible(
  checker: Checker,
  moduleSymbol: CompilerSymbol,
  exportedSymbol: CompilerSymbol,
  targetSymbol: CompilerSymbol
): boolean {
  const declaration =
    valueDeclarationOf(moduleSymbol) ?? declarationsOf(moduleSymbol)[0];

  if (declaration === undefined) {
    throw new UnsupportedInspectionError(
      "The selected Module Export has no module declaration provenance."
    );
  }

  const moduleType = checker.getTypeOfSymbolAtLocation(
    moduleSymbol,
    declaration
  );

  const property = checker.getPropertyOfType(moduleType, exportedSymbol.name);

  return (
    property !== undefined &&
    resolveFocusedExportTarget(checker, property) === targetSymbol
  );
};

const isAliasDeclaration = function isAliasDeclaration(
  declaration: Declaration
): declaration is AliasDeclaration {
  return (
    isExportAssignment(declaration) ||
    isExportSpecifier(declaration) ||
    isImportEqualsDeclaration(declaration) ||
    isNamespaceExport(declaration)
  );
};

const findFocusedExportAliasDeclaration =
  function findFocusedExportAliasDeclaration(
    exportedSymbol: CompilerSymbol
  ): AliasDeclaration | undefined {
    if (bitwiseAnd(exportedSymbol.flags, SymbolFlags.Alias) === 0) {
      return undefined;
    }

    const declaration = declarationsOf(exportedSymbol).find(isAliasDeclaration);

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
    checker: Checker,
    moduleSymbol: CompilerSymbol,
    exportedSymbol: CompilerSymbol,
    targetSymbol: CompilerSymbol
  ): ExportDeclaration {
    const declarations = declarationsOf(
      moduleSymbol.getExports().get(InternalSymbolName.ExportStar)
    );

    for (const declaration of declarations) {
      if (
        !isExportDeclaration(declaration) ||
        declaration.moduleSpecifier === undefined
      ) {
        continue;
      }

      const source = checker.getSymbolAtLocation(declaration.moduleSpecifier);

      if (source !== undefined) {
        const sourceExport = checker
          .getExportsOfModule(resolveFocusedExportTarget(checker, source))
          .find((symbol) => symbol.name === exportedSymbol.name);

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
  exportedSymbol: CompilerSymbol,
  targetSymbol: CompilerSymbol,
  aliasDeclaration: AliasDeclaration | undefined
): string | undefined {
  if (
    aliasDeclaration === undefined ||
    isExportDeclaration(aliasDeclaration) ||
    (isExportSpecifier(aliasDeclaration) &&
      exportedSymbol.name === targetSymbol.name)
  ) {
    return undefined;
  }

  if (!isNamespaceExport(aliasDeclaration)) {
    return targetSymbol.name;
  }

  const moduleSpecifier = isExportDeclaration(aliasDeclaration.parent)
    ? aliasDeclaration.parent.moduleSpecifier
    : undefined;

  return moduleSpecifier !== undefined &&
    isStringLiteralLikeNode(moduleSpecifier)
    ? moduleSpecifier.text
    : "namespace module";
};

export const resolveFocusedExportSymbol = function resolveFocusedExportSymbol(
  checker: Checker,
  exportedSymbol: CompilerSymbol,
  moduleSymbol: CompilerSymbol
): FocusedExportResolution {
  const targetSymbol = resolveFocusedExportTarget(checker, exportedSymbol);

  const typeOnly =
    isTypeOnlyExport(checker, exportedSymbol) ||
    (bitwiseAnd(targetSymbol.flags, SymbolFlags.Value) !== 0 &&
      !isModuleExportValueAccessible(
        checker,
        moduleSymbol,
        exportedSymbol,
        targetSymbol
      ));

  const aliasDeclaration =
    findFocusedExportAliasDeclaration(exportedSymbol) ??
    (typeOnly && bitwiseAnd(targetSymbol.flags, SymbolFlags.Type) === 0
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
      bitwiseAnd(targetSymbol.flags, SymbolFlags.Value) !== 0 && !typeOnly,
  };
};

export const resolveFocusedExport = function resolveFocusedExport(
  checker: Checker,
  moduleSymbol: CompilerSymbol,
  exportName: string
): FocusedExportResolution | undefined {
  const exportedSymbol = checker
    .getExportsOfModule(moduleSymbol)
    .find((symbol) => symbol.name === exportName);

  if (exportedSymbol === undefined) {
    return undefined;
  }

  return resolveFocusedExportSymbol(checker, exportedSymbol, moduleSymbol);
};
