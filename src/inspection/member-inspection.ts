import ts from "@typescript/typescript6";

import { assertMergedDeclarationLimit } from "#typepeek/inspection/declaration-limits";
import {
  isPrivateDeclaration,
  publicDeclarations,
} from "#typepeek/inspection/public-declaration-projection";

export type PublicMemberPathResolution =
  | { readonly status: "success"; readonly symbol: ts.Symbol }
  | { readonly status: "ambiguous-member" | "member-not-found" };

/** Resolves only exact names in the type, value, and namespace declaration spaces. */
export function resolvePublicMemberPath(
  checker: ts.TypeChecker,
  root: ts.Symbol,
  memberPath: readonly string[],
): PublicMemberPathResolution {
  let selected = root;
  for (const memberName of memberPath) {
    publicMemberDeclarations(checker, selected);
    const members = publicMemberCandidates(checker, selected, memberName).filter((candidate) =>
      hasPublicDeclaration(checker, candidate),
    );
    const member = members[0];
    if (member === undefined || members.length !== 1) {
      return { status: member === undefined ? "member-not-found" : "ambiguous-member" };
    }
    selected = resolveAliasTarget(checker, member);
  }
  return { status: "success", symbol: selected };
}

function publicMemberCandidates(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  memberName: string,
): readonly ts.Symbol[] {
  const candidates = [
    moduleMemberCandidate(symbol, memberName),
    typeMemberCandidate(checker, symbol, memberName),
    valueMemberCandidate(checker, symbol, memberName),
  ].filter((candidate): candidate is ts.Symbol => candidate !== undefined);
  return [...new Set(candidates)];
}

function moduleMemberCandidate(symbol: ts.Symbol, memberName: string): ts.Symbol | undefined {
  return (symbol.flags & ts.SymbolFlags.Module) === 0
    ? undefined
    : symbol.exports?.get(ts.escapeLeadingUnderscores(memberName));
}

function typeMemberCandidate(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  memberName: string,
): ts.Symbol | undefined {
  if ((symbol.flags & ts.SymbolFlags.Type) !== 0) {
    return checker.getDeclaredTypeOfSymbol(symbol).getProperty(memberName);
  }
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  return declaration === undefined
    ? undefined
    : checker.getTypeOfSymbolAtLocation(symbol, declaration).getProperty(memberName);
}

function valueMemberCandidate(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  memberName: string,
): ts.Symbol | undefined {
  const declaration = symbol.valueDeclaration;
  return declaration === undefined
    ? undefined
    : checker.getTypeOfSymbolAtLocation(symbol, declaration).getProperty(memberName);
}

function hasPublicDeclaration(checker: ts.TypeChecker, symbol: ts.Symbol): boolean {
  return publicMemberDeclarations(checker, symbol).length > 0;
}

/** Selects caller-accessible declarations and applies the shared merge bound. */
export function publicMemberDeclarations(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
): readonly ts.Declaration[] {
  const declarations = publicDeclarations(checker, symbol.declarations ?? []);
  assertMergedDeclarationLimit(declarations);
  return declarations.filter(isCallerAccessibleMemberDeclaration);
}

function isCallerAccessibleMemberDeclaration(declaration: ts.Declaration): boolean {
  if (isPrivateDeclaration(declaration)) {
    return false;
  }
  return (
    !ts.canHaveModifiers(declaration) ||
    !ts
      .getModifiers(declaration)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ProtectedKeyword)
  );
}

function resolveAliasTarget(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return (symbol.flags & ts.SymbolFlags.Alias) === 0 ? symbol : checker.getAliasedSymbol(symbol);
}
