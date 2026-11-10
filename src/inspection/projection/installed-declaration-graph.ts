import {
  isExportDeclaration,
  isExternalModuleReference,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportTypeNode,
  isLiteralTypeNode,
  isModuleBlock,
  isModuleDeclaration,
  isNamedExports,
  isSourceFile,
  isStringLiteralLikeNode,
} from "tsrs/ast";
import type {
  ExportDeclaration,
  Expression,
  FileReference,
  ImportEqualsDeclaration,
  Node,
  SourceFile,
  Statement,
} from "tsrs/ast";
import { SymbolFlags } from "tsrs/async";
import type { Checker, Program, Symbol as CompilerSymbol } from "tsrs/async";

import {
  aliasedSymbol,
  symbolAtLocation,
  symbolsAtLocations,
} from "#typepeek/inspection/compiler/compiler-queries";
import { declarationsOf } from "#typepeek/inspection/compiler/compiler-session";
import type { InstalledProgramLoader } from "#typepeek/inspection/compiler/installed-program-loader";
import { INSPECTION_BUDGET_POLICY } from "#typepeek/inspection/model/budget-policy";
import {
  InspectionLimitError,
  UnsupportedInspectionError,
} from "#typepeek/inspection/model/errors";
import { platformPath as nodePath } from "#typepeek/platform/platform-path";
import { mapAsync } from "#typepeek/shared/async-collection";
import { bitwiseAnd } from "#typepeek/shared/integer-bits";

const UNRESOLVED_REEXPORT_MESSAGE =
  "A declaration re-export could not be resolved from Installed Evidence.";

const MAX_DECLARATION_GRAPH_DEPTH = 256;

interface DeclarationGraphTraversalState {
  nodeCount: number;
}

interface PendingDeclarationGraphEntry {
  readonly declaration: Node;
  readonly expandSourceExports: boolean;
}

interface ReExportGraphState {
  readonly pendingEntries: PendingDeclarationGraphEntry[];
  readonly visitedDeclarations: Set<Node>;
  readonly visitedExpandedSourceFiles: Set<string>;
  readonly visitedReferenceSourceFiles: Set<string>;
}

const reserveDeclarationGraphNodes = function reserveDeclarationGraphNodes(
  traversal: DeclarationGraphTraversalState,
  count: number
): void {
  traversal.nodeCount += count;

  if (traversal.nodeCount > INSPECTION_BUDGET_POLICY.declarationGraphNodes) {
    throw new InspectionLimitError(
      "declaration-graph",
      "Inspection exceeded its declaration graph traversal limit."
    );
  }
};

const visitedDeclarationEntry = function visitedDeclarationEntry(
  state: ReExportGraphState,
  declaration: Node,
  expandSourceExports: boolean
): boolean {
  const alreadyVisited = state.visitedDeclarations.has(declaration);
  state.visitedDeclarations.add(declaration);

  return alreadyVisited && (!isSourceFile(declaration) || !expandSourceExports);
};

const unresolvedDeclarationReference =
  function unresolvedDeclarationReference(): UnsupportedInspectionError {
    return new UnsupportedInspectionError(UNRESOLVED_REEXPORT_MESSAGE);
  };

const requiredProgramSourceFile = async function requiredProgramSourceFile(
  program: Program,
  fileName: string,
  host: InstalledProgramLoader
): Promise<SourceFile> {
  const sourceFile = await host.findProgramSourceFile(program, fileName);

  if (sourceFile === undefined) {
    throw unresolvedDeclarationReference();
  }

  return sourceFile;
};

const resolvedTypeReferenceSourceFile =
  async function resolvedTypeReferenceSourceFile(
    program: Program,
    containingFile: SourceFile,
    reference: FileReference,
    host: InstalledProgramLoader
  ): Promise<SourceFile> {
    const resolvedFileName = host.resolveTypeReference(
      containingFile.fileName,
      reference
    );

    if (resolvedFileName === undefined) {
      throw unresolvedDeclarationReference();
    }

    return await requiredProgramSourceFile(program, resolvedFileName, host);
  };

