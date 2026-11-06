import nodePath from "node:path";

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
import { SymbolFlags } from "tsrs/sync";
import type { Checker, Program, Symbol as CompilerSymbol } from "tsrs/sync";

import { INSPECTION_BUDGET_POLICY } from "#typepeek/inspection/budget-policy";
import {
  aliasedSymbol,
  symbolAtLocation,
  symbolsAtLocations,
} from "#typepeek/inspection/compiler-queries";
import { declarationsOf } from "#typepeek/inspection/compiler-session";
import {
  InspectionLimitError,
  UnsupportedInspectionError,
} from "#typepeek/inspection/errors";
import type { InstalledProgramLoader } from "#typepeek/inspection/installed-program-loader";
import { bitwiseAnd } from "#typepeek/integer-bits";

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

const requiredProgramSourceFile = function requiredProgramSourceFile(
  program: Program,
  fileName: string,
  host: InstalledProgramLoader
): SourceFile {
  const sourceFile = host.findProgramSourceFile(program, fileName);

  if (sourceFile === undefined) {
    throw unresolvedDeclarationReference();
  }

  return sourceFile;
};

const resolvedTypeReferenceSourceFile =
  function resolvedTypeReferenceSourceFile(
    program: Program,
    containingFile: SourceFile,
    reference: FileReference,
    host: InstalledProgramLoader
  ): SourceFile {
    const resolvedFileName = host.resolveTypeReference(
      containingFile.fileName,
      reference
    );

    if (resolvedFileName === undefined) {
      throw unresolvedDeclarationReference();
    }

    return requiredProgramSourceFile(program, resolvedFileName, host);
  };

const referencedDeclarationSourceFiles =
  function referencedDeclarationSourceFiles(
    program: Program,
    declaration: Node,
    host: InstalledProgramLoader,
    traversal: DeclarationGraphTraversalState
  ): readonly SourceFile[] {
    if (!isSourceFile(declaration)) {
      return [];
    }

    reserveDeclarationGraphNodes(
      traversal,
      declaration.referencedFiles.length +
        declaration.typeReferenceDirectives.length
    );

    return [
      ...declaration.referencedFiles.map((reference) =>
        requiredProgramSourceFile(
          program,
          nodePath.resolve(
            nodePath.dirname(declaration.fileName),
            reference.fileName
          ),
          host
        )
      ),
      ...declaration.typeReferenceDirectives.map((reference) =>
        resolvedTypeReferenceSourceFile(program, declaration, reference, host)
      ),
    ];
  };

