import {
  isExportDeclaration,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isModuleBlock,
  isModuleDeclaration,
  isSourceFile,
  isStringLiteralLikeNode,
} from "tsrs/ast";
import type { Declaration, Node, SourceFile } from "tsrs/ast";
import { SymbolFlags } from "tsrs/sync";
import type { Checker, Program, Symbol as CompilerSymbol } from "tsrs/sync";

import { symbolAtLocation } from "#typepeek/inspection/compiler-queries";
import { declarationsOf } from "#typepeek/inspection/compiler-session";
import { DeclarationReferenceAuthority } from "#typepeek/inspection/declaration-reference-authority";
import type { NodeProviderProgram } from "#typepeek/inspection/declaration-reference-authority";
import { InspectionLimitError } from "#typepeek/inspection/errors";
import { InferredReferenceScanner } from "#typepeek/inspection/inferred-reference-scan";
import {
  isPublicProjectionChild,
  publicDeclarations,
  selectPublicStatements,
} from "#typepeek/inspection/public-declaration-selection";
import { bitwiseAnd } from "#typepeek/integer-bits";

const MAX_DECLARATION_GRAPH_DEPTH = 256;

const reserveDeclarationGraphNode = function reserveDeclarationGraphNode(
  reserveTraversalNode: () => void,
  depth: number
): void {
  reserveTraversalNode();

  if (depth > MAX_DECLARATION_GRAPH_DEPTH) {
    throw new InspectionLimitError(
      "declaration-graph",
      "Inspection exceeded its declaration graph traversal limit."
    );
  }
};

const enclosingModuleReference = function enclosingModuleReference(
  declaration: Declaration
): Node | undefined {
  let current: Node = declaration;

  while (!isSourceFile(current)) {
    if (
      isImportDeclaration(current) ||
      isImportEqualsDeclaration(current) ||
      isExportDeclaration(current)
    ) {
      return current;
    }

    current = current.parent;
  }

  return undefined;
};

const enqueueSymbolDeclarations = function enqueueSymbolDeclarations(
  checker: Checker,
  symbol: CompilerSymbol | undefined,
  pendingSymbols: CompilerSymbol[],
  pendingNodes: Node[],
  visitedSymbols: Set<CompilerSymbol>
): void {
  if (symbol === undefined || visitedSymbols.has(symbol)) {
    return;
  }

  visitedSymbols.add(symbol);

  const resolved = bitwiseAnd(symbol.flags, SymbolFlags.Alias)
    ? checker.getAliasedSymbol(symbol)
    : symbol;

  if (resolved !== symbol && !visitedSymbols.has(resolved)) {
    pendingSymbols.push(resolved);
  }

  for (const declaration of publicDeclarations(
    checker,
    declarationsOf(symbol) ?? []
  )) {
    pendingNodes.push(declaration);
    const moduleReference = enclosingModuleReference(declaration);

    if (moduleReference !== undefined) {
      pendingNodes.push(moduleReference);
    }
  }
};

const enqueueModuleExports = function enqueueModuleExports(
  checker: Checker,
  node: Node,
  pendingNodes: Node[],
  pendingSymbols: CompilerSymbol[],
  selectedExportNames: ReadonlySet<string> | undefined
): void {
  if (!isModuleDeclaration(node)) {
    return;
  }

  const symbol = symbolAtLocation(checker, node.name);

  const nestedExportNames = isStringLiteralLikeNode(node.name)
    ? selectedExportNames
    : undefined;

  if (symbol !== undefined) {
    const exports = checker.getExportsOfModule(symbol);
    pendingSymbols.push(
      ...(nestedExportNames === undefined
        ? exports
        : exports.filter((exportSymbol) =>
            nestedExportNames.has(exportSymbol.name)
          ))
    );
  }

  const { body } = node;

  if (
    body !== undefined &&
    isModuleBlock(body) &&
    nestedExportNames === undefined
  ) {
    pendingNodes.push(...selectPublicStatements(checker, body));
  }
};

