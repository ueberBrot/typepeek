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
import { SymbolFlags } from "tsrs/async";
import type { Checker, Symbol as CompilerSymbol } from "tsrs/async";

import { aliasedSymbol } from "#typepeek/inspection/compiler/compiler-queries";
import {
  declarationsOf,
  valueDeclarationOf,
} from "#typepeek/inspection/compiler/compiler-session";
import { isTypeOnlyAlias } from "#typepeek/inspection/compiler/compiler-syntax";
import { UnsupportedInspectionError } from "#typepeek/inspection/model/errors";
import { memberDeclarationSpaceSchema } from "#typepeek/inspection/model/member-path";
import type { DeclarationSpace } from "#typepeek/inspection/model/protocol";
import { bitwiseAnd } from "#typepeek/shared/integer-bits";

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
export const resolveFocusedExportTarget =
  async function resolveFocusedExportTarget(
    checker: Checker,
    symbol: CompilerSymbol
  ): Promise<CompilerSymbol> {
    if (bitwiseAnd(symbol.flags, SymbolFlags.Alias) === 0) {
      return symbol;
    }

    const targetSymbol = await aliasedSymbol(checker, symbol);

    const targetDeclarations = await declarationsOf(targetSymbol);

    if (targetDeclarations.length === 0) {
      throw new UnsupportedInspectionError(
        "The selected Module Export alias could not be resolved from Installed Evidence."
      );
    }

    return targetSymbol;
  };

/** Retains type-only access through reexports and intervening import aliases. */
const isTypeOnlyExport = async function isTypeOnlyExport(
  checker: Checker,
  exportedSymbol: CompilerSymbol
): Promise<boolean> {
  const visited = new Set<CompilerSymbol>();

  /* oxlint-disable eslint/no-await-in-loop -- Each alias target determines the next declaration to visit. */
  for (
    let symbol: CompilerSymbol | undefined = exportedSymbol;
    symbol !== undefined &&
    bitwiseAnd(symbol.flags, SymbolFlags.Alias) !== 0 &&
    !visited.has(symbol);
    symbol = await checker.getImmediateAliasedSymbol(symbol)
  ) {
    visited.add(symbol);

    const declarationsResult = await declarationsOf(symbol);

    if (declarationsResult.some(isTypeOnlyAlias) ?? false) {
      return true;
    }
  }
  /* oxlint-enable eslint/no-await-in-loop */

  return false;
};

/** Property lookup retains the compiler's contextual type-only export-star restrictions. */
const isModuleExportValueAccessible =
  async function isModuleExportValueAccessible(
    checker: Checker,
    moduleSymbol: CompilerSymbol,
    exportedSymbol: CompilerSymbol,
    targetSymbol: CompilerSymbol
  ): Promise<boolean> {
    let declaration = await valueDeclarationOf(moduleSymbol);

    if (declaration === undefined) {
      const declarations = await declarationsOf(moduleSymbol);
      [declaration] = declarations;
    }

    if (declaration === undefined) {
      throw new UnsupportedInspectionError(
        "The selected Module Export has no module declaration provenance."
      );
    }

    const moduleType = await checker.getTypeOfSymbolAtLocation(
      moduleSymbol,
      declaration
    );

    const property = await checker.getPropertyOfType(
      moduleType,
      exportedSymbol.name
    );

    return (
      property !== undefined &&
      (await resolveFocusedExportTarget(checker, property)) === targetSymbol
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
  async function findFocusedExportAliasDeclaration(
    exportedSymbol: CompilerSymbol
  ): Promise<AliasDeclaration | undefined> {
    if (bitwiseAnd(exportedSymbol.flags, SymbolFlags.Alias) === 0) {
      return undefined;
    }

    const declarationsResult = await declarationsOf(exportedSymbol);
    const declaration = declarationsResult.find(isAliasDeclaration);

    if (declaration === undefined) {
      throw new UnsupportedInspectionError(
        "The selected Module Export alias has no declaration provenance."
      );
    }

    return declaration;
  };

/** Uses the export-star declaration as provenance when a type-only value has no named type declaration. */
const findModuleExportStarDeclaration =
  async function findModuleExportStarDeclaration(
    checker: Checker,
    moduleSymbol: CompilerSymbol,
    exportedSymbol: CompilerSymbol,
    targetSymbol: CompilerSymbol
  ): Promise<ExportDeclaration> {
    const exports = await moduleSymbol.getExports();

    const declarations = await declarationsOf(
      exports.get(InternalSymbolName.ExportStar)
    );

    /* oxlint-disable eslint/no-await-in-loop -- Compiler queries share inspection state and must retain serial traversal order. */
    for (const declaration of declarations) {
      if (
        !isExportDeclaration(declaration) ||
        declaration.moduleSpecifier === undefined
      ) {
        continue;
      }

      const source = await checker.getSymbolAtLocation(
        declaration.moduleSpecifier
      );

      if (source !== undefined) {
        const exportsOfModule = await checker.getExportsOfModule(
          await resolveFocusedExportTarget(checker, source)
        );

        const sourceExport = exportsOfModule.find(
          (symbol) => symbol.name === exportedSymbol.name
        );

        if (
          sourceExport !== undefined &&
          (await resolveFocusedExportTarget(checker, sourceExport)) ===
            targetSymbol
        ) {
          return declaration;
        }
      }
    }
    /* oxlint-enable eslint/no-await-in-loop */

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

export const resolveFocusedExportSymbol =
  async function resolveFocusedExportSymbol(
    checker: Checker,
    exportedSymbol: CompilerSymbol,
    moduleSymbol: CompilerSymbol
  ): Promise<FocusedExportResolution> {
    const targetSymbol = await resolveFocusedExportTarget(
      checker,
      exportedSymbol
    );

    const typeOnly =
      (await isTypeOnlyExport(checker, exportedSymbol)) ||
      (bitwiseAnd(targetSymbol.flags, SymbolFlags.Value) !== 0 &&
        !(await isModuleExportValueAccessible(
          checker,
          moduleSymbol,
          exportedSymbol,
          targetSymbol
        )));

    const aliasDeclaration =
      (await findFocusedExportAliasDeclaration(exportedSymbol)) ??
      (typeOnly && bitwiseAnd(targetSymbol.flags, SymbolFlags.Type) === 0
        ? await findModuleExportStarDeclaration(
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

export const resolveFocusedExport = async function resolveFocusedExport(
  checker: Checker,
  moduleSymbol: CompilerSymbol,
  exportName: string
): Promise<FocusedExportResolution | undefined> {
  const exportsOfModule = await checker.getExportsOfModule(moduleSymbol);

  const exportedSymbol = exportsOfModule.find(
    (symbol) => symbol.name === exportName
  );

  if (exportedSymbol === undefined) {
    return undefined;
  }

  return await resolveFocusedExportSymbol(
    checker,
    exportedSymbol,
    moduleSymbol
  );
};
