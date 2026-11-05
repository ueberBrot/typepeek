import {
  isClassDeclaration,
  isConstructorDeclaration,
  isExpressionWithTypeArguments,
  isTypeReferenceNode,
  isVariableDeclaration,
} from "tsrs/ast";
import type { ClassDeclaration, SourceFile } from "tsrs/ast";
import { SymbolFlags } from "tsrs/sync";
import type { Checker, Program, Symbol as CompilerSymbol } from "tsrs/sync";

import { aliasedSymbol } from "#typepeek/inspection/compiler-queries";
import {
  declarationsOf,
  valueDeclarationOf,
  ambientModules,
} from "#typepeek/inspection/compiler-session";
import type { CompilerWorkSession } from "#typepeek/inspection/compiler-work-session";
import type { NodeProviderProgram } from "#typepeek/inspection/declaration-reference-authority";
import { UnsupportedInspectionError } from "#typepeek/inspection/errors";
import { InstalledDeclarationGraph } from "#typepeek/inspection/installed-declaration-graph";
import type { DeclarationProviderAuthority } from "#typepeek/inspection/installed-evidence";
import { InstalledProgramLoader } from "#typepeek/inspection/installed-program-loader";
import { selectNodeDeclarationProgram } from "#typepeek/inspection/node-declaration-authority";
import type { InspectionPlanQuery } from "#typepeek/inspection/protocol";
import { bitwiseAnd } from "#typepeek/integer-bits";

const FOCUSED_EXPORT = "focused-export";
const COMPLETE_MODULE = "complete-module";

export type InstalledProgramSelection = {
  readonly compilerWorkSession: CompilerWorkSession;
  readonly declarationAuthority: DeclarationProviderAuthority;
  readonly resolutionContextDirectory: string;
  readonly readNodeDeclarationProvider: () =>
    | DeclarationProviderAuthority
    | undefined;
} & (
  | {
      readonly kind: "package";
      readonly ambientSpecifier: string | undefined;
    }
  | {
      readonly kind: "platform";
      readonly specifier: string;
    }
);

export interface InstalledProgramEvidence {
  readonly checker: Checker;
  readonly moduleSymbol: CompilerSymbol;
}

interface InstalledProgramRequirements {
  readonly focusedExportNames: readonly string[];
  readonly needsStandardLibrary: boolean;
  readonly needsNodeAugmentation: boolean;
  readonly nodeAugmentationExportNames: ReadonlySet<string> | undefined;
}

type NodeAugmentationScope = "none" | "complete-module" | "focused-export";

const NODE_AUGMENTATION_SCOPE_BY_QUERY = {
  "declaration-inspection": FOCUSED_EXPORT,
  "export-inspection": FOCUSED_EXPORT,
  "export-search": COMPLETE_MODULE,
  "interface-overview": COMPLETE_MODULE,
  "member-discovery": FOCUSED_EXPORT,
  "member-inspection": FOCUSED_EXPORT,
  "public-subpath-discovery": "none",
  "signature-inspection": FOCUSED_EXPORT,
} as const satisfies Readonly<
  Record<InspectionPlanQuery["intent"], NodeAugmentationScope>
>;

const installedProgramRequirements = function installedProgramRequirements(
  queries: readonly InspectionPlanQuery[]
): InstalledProgramRequirements {
  const focusedExportNames: string[] = [];
  const nodeAugmentationExportNames = new Set<string>();
  let needsNodeAugmentation = false;
  let nodeAugmentationRequiresCompleteModule = false;

  for (const query of queries) {
    if ("exportName" in query) {
      focusedExportNames.push(query.exportName);
    }

    const augmentationScope = NODE_AUGMENTATION_SCOPE_BY_QUERY[query.intent];

    if (augmentationScope === "none") {
      continue;
    }

    needsNodeAugmentation = true;

    if (augmentationScope === COMPLETE_MODULE) {
      nodeAugmentationRequiresCompleteModule = true;
    } else if ("exportName" in query) {
      nodeAugmentationExportNames.add(query.exportName);
    }
  }

  return {
    focusedExportNames,
    needsNodeAugmentation,
    // The checker needs standard declarations to preserve arrays and generic types.
    needsStandardLibrary: queries.some((query) => {
      if (query.intent === "signature-inspection") {
        return true;
      }

      if (query.intent === "export-search" && query.scope === "documentation") {
        return true;
      }

      if (query.intent === "export-inspection") {
        return true;
      }

      if (query.intent === "member-inspection") {
        return true;
      }

      return query.intent === "member-discovery";
    }),
    nodeAugmentationExportNames: nodeAugmentationRequiresCompleteModule
      ? undefined
      : nodeAugmentationExportNames,
  };
};

