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
import type { Checker } from "tsrs/async";

import { forEachChildAsync } from "#typepeek/inspection/compiler/compiler-traversal";
import type { DeclarationReferenceAuthority } from "#typepeek/inspection/projection/declaration-reference-authority";
import {
  isPublicProjectionChild,
  selectPublicStatements,
} from "#typepeek/inspection/projection/public-declaration-selection";
import { mapAsync } from "#typepeek/shared/async-collection";

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

  async inspectNode(node: Node, depth: number): Promise<void> {
    await this.inspectInferredPublicNode(node, depth, {
      visitedDeclarations: new Set(),
    });

    if (isComputedPropertyName(node)) {
      await this.authority.recordComputedName(node.expression);
      await this.scanInferenceExpression(node.expression, depth + 1, {
        visitedDeclarations: new Set(),
      });
    }
  }

  private async inspectInferredPublicNode(
    node: Node,
    depth: number,
    state: InferenceScanState
  ): Promise<void> {
    if (hasInferredInitializerType(node) && node.initializer !== undefined) {
      await this.scanInferenceExpression(node.initializer, depth + 1, state);
    }

    if (hasInferredPublicReturn(node)) {
      await this.scanInferredFunctionBody(node.body, depth + 1, state);
    }
  }
  private async scanInferenceDeclaration(
    declaration: Declaration,
    depth: number,
    state: InferenceScanState
  ): Promise<void> {
    if (state.visitedDeclarations.has(declaration)) {
      return;
    }

    state.visitedDeclarations.add(declaration);
    this.reserveTraversal(depth);
    await this.scanInferenceDeclarationSyntax(declaration, depth + 1, state);
  }
  private async scanInferenceDeclarationSyntax(
    declaration: Declaration,
    depth: number,
    state: InferenceScanState
  ): Promise<void> {
    const visit = async (node: Node, currentDepth: number): Promise<void> => {
      this.reserveTraversal(currentDepth);
      await this.inspectInferredPublicNode(node, currentDepth, state);

      if (isTypeNode(node)) {
        await this.scanInferenceTypeNode(node, currentDepth + 1, state);

        return;
      }

      if (isModuleDeclaration(node)) {
        const { body } = node;

        if (body !== undefined && isModuleBlock(body)) {
          await mapAsync(
            await selectPublicStatements(this.checker, body),
            async (statement) => {
              await visit(statement, currentDepth + 1);
            }
          );
        }

        return;
      }

      await forEachChildAsync(node, async (child) => {
        if (await isPublicProjectionChild(this.checker, node, child)) {
          await visit(child, currentDepth + 1);
        }
      });
    };

    await visit(declaration, depth);
  }
  private async scanInferenceExpression(
    expression: Expression,
    depth: number,
    state: InferenceScanState
  ): Promise<void> {
    const visit = async (node: Node, currentDepth: number): Promise<void> => {
      this.reserveTraversal(currentDepth);

      if (isTypeNode(node)) {
        await this.scanInferenceTypeNode(node, currentDepth + 1, state);

        return;
      }

      if (isComputedPropertyName(node)) {
        await this.authority.recordComputedName(node.expression);
        await this.scanInferenceExpression(
          node.expression,
          currentDepth + 1,
          state
        );

        return;
      }

      if (
        isFunctionLikeDeclaration(node) &&
        "body" in node &&
        node.body !== undefined
      ) {
        await this.scanInferredFunctionBody(node.body, currentDepth + 1, state);

        return;
      }

      await mapAsync(
        await this.authority.inspectValueNode(node),
        async (declaration) => {
          await this.scanInferenceDeclaration(
            declaration,
            currentDepth + 1,
            state
          );
        }
      );

      await forEachChildAsync(node, async (child) => {
        await visit(child, currentDepth + 1);
      });
    };

    await visit(expression, depth);
  }
  private async scanInferenceTypeNode(
    typeNode: TypeNode,
    depth: number,
    state: InferenceScanState
  ): Promise<void> {
    const visit = async (node: Node, currentDepth: number): Promise<void> => {
      this.reserveTraversal(currentDepth);

      await mapAsync(
        await this.authority.inspectTypeNode(node),
        async (declaration) => {
          await this.scanInferenceDeclaration(
            declaration,
            currentDepth + 1,
            state
          );
        }
      );

      await forEachChildAsync(node, async (child) => {
        await visit(child, currentDepth + 1);
      });
    };

    await visit(typeNode, depth);
  }
  private async scanInferredFunctionBody(
    body: ConciseBody,
    depth: number,
    state: InferenceScanState
  ): Promise<void> {
    if (!isBlock(body)) {
      await this.scanInferenceExpression(body, depth, state);

      return;
    }

    const visit = async (node: Node, currentDepth: number): Promise<void> => {
      this.reserveTraversal(currentDepth);

      if (isFunctionLikeDeclaration(node) && node !== body.parent) {
        return;
      }

      if (isReturnStatement(node) && node.expression !== undefined) {
        await this.scanInferenceExpression(
          node.expression,
          currentDepth + 1,
          state
        );

        return;
      }

      await forEachChildAsync(node, async (child) => {
        await visit(child, currentDepth + 1);
      });
    };

    await visit(body, depth);
  }
}