const enqueueReferencedDeclarationFiles =
  function enqueueReferencedDeclarationFiles(
    program: Program,
    host: InstalledProgramLoader,
    traversal: DeclarationGraphTraversalState,
    state: ReExportGraphState,
    sourceFile: SourceFile
  ): void {
    if (state.visitedReferenceSourceFiles.has(sourceFile.fileName)) {
      return;
    }

    state.visitedReferenceSourceFiles.add(sourceFile.fileName);
    state.pendingEntries.push(
      ...referencedDeclarationSourceFiles(
        program,
        sourceFile,
        host,
        traversal
      ).map((referenced): PendingDeclarationGraphEntry => ({
        declaration: referenced,
        expandSourceExports: true,
      }))
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

const resolvedModuleDeclarations = function resolvedModuleDeclarations(
  checker: Checker,
  moduleSpecifier: Expression
): readonly Node[] {
  const referencedModule = symbolAtLocation(checker, moduleSpecifier);

  if (referencedModule === undefined) {
    throw new UnsupportedInspectionError(UNRESOLVED_REEXPORT_MESSAGE);
  }

  const declarations = declarationsOf(referencedModule) ?? [];

  if (declarations.length === 0) {
    throw new UnsupportedInspectionError(UNRESOLVED_REEXPORT_MESSAGE);
  }

  return declarations;
};

const resolvedModuleSourceFiles = function resolvedModuleSourceFiles(
  checker: Checker,
  moduleSpecifier: Expression
): readonly SourceFile[] {
  return resolvedModuleDeclarations(checker, moduleSpecifier).filter(
    isSourceFile
  );
};

const reExportedStatementDeclarations =
  function reExportedStatementDeclarations(
    checker: Checker,
    statement: ExportDeclaration & {
      readonly moduleSpecifier: Expression;
    }
  ): readonly PendingDeclarationGraphEntry[] {
    if (
      statement.exportClause !== undefined &&
      isNamedExports(statement.exportClause)
    ) {
      return statement.exportClause.elements.flatMap((element) => {
        const symbol = checker.getSymbolAtLocation(element.name);

        const resolved =
          symbol !== undefined && bitwiseAnd(symbol.flags, SymbolFlags.Alias)
            ? aliasedSymbol(checker, symbol)
            : symbol;

        const declarations = declarationsOf(resolved) ?? [];

        if (declarations.length === 0) {
          throw unresolvedDeclarationReference();
        }

        return declarations.map(
          (declaration): PendingDeclarationGraphEntry => ({
            declaration,
            expandSourceExports: false,
          })
        );
      });
    }

    return resolvedModuleSourceFiles(checker, statement.moduleSpecifier).map(
      (declaration): PendingDeclarationGraphEntry => ({
        declaration,
        expandSourceExports: true,
      })
    );
  };

const reExportedDeclarations = function reExportedDeclarations(
  checker: Checker,
  sourceFile: SourceFile
): readonly PendingDeclarationGraphEntry[] {
  return sourceFile.statements
    .filter(hasModuleSpecifier)
    .flatMap((statement) =>
      reExportedStatementDeclarations(checker, statement)
    );
};

const expandReExportSource = function expandReExportSource(
  checker: Checker,
  traversal: DeclarationGraphTraversalState,
  state: ReExportGraphState,
  sourceFile: SourceFile
): void {
  if (state.visitedExpandedSourceFiles.has(sourceFile.fileName)) {
    return;
  }

  state.visitedExpandedSourceFiles.add(sourceFile.fileName);
  reserveDeclarationGraphNodes(traversal, sourceFile.statements.length);
  state.pendingEntries.push(...reExportedDeclarations(checker, sourceFile));
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

const inspectReExportGraphEntry = function inspectReExportGraphEntry(
  program: Program,
  checker: Checker,
  host: InstalledProgramLoader,
  traversal: DeclarationGraphTraversalState,
  state: ReExportGraphState,
  entry: PendingDeclarationGraphEntry
): void {
  const { declaration, expandSourceExports } = entry;

  if (visitedDeclarationEntry(state, declaration, expandSourceExports)) {
    return;
  }

  enqueueReferencedDeclarationFiles(
    program,
    host,
    traversal,
    state,
    declaration.getSourceFile()
  );

  if (isSourceFile(declaration) && expandSourceExports) {
    expandReExportSource(checker, traversal, state, declaration);

    return;
  }

  for (const specifier of descendantImportTypeSpecifiers(
    declaration,
    traversal
  )) {
    resolvedModuleDeclarations(checker, specifier);
  }
};

const assertResolvedReExportGraph = function assertResolvedReExportGraph(
  program: Program,
  checker: Checker,
  entrypoint: SourceFile,
  host: InstalledProgramLoader,
  traversal: DeclarationGraphTraversalState
): void {
  const state: ReExportGraphState = {
    pendingEntries: [{ declaration: entrypoint, expandSourceExports: true }],
    visitedDeclarations: new Set(),
    visitedExpandedSourceFiles: new Set(),
    visitedReferenceSourceFiles: new Set(),
  };

  for (const entry of state.pendingEntries) {
    inspectReExportGraphEntry(program, checker, host, traversal, state, entry);
  }
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
  function assertResolvedAmbientModuleReExports(
    program: Program,
    checker: Checker,
    moduleSymbol: CompilerSymbol,
    host: InstalledProgramLoader,
    traversal: DeclarationGraphTraversalState
  ): void {
    const pendingDeclarations: Node[] = (
      declarationsOf(moduleSymbol) ?? []
    ).filter(isModuleDeclaration);

    const visitedDeclarations = new Set<Node>();

    for (const declaration of pendingDeclarations) {
      if (visitedDeclarations.has(declaration)) {
        continue;
      }

      visitedDeclarations.add(declaration);
      const specifiers = ambientReExportSpecifiers(declaration, traversal);
      symbolsAtLocations(checker, specifiers);

      pendingDeclarations.push(
        ...specifiers.flatMap((specifier) =>
          resolvedModuleDeclarations(checker, specifier)
        ),
        ...referencedDeclarationSourceFiles(
          program,
          declaration,
          host,
          traversal
        )
      );
    }
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

  assertSourceResolved(
    program: Program,
    checker: Checker,
    entrypoint: SourceFile
  ): void {
    assertResolvedReExportGraph(
      program,
      checker,
      entrypoint,
      this.host,
      this.traversal
    );
  }

  assertAmbientModuleResolved(
    program: Program,
    checker: Checker,
    moduleSymbol: CompilerSymbol
  ): void {
    assertResolvedAmbientModuleReExports(
      program,
      checker,
      moduleSymbol,
      this.host,
      this.traversal
    );
  }
}
