import {
  isClassDeclaration,
  isConstructorDeclaration,
  isExpressionWithTypeArguments,
  isTypeReferenceNode,
  isVariableDeclaration,
} from "tsrs/ast";
import type { ClassDeclaration, SourceFile } from "tsrs/ast";
import { SymbolFlags } from "tsrs/async";
import type { Checker, Program, Symbol as CompilerSymbol } from "tsrs/async";

import { aliasedSymbol } from "#typepeek/inspection/compiler/compiler-queries";
import {
  declarationsOf,
  valueDeclarationOf,
  ambientModules,
} from "#typepeek/inspection/compiler/compiler-session";
import type { CompilerWorkSession } from "#typepeek/inspection/compiler/compiler-work-session";
import { InstalledProgramLoader } from "#typepeek/inspection/compiler/installed-program-loader";
import type { DeclarationProviderAuthority } from "#typepeek/inspection/evidence/installed-evidence";
import { UnsupportedInspectionError } from "#typepeek/inspection/model/errors";
import type { InspectionPlanQuery } from "#typepeek/inspection/model/protocol";
import type { NodeProviderProgram } from "#typepeek/inspection/projection/declaration-reference-authority";
import { InstalledDeclarationGraph } from "#typepeek/inspection/projection/installed-declaration-graph";
import { selectNodeDeclarationProgram } from "#typepeek/inspection/projection/node-declaration-authority";
import { someAsync } from "#typepeek/shared/async-collection";
import { bitwiseAnd } from "#typepeek/shared/integer-bits";

const FOCUSED_EXPORT = "focused-export";
const COMPLETE_MODULE = "complete-module";

