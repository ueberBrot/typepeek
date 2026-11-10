import {
  isBindingElement,
  isBlock,
  isComputedPropertyName,
  isFunctionDeclaration,
  isFunctionLikeDeclaration,
  isGetAccessorDeclaration,
  isMethodDeclaration,
  isModuleBlock,
  isModuleDeclaration,
  isParameterDeclaration,
  isPropertyDeclaration,
  isReturnStatement,
  isTypeNode,
  isVariableDeclaration,
} from "tsrs/ast";
import type {
  BindingElement,
  Block,
  ConciseBody,
  Declaration,
  Expression,
  FunctionDeclaration,
  GetAccessorDeclaration,
  MethodDeclaration,
  Node,
  ParameterDeclaration,
  PropertyDeclaration,
  TypeNode,
  VariableDeclaration,
} from "tsrs/ast";
import type { Checker } from "tsrs/sync";

import type { DeclarationReferenceAuthority } from "#typepeek/inspection/projection/declaration-reference-authority";
import {
  isPublicProjectionChild,
  selectPublicStatements,
} from "#typepeek/inspection/projection/public-declaration-selection";

interface InferenceScanState {
  readonly visitedDeclarations: Set<Declaration>;
}

type InferredInitializerDeclaration =
  | BindingElement
  | ParameterDeclaration
  | PropertyDeclaration
  | VariableDeclaration;

const hasInferredInitializerType = function hasInferredInitializerType(
  node: Node
): node is InferredInitializerDeclaration {
  if (isBindingElement(node)) {
    return true;
  }

  return (
    (isVariableDeclaration(node) ||
      isPropertyDeclaration(node) ||
      isParameterDeclaration(node)) &&
    node.type === undefined
  );
};

const hasInferredPublicReturn = function hasInferredPublicReturn(
  node: Node
): node is (
  | FunctionDeclaration
  | GetAccessorDeclaration
  | MethodDeclaration
) & {
  readonly body: Block;
} {
  if (
    !(
      isFunctionDeclaration(node) ||
      isMethodDeclaration(node) ||
      isGetAccessorDeclaration(node)
    )
  ) {
    return false;
  }

  if (node.type !== undefined) {
    return false;
  }

  return node.body !== undefined;
};

/** Scans dependencies of inferred Public Interface types without exposing traversal state. */
export class InferredReferenceScanner {
  private readonly checker: Checker;
  private readonly authority: DeclarationReferenceAuthority;
  private readonly reserveTraversal: (depth: number) => void;

  constructor(
    checker: Checker,
    authority: DeclarationReferenceAuthority,
    reserveTraversal: (depth: number) => void
  ) {
    this.checker = checker;
    this.authority = authority;
    this.reserveTraversal = reserveTraversal;
  }

  inspectNode(node: Node, depth: number): void {
    this.inspectInferredPublicNode(node, depth, {
      visitedDeclarations: new Set(),
    });

    if (isComputedPropertyName(node)) {
      this.authority.recordComputedName(node.expression);
      this.scanInferenceExpression(node.expression, depth + 1, {
        visitedDeclarations: new Set(),
      });
    }
  }

  private inspectInferredPublicNode(
    node: Node,
    depth: number,
    state: InferenceScanState
  ): void {
    if (hasInferredInitializerType(node) && node.initializer !== undefined) {
      this.scanInferenceExpression(node.initializer, depth + 1, state);
    }

    if (hasInferredPublicReturn(node)) {
      this.scanInferredFunctionBody(node.body, depth + 1, state);
    }
  }
  private scanInferenceDeclaration(
    declaration: Declaration,
    depth: number,
    state: InferenceScanState
  ): void {
    if (state.visitedDeclarations.has(declaration)) {
      return;
    }

    state.visitedDeclarations.add(declaration);
    this.reserveTraversal(depth);
    this.scanInferenceDeclarationSyntax(declaration, depth + 1, state);
  }
  private scanInferenceDeclarationSyntax(
    declaration: Declaration,
    depth: number,
    state: InferenceScanState
  ): void {
    const visit = (node: Node, currentDepth: number): void => {
      this.reserveTraversal(currentDepth);
      this.inspectInferredPublicNode(node, currentDepth, state);

      if (isTypeNode(node)) {
        this.scanInferenceTypeNode(node, currentDepth + 1, state);

        return;
      }

      if (isModuleDeclaration(node)) {
        const { body } = node;

        if (body !== undefined && isModuleBlock(body)) {
          for (const statement of selectPublicStatements(this.checker, body)) {
            visit(statement, currentDepth + 1);
          }
        }

        return;
      }

      node.forEachChild((child) => {
        if (isPublicProjectionChild(this.checker, node, child)) {
          visit(child, currentDepth + 1);
        }
      });
    };

    visit(declaration, depth);
  }
  private scanInferenceExpression(
    expression: Expression,
    depth: number,
    state: InferenceScanState
  ): void {
    const visit = (node: Node, currentDepth: number): void => {
      this.reserveTraversal(currentDepth);

      if (isTypeNode(node)) {
        this.scanInferenceTypeNode(node, currentDepth + 1, state);

        return;
      }

      if (isComputedPropertyName(node)) {
        this.authority.recordComputedName(node.expression);
        this.scanInferenceExpression(node.expression, currentDepth + 1, state);

        return;
      }

      if (
        isFunctionLikeDeclaration(node) &&
        "body" in node &&
        node.body !== undefined
      ) {
        this.scanInferredFunctionBody(node.body, currentDepth + 1, state);

        return;
      }

      for (const declaration of this.authority.inspectValueNode(node)) {
        this.scanInferenceDeclaration(declaration, currentDepth + 1, state);
      }

      node.forEachChild((child) => {
        visit(child, currentDepth + 1);
      });
    };

    visit(expression, depth);
  }
  private scanInferenceTypeNode(
    typeNode: TypeNode,
    depth: number,
    state: InferenceScanState
  ): void {
    const visit = (node: Node, currentDepth: number): void => {
      this.reserveTraversal(currentDepth);

      for (const declaration of this.authority.inspectTypeNode(node)) {
        this.scanInferenceDeclaration(declaration, currentDepth + 1, state);
      }

      node.forEachChild((child) => {
        visit(child, currentDepth + 1);
      });
    };

    visit(typeNode, depth);
  }
  private scanInferredFunctionBody(
    body: ConciseBody,
    depth: number,
    state: InferenceScanState
  ): void {
    if (!isBlock(body)) {
      this.scanInferenceExpression(body, depth, state);

      return;
    }

    const visit = (node: Node, currentDepth: number): void => {
      this.reserveTraversal(currentDepth);

      if (isFunctionLikeDeclaration(node) && node !== body.parent) {
        return;
      }

      if (isReturnStatement(node) && node.expression !== undefined) {
        this.scanInferenceExpression(node.expression, currentDepth + 1, state);

        return;
      }

      node.forEachChild((child) => {
        visit(child, currentDepth + 1);
      });
    };

    visit(body, depth);
  }
}