const scanPublicDeclaration = function scanPublicDeclaration(options: {
  readonly authority: DeclarationReferenceAuthority;
  readonly inference: InferredReferenceScanner;
  readonly checker: Checker;
  readonly pendingNodes: Node[];
  readonly pendingSymbols: CompilerSymbol[];
  readonly reserveTraversalNode: () => void;
  readonly root: Node;
  readonly selectedExportNames: ReadonlySet<string> | undefined;
}): void {
  const nodes: { readonly node: Node; readonly depth: number }[] = [];

  const visit = (node: Node, depth: number): void => {
    reserveDeclarationGraphNode(options.reserveTraversalNode, depth);

    nodes.push({ depth, node });
    node.forEachChild((child) => {
      if (isPublicProjectionChild(options.checker, node, child)) {
        visit(child, depth + 1);
      }
    });
  };

  if (isSourceFile(options.root)) {
    options.reserveTraversalNode();

    options.authority.inspectNode(options.root);

    return;
  }

  visit(options.root, 0);
  options.authority.prefetch(nodes.map(({ node }) => node));

  for (const { node, depth } of nodes) {
    const symbol = options.authority.inspectNode(node);

    if (symbol !== undefined) {
      options.pendingSymbols.push(symbol);
    }

    options.inference.inspectNode(node, depth);

    enqueueModuleExports(
      options.checker,
      node,
      options.pendingNodes,
      options.pendingSymbols,
      options.selectedExportNames
    );
  }
};

const inspectInitialPublicInterface = function inspectInitialPublicInterface(
  program: Program,
  moduleSymbol: CompilerSymbol,
  entrypoint: SourceFile,
  reserveTraversalNode: () => void,
  selectedExportNames: ReadonlySet<string> | undefined
): DeclarationReferenceAuthority {
  const { checker } = program.getProject();

  const authority = new DeclarationReferenceAuthority(
    checker,
    reserveTraversalNode
  );

  const inference = new InferredReferenceScanner(
    checker,
    authority,
    (depth) => {
      reserveDeclarationGraphNode(reserveTraversalNode, depth);
    }
  );

  const moduleExports = checker.getExportsOfModule(moduleSymbol);

  const pendingSymbols =
    selectedExportNames === undefined
      ? [...moduleExports]
      : moduleExports.filter((symbol) => selectedExportNames.has(symbol.name));

  const pendingNodes: Node[] = [
    ...(selectedExportNames === undefined
      ? selectPublicStatements(checker, entrypoint)
      : []),
    ...(declarationsOf(moduleSymbol) ?? []).filter(isModuleDeclaration),
    entrypoint,
  ];

  const visitedSymbols = new Set<CompilerSymbol>();
  const visitedNodes = new Set<Node>();
  let pendingSymbolIndex = 0;
  let pendingNodeIndex = 0;

  while (
    pendingSymbolIndex < pendingSymbols.length ||
    pendingNodeIndex < pendingNodes.length
  ) {
    if (pendingSymbolIndex < pendingSymbols.length) {
      const pendingSymbol = pendingSymbols[pendingSymbolIndex];
      pendingSymbolIndex += 1;
      enqueueSymbolDeclarations(
        checker,
        pendingSymbol,
        pendingSymbols,
        pendingNodes,
        visitedSymbols
      );
    }

    const root = pendingNodes[pendingNodeIndex];

    if (pendingNodeIndex < pendingNodes.length) {
      pendingNodeIndex += 1;
    }

    if (root === undefined || visitedNodes.has(root)) {
      continue;
    }

    visitedNodes.add(root);
    scanPublicDeclaration({
      authority,
      checker,
      inference,
      pendingNodes,
      pendingSymbols,
      reserveTraversalNode,
      root,
      selectedExportNames,
    });
  }

  return authority;
};

/** Loads the visible Node Declaration Provider when the selected declarations reference it. */
export const selectNodeDeclarationProgram =
  function selectNodeDeclarationProgram(
    initialProgram: Program,
    initialModuleSymbol: CompilerSymbol,
    entrypoint: SourceFile,
    createProviderProgram: () => NodeProviderProgram | undefined,
    reserveTraversalNode: () => void,
    selectedExportNames?: ReadonlySet<string>
  ): Program | undefined {
    return inspectInitialPublicInterface(
      initialProgram,
      initialModuleSymbol,
      entrypoint,
      reserveTraversalNode,
      selectedExportNames
    ).selectProvider(createProviderProgram);
  };