const referencedDeclarationSourceFiles =
  async function referencedDeclarationSourceFiles(
    program: Program,
    declaration: Node,
    host: InstalledProgramLoader,
    traversal: DeclarationGraphTraversalState
  ): Promise<readonly SourceFile[]> {
    if (!isSourceFile(declaration)) {
      return [];
    }

    reserveDeclarationGraphNodes(
      traversal,
      declaration.referencedFiles.length +
        declaration.typeReferenceDirectives.length
    );

    return [
      ...(await mapAsync(
        declaration.referencedFiles,
        async (reference) =>
          await requiredProgramSourceFile(
            program,
            nodePath.resolve(
              nodePath.dirname(declaration.fileName),
              reference.fileName
            ),
            host
          )
      )),
      ...(await mapAsync(
        declaration.typeReferenceDirectives,
        async (reference) =>
          await resolvedTypeReferenceSourceFile(
            program,
            declaration,
            reference,
            host
          )
      )),
    ];
  };

const enqueueReferencedDeclarationFiles =
  async function enqueueReferencedDeclarationFiles(
    program: Program,
    host: InstalledProgramLoader,
    traversal: DeclarationGraphTraversalState,
    state: ReExportGraphState,
    sourceFile: SourceFile
  ): Promise<void> {
    if (state.visitedReferenceSourceFiles.has(sourceFile.fileName)) {
      return;
    }

    state.visitedReferenceSourceFiles.add(sourceFile.fileName);

    const referencedDeclarationSourceFilesResult =
      await referencedDeclarationSourceFiles(
        program,
        sourceFile,
        host,
        traversal
      );

    state.pendingEntries.push(
      ...referencedDeclarationSourceFilesResult.map(
        (referenced): PendingDeclarationGraphEntry => ({
          declaration: referenced,
          expandSourceExports: true,
        })
      )
    );
  };

const hasModuleSpecifier = function hasModuleSpecifier(
  statement: Statement
): statement is ExportDeclaration & {
  readonly moduleSpecifier: Expression;
} {
  return (
    isExportDeclaration(statement) && statement.moduleSpecifier !== undefined
  );
};

const resolvedModuleDeclarations = async function resolvedModuleDeclarations(
  checker: Checker,
  moduleSpecifier: Expression
): Promise<readonly Node[]> {
  const referencedModule = await symbolAtLocation(checker, moduleSpecifier);

  if (referencedModule === undefined) {
    throw new UnsupportedInspectionError(UNRESOLVED_REEXPORT_MESSAGE);
  }

  const declarations = (await declarationsOf(referencedModule)) ?? [];

  if (declarations.length === 0) {
    throw new UnsupportedInspectionError(UNRESOLVED_REEXPORT_MESSAGE);
  }

  return declarations;
};

const resolvedModuleSourceFiles = async function resolvedModuleSourceFiles(
  checker: Checker,
  moduleSpecifier: Expression
): Promise<readonly SourceFile[]> {
  const resolvedModuleDeclarationsResult = await resolvedModuleDeclarations(
    checker,
    moduleSpecifier
  );

  return resolvedModuleDeclarationsResult.filter(isSourceFile);
};

const reExportedStatementDeclarations =
  async function reExportedStatementDeclarations(
    checker: Checker,
    statement: ExportDeclaration & {
      readonly moduleSpecifier: Expression;
    }
  ): Promise<readonly PendingDeclarationGraphEntry[]> {
    if (
      statement.exportClause !== undefined &&
      isNamedExports(statement.exportClause)
    ) {
      const mappedValues = await mapAsync(
        statement.exportClause.elements,
        async (element) => {
          const symbol = await checker.getSymbolAtLocation(element.name);

          const resolved =
            symbol !== undefined && bitwiseAnd(symbol.flags, SymbolFlags.Alias)
              ? await aliasedSymbol(checker, symbol)
              : symbol;

          const declarations = (await declarationsOf(resolved)) ?? [];

          if (declarations.length === 0) {
            throw unresolvedDeclarationReference();
          }

          return declarations.map(
            (declaration): PendingDeclarationGraphEntry => ({
              declaration,
              expandSourceExports: false,
            })
          );
        }
      );

      return mappedValues.flat();
    }

    const resolvedModuleSourceFilesResult = await resolvedModuleSourceFiles(
      checker,
      statement.moduleSpecifier
    );

    return resolvedModuleSourceFilesResult.map(
      (declaration): PendingDeclarationGraphEntry => ({
        declaration,
        expandSourceExports: true,
      })
    );
  };

