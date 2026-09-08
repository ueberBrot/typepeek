import ts from "@typescript/typescript6";

import { MAX_MEMBER_MATCHES } from "#typepeek/inspection/budget-policy";
import { assertMergedDeclarationLimit } from "#typepeek/inspection/declaration-limits";
import {
  isPrivateDeclaration,
  publicDeclarations,
} from "#typepeek/inspection/declaration-projection";
import { InspectionLimitError, UnsupportedInspectionError } from "#typepeek/inspection/errors";
import { MAX_MEMBER_PATH_SEGMENT_BYTES, type MemberPath } from "#typepeek/inspection/member-path";
import type { DeclarationSpace } from "#typepeek/inspection/protocol";
import type { InspectionResultConstruction } from "#typepeek/inspection/result-construction";

export type PublicMemberPathResolution =
  | { readonly status: "success"; readonly symbol: ts.Symbol }
  | { readonly status: "ambiguous-member" | "member-not-found" };

/** Resolves only exact names in the type, value, and namespace declaration spaces. */
export function resolvePublicMemberPath(
  checker: ts.TypeChecker,
  root: ts.Symbol,
  memberPath: MemberPath,
): PublicMemberPathResolution {
  let selected = root;
  for (const segment of memberPath) {
    const memberName = typeof segment === "string" ? segment : segment.name;
    const space = typeof segment === "string" ? undefined : segment.space;
    publicMemberDeclarations(checker, selected);
    const members = publicMemberCandidates(checker, selected, memberName, space).filter(
      (candidate) => hasPublicDeclaration(checker, candidate),
    );
    const member = members[0];
    if (member === undefined || members.length !== 1) {
      return { status: member === undefined ? "member-not-found" : "ambiguous-member" };
    }
    selected = resolveAliasTarget(checker, member);
  }
  return { status: "success", symbol: selected };
}

const MEMBER_SPACES = ["type", "value", "namespace"] as const;

/** Lists immediate caller-accessible names without projecting their declarations. */
export function discoverPublicMembers(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  query: string | undefined,
  construction: InspectionResultConstruction,
): {
  readonly totalMembers: number;
  readonly members: readonly {
    readonly name: string;
    readonly spaces: readonly DeclarationSpace[];
  }[];
} {
  publicMemberDeclarations(checker, symbol);
  const names = new Map<string, DeclarationSpace[]>();
  for (const space of MEMBER_SPACES) {
    const candidates = membersInSpace(checker, symbol, space);
    construction.consumeMemberCandidates(candidates.length);
    for (const candidate of candidates) {
      if (!hasPublicDeclaration(checker, candidate)) {
        continue;
      }
      const name = candidate.getName();
      if (
        name.length === 0 ||
        Buffer.byteLength(name) > MAX_MEMBER_PATH_SEGMENT_BYTES ||
        candidate.escapedName !== ts.escapeLeadingUnderscores(name)
      ) {
        throw new UnsupportedInspectionError(
          "Member Discovery found a public name without a bounded exact selector.",
        );
      }
      const spaces = names.get(name) ?? [];
      spaces.push(space);
      names.set(name, spaces);
    }
  }
  const normalizedQuery = query?.toLowerCase();
  const members = [...names]
    .filter(
      ([name]) => normalizedQuery === undefined || name.toLowerCase().includes(normalizedQuery),
    )
    .map(([name, spaces]) => ({ name, spaces }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  if (members.length > MAX_MEMBER_MATCHES) {
    throw new InspectionLimitError("member-matches", "Inspection exceeded its Member match limit.");
  }
  return { totalMembers: names.size, members };
}

function publicMemberCandidates(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  memberName: string,
  space: DeclarationSpace | undefined,
): readonly ts.Symbol[] {
  const spaces = space === undefined ? MEMBER_SPACES : [space];
  const candidates = spaces
    .map((selectedSpace) => memberInSpace(checker, symbol, memberName, selectedSpace))
    .filter((candidate): candidate is ts.Symbol => candidate !== undefined);
  return [...new Set(candidates)];
}

function memberInSpace(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  name: string,
  space: DeclarationSpace,
): ts.Symbol | undefined {
  if (space === "namespace") {
    return (symbol.flags & ts.SymbolFlags.Module) === 0
      ? undefined
      : symbol.exports?.get(ts.escapeLeadingUnderscores(name));
  }
  return memberType(checker, symbol, space)?.getProperty(name);
}

function membersInSpace(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  space: DeclarationSpace,
): readonly ts.Symbol[] {
  if (space === "namespace") {
    return (symbol.flags & ts.SymbolFlags.Module) === 0
      ? []
      : [...(symbol.exports?.values() ?? [])];
  }
  return memberType(checker, symbol, space)?.getProperties() ?? [];
}

function memberType(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  space: "type" | "value",
): ts.Type | undefined {
  if (space === "type") {
    return (symbol.flags & ts.SymbolFlags.Type) === 0
      ? undefined
      : checker.getDeclaredTypeOfSymbol(symbol);
  }
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  return declaration === undefined
    ? undefined
    : checker.getTypeOfSymbolAtLocation(symbol, declaration);
}

function hasPublicDeclaration(checker: ts.TypeChecker, symbol: ts.Symbol): boolean {
  return publicMemberDeclarations(checker, resolveAliasTarget(checker, symbol)).length > 0;
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