const ambientModuleName = function ambientModuleName(
  symbol: CompilerSymbol
): string {
  const { name } = symbol;

  return name.startsWith('"') && name.endsWith('"') ? name.slice(1, -1) : name;
};

const packageModuleSymbol = function packageModuleSymbol(
  checker: Checker,
  sourceFile: SourceFile,
  ambientSpecifier: string | undefined
): CompilerSymbol | undefined {
  const sourceFileSymbol = checker.getSymbolAtLocation(sourceFile);

  if (sourceFileSymbol !== undefined || ambientSpecifier === undefined) {
    return sourceFileSymbol;
  }

  return ambientModules(checker).find(
    (symbol) => ambientModuleName(symbol) === ambientSpecifier
  );
};

const initialPackageEvidence = function initialPackageEvidence(
  program: Program,
  selection: InstalledProgramSelection
):
  | {
      readonly moduleSymbol: CompilerSymbol;
    }
  | undefined {
  if (selection.kind !== "package") {
    return undefined;
  }

  const sourceFile = program.getSourceFile(
    selection.declarationAuthority.declarationPath
  );

  const moduleSymbol =
    sourceFile === undefined
      ? undefined
      : packageModuleSymbol(
          program.getProject().checker,
          sourceFile,
          selection.ambientSpecifier
        );

  return moduleSymbol === undefined ? undefined : { moduleSymbol };
};

const selectedValueNeedsStandardLibrary =
  function selectedValueNeedsStandardLibrary(
    checker: Checker,
    symbol: CompilerSymbol
  ): boolean {
    const declaration = valueDeclarationOf(symbol);

    if (declaration === undefined || !isVariableDeclaration(declaration)) {
      return false;
    }

    const { type } = declaration;

    const typeSymbol =
      type !== undefined && isTypeReferenceNode(type)
        ? checker.getSymbolAtLocation(type.typeName)
        : undefined;

    if (type === undefined) {
      return false;
    }

    if (!isTypeReferenceNode(type)) {
      return false;
    }

    return (
      typeSymbol === undefined ||
      (declarationsOf(typeSymbol) ?? []).length === 0
    );
  };

const inheritedConstructorNeedsStandardLibrary =
  function inheritedConstructorNeedsStandardLibrary(
    checker: Checker,
    declaration: ClassDeclaration,
    visited: Set<ClassDeclaration>,
    depth: number
  ): boolean {
    if (
      declaration.members.some(isConstructorDeclaration) ||
      visited.has(declaration) ||
      depth > 64
    ) {
      return false;
    }

    visited.add(declaration);

    return (declaration.heritageClauses ?? []).some((clause) =>
      clause.types.some((heritage) => {
        const symbol = checker.getSymbolAtLocation(
          isExpressionWithTypeArguments(heritage)
            ? heritage.expression
            : heritage.typeName
        );

        if (symbol === undefined) {
          return true;
        }

        const target = bitwiseAnd(symbol.flags, SymbolFlags.Alias)
          ? aliasedSymbol(checker, symbol)
          : symbol;

        return (declarationsOf(target) ?? []).some(
          (baseDeclaration) =>
            isClassDeclaration(baseDeclaration) &&
            inheritedConstructorNeedsStandardLibrary(
              checker,
              baseDeclaration,
              visited,
              depth + 1
            )
        );
      })
    );
  };

const selectedExportNeedsStandardLibrary =
  function selectedExportNeedsStandardLibrary(
    checker: Checker,
    moduleSymbol: CompilerSymbol,
    exportName: string
  ): boolean {
    const exportedSymbol = checker
      .getExportsOfModule(moduleSymbol)
      .find((symbol) => symbol.name === exportName);

    if (exportedSymbol === undefined) {
      return false;
    }

    const symbol = bitwiseAnd(exportedSymbol.flags, SymbolFlags.Alias)
      ? aliasedSymbol(checker, exportedSymbol)
      : exportedSymbol;

    return (
      selectedValueNeedsStandardLibrary(checker, symbol) ||
      (declarationsOf(symbol) ?? []).some(
        (declaration) =>
          isClassDeclaration(declaration) &&
          inheritedConstructorNeedsStandardLibrary(
            checker,
            declaration,
            new Set(),
            0
          )
      )
    );
  };