export type InstalledProgramSelection = {
  readonly compilerWorkSession: CompilerWorkSession;
  readonly declarationAuthority: DeclarationProviderAuthority;
  readonly resolutionContextDirectory: string;
  readonly readNodeDeclarationProvider: () => Promise<
    DeclarationProviderAuthority | undefined
  >;
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

const packageModuleSymbol = async function packageModuleSymbol(
  checker: Checker,
  sourceFile: SourceFile,
  ambientSpecifier: string | undefined
): Promise<CompilerSymbol | undefined> {
  const sourceFileSymbol = await checker.getSymbolAtLocation(sourceFile);

  if (sourceFileSymbol !== undefined || ambientSpecifier === undefined) {
    return sourceFileSymbol;
  }

  const modules = await ambientModules(checker);

  return modules.find(
    (symbol) => ambientModuleName(symbol) === ambientSpecifier
  );
};

const initialPackageEvidence = async function initialPackageEvidence(
  program: Program,
  selection: InstalledProgramSelection
): Promise<
  | {
      readonly moduleSymbol: CompilerSymbol;
    }
  | undefined
> {
  if (selection.kind !== "package") {
    return undefined;
  }

  const sourceFile = await program.getSourceFile(
    selection.declarationAuthority.declarationPath
  );

  const moduleSymbol =
    sourceFile === undefined
      ? undefined
      : await packageModuleSymbol(
          program.getProject().checker,
          sourceFile,
          selection.ambientSpecifier
        );

  return moduleSymbol === undefined ? undefined : { moduleSymbol };
};

const selectedValueNeedsStandardLibrary =
  async function selectedValueNeedsStandardLibrary(
    checker: Checker,
    symbol: CompilerSymbol
  ): Promise<boolean> {
    const declaration = await valueDeclarationOf(symbol);

    if (declaration === undefined || !isVariableDeclaration(declaration)) {
      return false;
    }

    const { type } = declaration;

    const typeSymbol =
      type !== undefined && isTypeReferenceNode(type)
        ? await checker.getSymbolAtLocation(type.typeName)
        : undefined;

    if (type === undefined) {
      return false;
    }

    if (!isTypeReferenceNode(type)) {
      return false;
    }

    return (
      typeSymbol === undefined ||
      ((await declarationsOf(typeSymbol)) ?? []).length === 0
    );
  };

const inheritedConstructorNeedsStandardLibrary =
  async function inheritedConstructorNeedsStandardLibrary(
    checker: Checker,
    declaration: ClassDeclaration,
    visited: Set<ClassDeclaration>,
    depth: number
  ): Promise<boolean> {
    if (
      declaration.members.some(isConstructorDeclaration) ||
      visited.has(declaration) ||
      depth > 64
    ) {
      return false;
    }

    visited.add(declaration);

    return await someAsync(
      declaration.heritageClauses ?? [],
      async (clause) =>
        await someAsync(clause.types, async (heritage) => {
          const symbol = await checker.getSymbolAtLocation(
            isExpressionWithTypeArguments(heritage)
              ? heritage.expression
              : heritage.typeName
          );

          if (symbol === undefined) {
            return true;
          }

          const target = bitwiseAnd(symbol.flags, SymbolFlags.Alias)
            ? await aliasedSymbol(checker, symbol)
            : symbol;

          return await someAsync(
            (await declarationsOf(target)) ?? [],
            async (baseDeclaration) =>
              isClassDeclaration(baseDeclaration) &&
              (await inheritedConstructorNeedsStandardLibrary(
                checker,
                baseDeclaration,
                visited,
                depth + 1
              ))
          );
        })
    );
  };

const selectedExportNeedsStandardLibrary =
  async function selectedExportNeedsStandardLibrary(
    checker: Checker,
    moduleSymbol: CompilerSymbol,
    exportName: string
  ): Promise<boolean> {
    const exportsOfModule = await checker.getExportsOfModule(moduleSymbol);

    const exportedSymbol = exportsOfModule.find(
      (symbol) => symbol.name === exportName
    );

    if (exportedSymbol === undefined) {
      return false;
    }

    const symbol = bitwiseAnd(exportedSymbol.flags, SymbolFlags.Alias)
      ? await aliasedSymbol(checker, exportedSymbol)
      : exportedSymbol;

    return (
      (await selectedValueNeedsStandardLibrary(checker, symbol)) ||
      (await someAsync(
        (await declarationsOf(symbol)) ?? [],
        async (declaration) =>
          isClassDeclaration(declaration) &&
          (await inheritedConstructorNeedsStandardLibrary(
            checker,
            declaration,
            new Set(),
            0
          ))
      ))
    );
  };

const inspectModuleEvidence = async function inspectModuleEvidence(
  program: Program,
  declarationPath: string,
  ambientSpecifier: string | undefined,
  graph: InstalledDeclarationGraph
): Promise<InstalledProgramEvidence> {
  const sourceFile = await program.getSourceFile(declarationPath);

  if (sourceFile === undefined) {
    throw new UnsupportedInspectionError(
      "The declaration entrypoint does not describe an Inspectable Module."
    );
  }

  const { checker } = program.getProject();
  await graph.assertSourceResolved(program, checker, sourceFile);

  const moduleSymbol = await packageModuleSymbol(
    checker,
    sourceFile,
    ambientSpecifier
  );

  if (moduleSymbol === undefined) {
    throw new UnsupportedInspectionError(
      "The declaration entrypoint does not describe an Inspectable Module."
    );
  }

  await graph.assertAmbientModuleResolved(program, checker, moduleSymbol);

  return { checker, moduleSymbol };
};

const inspectPlatformModuleEvidence =
  async function inspectPlatformModuleEvidence(
    program: Program,
    declarationPath: string,
    specifier: string,
    graph: InstalledDeclarationGraph
  ): Promise<InstalledProgramEvidence> {
    const sourceFile = await program.getSourceFile(declarationPath);

    if (sourceFile === undefined) {
      throw new UnsupportedInspectionError(
        "The visible Declaration Provider has no readable module declarations."
      );
    }

    const { checker } = program.getProject();
    await graph.assertSourceResolved(program, checker, sourceFile);

    const modules = await ambientModules(checker);

    const moduleSymbol = modules.find(
      (symbol) => ambientModuleName(symbol) === specifier
    );

    if (moduleSymbol === undefined) {
      throw new UnsupportedInspectionError(
        `Node Platform Module "${specifier}" is not declared by the visible @types/node provider.`
      );
    }

    await graph.assertAmbientModuleResolved(program, checker, moduleSymbol);

    return { checker, moduleSymbol };
  };

const inspectSelectedModule = async function inspectSelectedModule(
  program: Program,
  selection: InstalledProgramSelection,
  graph: InstalledDeclarationGraph
): Promise<InstalledProgramEvidence> {
  if (selection.kind === "package") {
    return await inspectModuleEvidence(
      program,
      selection.declarationAuthority.declarationPath,
      selection.ambientSpecifier,
      graph
    );
  }

  return await inspectPlatformModuleEvidence(
    program,
    selection.declarationAuthority.declarationPath,
    selection.specifier,
    graph
  );
};

export const materializeInstalledProgram =
  async function materializeInstalledProgram(
    selection: InstalledProgramSelection,
    queries: readonly InspectionPlanQuery[]
  ): Promise<InstalledProgramEvidence> {
    const { declarationPath, root: declarationRoot } =
      selection.declarationAuthority;

    const requirements = installedProgramRequirements(queries);

    const host = new InstalledProgramLoader(
      [declarationRoot.canonical, declarationRoot.logical],
      selection.compilerWorkSession
    );

    const graph = new InstalledDeclarationGraph(host);

    const initialProgram = await host.createProgram(
      [declarationPath],
      requirements.needsStandardLibrary
    );

    const initialEvidence = await initialPackageEvidence(
      initialProgram,
      selection
    );

    const publicInterfaceProgram =
      !requirements.needsStandardLibrary &&
      initialEvidence !== undefined &&
      (await someAsync(
        requirements.focusedExportNames,
        async (exportName) =>
          await selectedExportNeedsStandardLibrary(
            initialProgram.getProject().checker,
            initialEvidence.moduleSymbol,
            exportName
          )
      ))
        ? await host.createProgram([declarationPath], true)
        : initialProgram;

    const initialSourceFile =
      await publicInterfaceProgram.getSourceFile(declarationPath);

    const initialModuleSymbol =
      selection.kind === "package" && initialSourceFile !== undefined
        ? await packageModuleSymbol(
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
        : await selectNodeDeclarationProgram(
            publicInterfaceProgram,
            initialModuleSymbol,
            initialSourceFile,
            async (): Promise<NodeProviderProgram | undefined> => {
              const nodeProvider =
                await selection.readNodeDeclarationProvider();

              if (nodeProvider === undefined) {
                return undefined;
              }

              host.allowPackageRoot(nodeProvider.root);

              return {
                program: await host.createProgram(
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

    return await inspectSelectedModule(program, selection, graph);
  };
