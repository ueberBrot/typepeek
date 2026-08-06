import ts from "@typescript/typescript6";
import { relative, sep } from "node:path";

import { InspectionLimitError, UnsupportedInspectionError } from "#typepeek/inspection/errors";
import {
  resolveDeclarationOwner,
  type PackageModuleEvidence,
} from "#typepeek/inspection/package-evidence";
import { isPathWithin } from "#typepeek/inspection/paths";
import type { DeclarationKind, InspectedDeclaration } from "#typepeek/inspection/protocol";

const MAX_DECLARATIONS_PER_SYMBOL = 128;
const MAX_DECLARATION_BYTES = 64 * 1_024;

const DECLARATION_KIND_BY_SYNTAX_KIND = new Map<ts.SyntaxKind, DeclarationKind>([
  [ts.SyntaxKind.ClassDeclaration, "class"],
  [ts.SyntaxKind.EnumDeclaration, "enum"],
  [ts.SyntaxKind.FunctionDeclaration, "function"],
  [ts.SyntaxKind.InterfaceDeclaration, "interface"],
  [ts.SyntaxKind.ModuleDeclaration, "namespace"],
  [ts.SyntaxKind.TypeAliasDeclaration, "type-alias"],
  [ts.SyntaxKind.VariableDeclaration, "variable"],
  [ts.SyntaxKind.ExportAssignment, "alias"],
  [ts.SyntaxKind.ExportSpecifier, "alias"],
  [ts.SyntaxKind.ImportEqualsDeclaration, "alias"],
  [ts.SyntaxKind.NamespaceExport, "alias"],
]);

const declarationPrinter = ts.createPrinter({
  newLine: ts.NewLineKind.LineFeed,
  removeComments: true,
});

export type AliasDeclaration =
  | ts.ExportAssignment
  | ts.ExportSpecifier
  | ts.ImportEqualsDeclaration
  | ts.NamespaceExport;

export function inspectDeclaration(
  evidence: PackageModuleEvidence,
  declaration: ts.Declaration,
  kindOverride?: DeclarationKind,
): InspectedDeclaration {
  const sourceFile = declaration.getSourceFile();
  const start = sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile, false));
  const text = renderDeclaration(declaration, sourceFile);
  if (Buffer.byteLength(text) > MAX_DECLARATION_BYTES) {
    throw new InspectionLimitError("Inspection exceeded its declaration output limit.");
  }
  const kind = inspectedDeclarationKind(declaration, kindOverride);
  const owner = declarationOwner(evidence, sourceFile.fileName);
  return {
    kind,
    text,
    provenance: {
      packageIdentity: owner.packageIdentity,
      file: relative(owner.packageRoot, sourceFile.fileName).split(sep).join("/"),
      line: start.line + 1,
      column: start.character + 1,
    },
  };
}

export function inspectableDeclarations(symbol: ts.Symbol): readonly ts.Declaration[] {
  const declarations = (symbol.declarations ?? []).filter(
    (declaration) => declarationKind(declaration) !== undefined,
  );
  assertDeclarationLimit(declarations);
  return declarations;
}

export function assertDeclarationLimit(declarations: readonly ts.Declaration[]): void {
  if (declarations.length > MAX_DECLARATIONS_PER_SYMBOL) {
    throw new InspectionLimitError("Inspection exceeded its declaration merge limit.");
  }
}

export function declarationKind(declaration: ts.Declaration): DeclarationKind | undefined {
  return DECLARATION_KIND_BY_SYNTAX_KIND.get(declaration.kind);
}

export function isAliasDeclaration(declaration: ts.Declaration): declaration is AliasDeclaration {
  return DECLARATION_KIND_BY_SYNTAX_KIND.get(declaration.kind) === "alias";
}

export function isPrivateDeclaration(node: ts.Node): boolean {
  return (
    hasPrivateIdentifier(node) ||
    (hasPrivateModifier(node) && !isConstructorParameterProperty(node))
  );
}

function inspectedDeclarationKind(
  declaration: ts.Declaration,
  kindOverride: DeclarationKind | undefined,
): DeclarationKind {
  const kind = kindOverride ?? declarationKind(declaration);
  if (kind === undefined) {
    throw new UnsupportedInspectionError(
      "The selected Module Export contains an unsupported declaration kind.",
    );
  }
  return kind;
}

function declarationOwner(
  evidence: PackageModuleEvidence,
  declarationPath: string,
): PackageModuleEvidence | ReturnType<typeof resolveDeclarationOwner> {
  return isPathWithin(evidence.packageRoot, declarationPath)
    ? evidence
    : resolveDeclarationOwner(declarationPath);
}

function renderDeclaration(declaration: ts.Declaration, sourceFile: ts.SourceFile): string {
  const printableDeclaration = ts.isNamespaceExport(declaration) ? declaration.parent : declaration;
  return declarationPrinter
    .printNode(ts.EmitHint.Unspecified, publicDeclaration(printableDeclaration), sourceFile)
    .trim()
    .replace(/^(?:export\s+)?(?:declare\s+)?/u, "");
}

function publicDeclaration(declaration: ts.Declaration): ts.Declaration {
  return ts.isClassDeclaration(declaration)
    ? ts.factory.updateClassDeclaration(
        declaration,
        declaration.modifiers,
        declaration.name,
        declaration.typeParameters,
        declaration.heritageClauses,
        declaration.members
          .filter((member) => !isPrivateDeclaration(member))
          .map(publicClassElement),
      )
    : declaration;
}

function publicClassElement(member: ts.ClassElement): ts.ClassElement {
  return ts.isConstructorDeclaration(member)
    ? ts.factory.updateConstructorDeclaration(
        member,
        member.modifiers,
        member.parameters.map(publicConstructorParameter),
        member.body,
      )
    : member;
}

function publicConstructorParameter(parameter: ts.ParameterDeclaration): ts.ParameterDeclaration {
  if (!hasPrivateModifier(parameter)) {
    return parameter;
  }
  return ts.factory.updateParameterDeclaration(
    parameter,
    parameter.modifiers?.filter(({ kind }) => !isParameterPropertyModifier(kind)),
    parameter.dotDotDotToken,
    parameter.name,
    parameter.questionToken,
    parameter.type,
    parameter.initializer,
  );
}

function isParameterPropertyModifier(kind: ts.SyntaxKind): boolean {
  return [
    ts.SyntaxKind.PrivateKeyword,
    ts.SyntaxKind.ProtectedKeyword,
    ts.SyntaxKind.PublicKeyword,
    ts.SyntaxKind.ReadonlyKeyword,
    ts.SyntaxKind.OverrideKeyword,
  ].includes(kind);
}

function isConstructorParameterProperty(node: ts.Node): node is ts.ParameterDeclaration {
  return ts.isParameter(node) && ts.isConstructorDeclaration(node.parent);
}

function hasPrivateIdentifier(node: ts.Node): boolean {
  const name = "name" in node ? (node.name as ts.Node | undefined) : undefined;
  return name === undefined ? false : ts.isPrivateIdentifier(name);
}

function hasPrivateModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) {
    return false;
  }
  return (ts.getModifiers(node) ?? []).some(({ kind }) => kind === ts.SyntaxKind.PrivateKeyword);
}