const reExportedDeclarations = async function reExportedDeclarations(
  checker: Checker,
  sourceFile: SourceFile
): Promise<readonly PendingDeclarationGraphEntry[]> {
  const mappedValues = await mapAsync(
    sourceFile.statements.filter(hasModuleSpecifier),
    async (statement) =>
      await reExportedStatementDeclarations(checker, statement)
  );

  return mappedValues.flat();
};

const expandReExportSource = async function expandReExportSource(
  checker: Checker,
  traversal: DeclarationGraphTraversalState,
  state: ReExportGraphState,
  sourceFile: SourceFile
): Promise<void> {
  if (state.visitedExpandedSourceFiles.has(sourceFile.fileName)) {
    return;
  }

  state.visitedExpandedSourceFiles.add(sourceFile.fileName);
  reserveDeclarationGraphNodes(traversal, sourceFile.statements.length);
  state.pendingEntries.push(
    ...(await reExportedDeclarations(checker, sourceFile))
  );
};

const importTypeSpecifier = function importTypeSpecifier(
  node: Node
): Expression | undefined {
  if (!isImportTypeNode(node)) {
    return undefined;
  }

  if (!isLiteralTypeNode(node.argument)) {
    return undefined;
  }

  return isStringLiteralLikeNode(node.argument.literal)
    ? node.argument.literal
    : undefined;
};

const descendantImportTypeSpecifiers = function descendantImportTypeSpecifiers(
  root: Node,
  traversal: DeclarationGraphTraversalState
): readonly Expression[] {
  const specifiers: Expression[] = [];

  const visit = (node: Node, depth: number): void => {
    traversal.nodeCount += 1;

    if (
      depth > MAX_DECLARATION_GRAPH_DEPTH ||
      traversal.nodeCount > INSPECTION_BUDGET_POLICY.declarationGraphNodes
    ) {
      throw new InspectionLimitError(
        "declaration-graph",
        "Inspection exceeded its declaration graph traversal limit."
      );
    }

    const specifier = importTypeSpecifier(node);

    if (specifier !== undefined) {
      specifiers.push(specifier);
    }

    node.forEachChild((child) => {
      visit(child, depth + 1);
    });
  };

  visit(root, 0);

  return specifiers;
};

const inspectReExportGraphEntry = async function inspectReExportGraphEntry(
  program: Program,
  checker: Checker,
  host: InstalledProgramLoader,
  traversal: DeclarationGraphTraversalState,
  state: ReExportGraphState,
  entry: PendingDeclarationGraphEntry
): Promise<void> {
  const { declaration, expandSourceExports } = entry;

  if (visitedDeclarationEntry(state, declaration, expandSourceExports)) {
    return;
  }

  await enqueueReferencedDeclarationFiles(
    program,
    host,
    traversal,
    state,
    declaration.getSourceFile()
  );

  if (isSourceFile(declaration) && expandSourceExports) {
    await expandReExportSource(checker, traversal, state, declaration);

    return;
  }

  await mapAsync(
    descendantImportTypeSpecifiers(declaration, traversal),
    async (specifier) => {
      await resolvedModuleDeclarations(checker, specifier);
    }
  );
};

const assertResolvedReExportGraph = async function assertResolvedReExportGraph(
  program: Program,
  checker: Checker,
  entrypoint: SourceFile,
  host: InstalledProgramLoader,
  traversal: DeclarationGraphTraversalState
): Promise<void> {
  const state: ReExportGraphState = {
    pendingEntries: [{ declaration: entrypoint, expandSourceExports: true }],
    visitedDeclarations: new Set(),
    visitedExpandedSourceFiles: new Set(),
    visitedReferenceSourceFiles: new Set(),
  };

  await mapAsync(state.pendingEntries, async (entry) => {
    await inspectReExportGraphEntry(
      program,
      checker,
      host,
      traversal,
      state,
      entry
    );
  });
};