const inspectModuleEvidence = function inspectModuleEvidence(
  program: Program,
  declarationPath: string,
  ambientSpecifier: string | undefined,
  graph: InstalledDeclarationGraph
): InstalledProgramEvidence {
  const sourceFile = program.getSourceFile(declarationPath);

  if (sourceFile === undefined) {
    throw new UnsupportedInspectionError(
      "The declaration entrypoint does not describe an Inspectable Module."
    );
  }

  const { checker } = program.getProject();
  graph.assertSourceResolved(program, checker, sourceFile);

  const moduleSymbol = packageModuleSymbol(
    checker,
    sourceFile,
    ambientSpecifier
  );

  if (moduleSymbol === undefined) {
    throw new UnsupportedInspectionError(
      "The declaration entrypoint does not describe an Inspectable Module."
    );
  }

  graph.assertAmbientModuleResolved(program, checker, moduleSymbol);

  return { checker, moduleSymbol };
};

const inspectPlatformModuleEvidence = function inspectPlatformModuleEvidence(
  program: Program,
  declarationPath: string,
  specifier: string,
  graph: InstalledDeclarationGraph
): InstalledProgramEvidence {
  const sourceFile = program.getSourceFile(declarationPath);

  if (sourceFile === undefined) {
    throw new UnsupportedInspectionError(
      "The visible Declaration Provider has no readable module declarations."
    );
  }

  const { checker } = program.getProject();
  graph.assertSourceResolved(program, checker, sourceFile);

  const moduleSymbol = ambientModules(checker).find(
    (symbol) => ambientModuleName(symbol) === specifier
  );

  if (moduleSymbol === undefined) {
    throw new UnsupportedInspectionError(
      `Node Platform Module "${specifier}" is not declared by the visible @types/node provider.`
    );
  }

  graph.assertAmbientModuleResolved(program, checker, moduleSymbol);

  return { checker, moduleSymbol };
};

const inspectSelectedModule = function inspectSelectedModule(
  program: Program,
  selection: InstalledProgramSelection,
  graph: InstalledDeclarationGraph
): InstalledProgramEvidence {
  if (selection.kind === "package") {
    return inspectModuleEvidence(
      program,
      selection.declarationAuthority.declarationPath,
      selection.ambientSpecifier,
      graph
    );
  }

  return inspectPlatformModuleEvidence(
    program,
    selection.declarationAuthority.declarationPath,
    selection.specifier,
    graph
  );
};

export const materializeInstalledProgram = function materializeInstalledProgram(
  selection: InstalledProgramSelection,
  queries: readonly InspectionPlanQuery[]
): InstalledProgramEvidence {
  const { declarationPath, root: declarationRoot } =
    selection.declarationAuthority;

  const requirements = installedProgramRequirements(queries);

  const host = new InstalledProgramLoader(
    [declarationRoot.canonical, declarationRoot.logical],
    selection.compilerWorkSession
  );

  const graph = new InstalledDeclarationGraph(host);

  const initialProgram = host.createProgram(
    [declarationPath],
    requirements.needsStandardLibrary
  );

  const initialEvidence = initialPackageEvidence(initialProgram, selection);

  const publicInterfaceProgram =
    !requirements.needsStandardLibrary &&
    initialEvidence !== undefined &&
    requirements.focusedExportNames.some((exportName) =>
      selectedExportNeedsStandardLibrary(
        initialProgram.getProject().checker,
        initialEvidence.moduleSymbol,
        exportName
      )
    )
      ? host.createProgram([declarationPath], true)
      : initialProgram;

  const initialSourceFile =
    publicInterfaceProgram.getSourceFile(declarationPath);

  const initialModuleSymbol =
    selection.kind === "package" && initialSourceFile !== undefined
      ? packageModuleSymbol(
          publicInterfaceProgram.getProject().checker,
          initialSourceFile,
          selection.ambientSpecifier
        )
      : undefined;

  const canAugmentNode =
    selection.kind !== "platform" && requirements.needsNodeAugmentation;

  const nodeProgram =
    !canAugmentNode ||
    initialSourceFile === undefined ||
    initialModuleSymbol === undefined
      ? undefined
      : selectNodeDeclarationProgram(
          publicInterfaceProgram,
          initialModuleSymbol,
          initialSourceFile,
          (): NodeProviderProgram | undefined => {
            const nodeProvider = selection.readNodeDeclarationProvider();

            if (nodeProvider === undefined) {
              return undefined;
            }

            host.allowPackageRoot(nodeProvider.root);

            return {
              program: host.createProgram(
                [declarationPath, nodeProvider.declarationPath],
                requirements.needsStandardLibrary ||
                  publicInterfaceProgram !== initialProgram
              ),
              providerRoot: nodeProvider.root.canonical,
            };
          },
          () => {
            graph.reserveTraversalNode();
          },
          requirements.nodeAugmentationExportNames
        );

  const program = nodeProgram ?? publicInterfaceProgram;

  return inspectSelectedModule(program, selection, graph);
};