const moduleStatementTraversal = {
  moduleBodyStatements(declaration: Node): readonly Statement[] {
    if (isSourceFile(declaration)) {
      return declaration.statements;
    }

    return moduleStatementTraversal.moduleDeclarationStatements(declaration);
  },
  moduleDeclarationStatements(declaration: Node): readonly Statement[] {
    if (!isModuleDeclaration(declaration)) {
      return [];
    }

    const { body } = declaration;

    if (body === undefined) {
      return [];
    }

    return isModuleBlock(body)
      ? body.statements
      : moduleStatementTraversal.moduleBodyStatements(body);
  },
};

const externalImportSpecifier = function externalImportSpecifier(
  statement: ImportEqualsDeclaration
): Expression | undefined {
  return isExternalModuleReference(statement.moduleReference)
    ? statement.moduleReference.expression
    : undefined;
};

const externalImportEqualsSpecifiers = function externalImportEqualsSpecifiers(
  statement: ImportEqualsDeclaration
): readonly Expression[] {
  const specifier = externalImportSpecifier(statement);

  return specifier === undefined ? [] : [specifier];
};

const ambientModuleReferenceSpecifiers =
  function ambientModuleReferenceSpecifiers(
    statement: Statement
  ): readonly Expression[] {
    if (hasModuleSpecifier(statement)) {
      return [statement.moduleSpecifier];
    }

    if (isImportDeclaration(statement)) {
      return [statement.moduleSpecifier];
    }

    return isImportEqualsDeclaration(statement)
      ? externalImportEqualsSpecifiers(statement)
      : [];
  };

const ambientReExportSpecifiers = function ambientReExportSpecifiers(
  declaration: Node,
  traversal: DeclarationGraphTraversalState
): readonly Expression[] {
  const statements = moduleStatementTraversal.moduleBodyStatements(declaration);

  return [
    ...statements.flatMap(ambientModuleReferenceSpecifiers),
    ...statements.flatMap((statement) =>
      descendantImportTypeSpecifiers(statement, traversal)
    ),
  ];
};

const assertResolvedAmbientModuleReExports =
  async function assertResolvedAmbientModuleReExports(
    program: Program,
    checker: Checker,
    moduleSymbol: CompilerSymbol,
    host: InstalledProgramLoader,
    traversal: DeclarationGraphTraversalState
  ): Promise<void> {
    const pendingDeclarations: Node[] = (
      (await declarationsOf(moduleSymbol)) ?? []
    ).filter(isModuleDeclaration);

    const visitedDeclarations = new Set<Node>();

    /* oxlint-disable eslint/no-await-in-loop -- Compiler queries share inspection state and must retain serial traversal order. */
    for (const declaration of pendingDeclarations) {
      if (visitedDeclarations.has(declaration)) {
        continue;
      }

      visitedDeclarations.add(declaration);
      const specifiers = ambientReExportSpecifiers(declaration, traversal);
      await symbolsAtLocations(checker, specifiers);

      const mappedValues = await mapAsync(
        specifiers,
        async (specifier) =>
          await resolvedModuleDeclarations(checker, specifier)
      );

      pendingDeclarations.push(
        ...mappedValues.flat(),
        ...(await referencedDeclarationSourceFiles(
          program,
          declaration,
          host,
          traversal
        ))
      );
    }
    /* oxlint-enable eslint/no-await-in-loop */
  };

/** Owns declaration graph validation and its aggregate budget across one inspection. */
export class InstalledDeclarationGraph {
  private readonly host: InstalledProgramLoader;
  private readonly traversal: DeclarationGraphTraversalState = { nodeCount: 0 };

  constructor(host: InstalledProgramLoader) {
    this.host = host;
  }

  reserveTraversalNode(): void {
    reserveDeclarationGraphNodes(this.traversal, 1);
  }

  async assertSourceResolved(
    program: Program,
    checker: Checker,
    entrypoint: SourceFile
  ): Promise<void> {
    await assertResolvedReExportGraph(
      program,
      checker,
      entrypoint,
      this.host,
      this.traversal
    );
  }

  async assertAmbientModuleResolved(
    program: Program,
    checker: Checker,
    moduleSymbol: CompilerSymbol
  ): Promise<void> {
    await assertResolvedAmbientModuleReExports(
      program,
      checker,
      moduleSymbol,
      this.host,
      this.traversal
    );
  }
}
