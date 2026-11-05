import { Predicate } from "effect";
import {
  escapeLeadingUnderscores,
  InternalSymbolName,
  isExportDeclaration,
  SyntaxKind,
} from "tsrs/ast";
import type { Declaration } from "tsrs/ast";
import { SymbolFlags } from "tsrs/sync";
import type { Checker, Symbol as CompilerSymbol, Type } from "tsrs/sync";

import { MAX_MEMBER_MATCHES } from "#typepeek/inspection/budget-policy";
import { aliasedSymbol } from "#typepeek/inspection/compiler-queries";
import {
  declarationsOf,
  valueDeclarationOf,
} from "#typepeek/inspection/compiler-session";
import { modifiersOf } from "#typepeek/inspection/compiler-syntax";
import { assertMergedDeclarationLimit } from "#typepeek/inspection/declaration-limits";
import {
  InspectionLimitError,
  UnsupportedInspectionError,
} from "#typepeek/inspection/errors";
import type { MemberPath } from "#typepeek/inspection/member-path";
import {
  MAX_MEMBER_PATH_SEGMENT_BYTES,
  memberDeclarationSpaceSchema,
} from "#typepeek/inspection/member-path";
import type { DeclarationSpace } from "#typepeek/inspection/protocol";
import {
  isPrivateDeclaration,
  publicDeclarations,
} from "#typepeek/inspection/public-declaration-selection";
import type { InspectionResultConstruction } from "#typepeek/inspection/result-construction";
import { bitwiseAnd } from "#typepeek/integer-bits";

export interface DiscoveredPublicMembers {
  readonly totalMembers: number;
  readonly members: readonly {
    readonly name: string;
    readonly spaces: readonly DeclarationSpace[];
  }[];
}

export type PublicMemberPathResolution =
  | {
      readonly status: "success";
      readonly symbol: CompilerSymbol;
    }
  | {
      readonly status: "ambiguous-member" | "member-not-found";
    };

const isCallerAccessibleMemberDeclaration =
  function isCallerAccessibleMemberDeclaration(
    declaration: Declaration
  ): boolean {
    if (isPrivateDeclaration(declaration)) {
      return false;
    }

    return (
      modifiersOf(declaration) === undefined ||
      !(
        modifiersOf(declaration)?.some(
          (modifier) => modifier.kind === SyntaxKind.ProtectedKeyword
        ) ?? false
      )
    );
  };

export const publicMemberDeclarations = function publicMemberDeclarations(
  checker: Checker,
  symbol: CompilerSymbol
): readonly Declaration[] {
  const declarations = publicDeclarations(
    checker,
    declarationsOf(symbol) ?? []
  );

  assertMergedDeclarationLimit(declarations);

  return declarations.filter(isCallerAccessibleMemberDeclaration);
};

const resolveAliasTarget = function resolveAliasTarget(
  checker: Checker,
  symbol: CompilerSymbol
): CompilerSymbol {
  return bitwiseAnd(symbol.flags, SymbolFlags.Alias) === 0
    ? symbol
    : aliasedSymbol(checker, symbol);
};

/** Bounds raw export tables and star edges before either value or namespace expansion. */
const reserveNamespaceExpansion = function reserveNamespaceExpansion(
  checker: Checker,
  symbol: CompilerSymbol,
  construction: InspectionResultConstruction
): number {
  let reserved = 0;
  const pending = [symbol];
  const visited = new Set<CompilerSymbol>();

  for (
    let current = pending.pop();
    current !== undefined;
    current = pending.pop()
  ) {
    if (visited.has(current)) {
      continue;
    }

    visited.add(current);
    const count = current.getExports().size ?? 0;
    construction.consumeMemberCandidates(count);
    reserved += count;
    const stars = current.getExports().get(InternalSymbolName.ExportStar);
    const declarations = publicMemberDeclarations(checker, stars ?? current);

    if (stars !== undefined) {
      for (const declaration of declarations) {
        construction.consumeMemberCandidates(1);
        reserved += 1;

        if (
          !isExportDeclaration(declaration) ||
          declaration.moduleSpecifier === undefined
        ) {
          continue;
        }

        const target = checker.getSymbolAtLocation(declaration.moduleSpecifier);

        if (target === undefined) {
          throw new UnsupportedInspectionError(
            "Member Discovery could not resolve a namespace reexport from Installed Evidence."
          );
        }

        pending.push(resolveAliasTarget(checker, target));
      }
    }
  }

  return reserved;
};

const resolvedNamespaceMembers = function resolvedNamespaceMembers(
  checker: Checker,
  symbol: CompilerSymbol,
  construction: InspectionResultConstruction
): readonly CompilerSymbol[] {
  reserveNamespaceExpansion(checker, symbol, construction);

  return checker.getExportsOfModule(symbol);
};

const memberType = function memberType(
  checker: Checker,
  symbol: CompilerSymbol,
  space: "type" | "value"
): Type | undefined {
  if (space === "type") {
    return bitwiseAnd(symbol.flags, SymbolFlags.Type) === 0
      ? undefined
      : checker.getDeclaredTypeOfSymbol(symbol);
  }

  const declaration = valueDeclarationOf(symbol) ?? declarationsOf(symbol)[0];

  return declaration === undefined
    ? undefined
    : checker.getTypeOfSymbolAtLocation(symbol, declaration);
};

const memberInSpace = function memberInSpace(
  checker: Checker,
  symbol: CompilerSymbol,
  name: string,
  space: DeclarationSpace,
  construction: InspectionResultConstruction
): CompilerSymbol | undefined {
  if (space === "namespace") {
    if (bitwiseAnd(symbol.flags, SymbolFlags.Module) === 0) {
      return undefined;
    }

    const direct = symbol.getExports().get(escapeLeadingUnderscores(name));

    if (
      direct !== undefined ||
      !(symbol.getExports().has(InternalSymbolName.ExportStar) ?? false)
    ) {
      return direct;
    }

    return resolvedNamespaceMembers(checker, symbol, construction).find(
      (member) => member.name === name
    );
  }

  if (
    space === "value" &&
    (symbol.getExports().has(InternalSymbolName.ExportStar) ?? false)
  ) {
    reserveNamespaceExpansion(checker, symbol, construction);
  }

  return memberType(checker, symbol, space)?.getProperty(name);
};

const publicMemberCandidates = function publicMemberCandidates(
  checker: Checker,
  symbol: CompilerSymbol,
  memberName: string,
  space: DeclarationSpace | undefined,
  construction: InspectionResultConstruction
): readonly CompilerSymbol[] {
  const spaces =
    space === undefined ? memberDeclarationSpaceSchema.literals : [space];

  const candidates = spaces
    .map((selectedSpace) =>
      memberInSpace(checker, symbol, memberName, selectedSpace, construction)
    )
    .filter(
      (candidate): candidate is CompilerSymbol => candidate !== undefined
    );

  return [...new Set(candidates)];
};

const isUndeclaredPublicProperty = function isUndeclaredPublicProperty(
  symbol: CompilerSymbol
): boolean {
  return (
    bitwiseAnd(symbol.flags, SymbolFlags.Property) !== 0 &&
    bitwiseAnd(symbol.flags, SymbolFlags.Prototype) === 0 &&
    (declarationsOf(symbol) === undefined ||
      declarationsOf(symbol).length === 0)
  );
};

const hasPublicDeclaration = function hasPublicDeclaration(
  checker: Checker,
  symbol: CompilerSymbol
): boolean {
  const target = resolveAliasTarget(checker, symbol);

  return (
    publicMemberDeclarations(checker, target).length > 0 ||
    isUndeclaredPublicProperty(target)
  );
};

/** Resolves only exact names in the type, value, and namespace declaration spaces. */
export const resolvePublicMemberPath = function resolvePublicMemberPath(
  checker: Checker,
  root: CompilerSymbol,
  memberPath: MemberPath,
  construction: InspectionResultConstruction
): PublicMemberPathResolution {
  let selected = root;

  for (const segment of memberPath) {
    const memberName = Predicate.isString(segment) ? segment : segment.name;
    const space = Predicate.isString(segment) ? undefined : segment.space;
    publicMemberDeclarations(checker, selected);

    const members = publicMemberCandidates(
      checker,
      selected,
      memberName,
      space,
      construction
    ).filter((candidate) => hasPublicDeclaration(checker, candidate));

    const [member] = members;

    if (member === undefined || members.length !== 1) {
      return {
        status: member === undefined ? "member-not-found" : "ambiguous-member",
      };
    }

    selected = resolveAliasTarget(checker, member);
  }

  return { status: "success", symbol: selected };
};

const membersInSpace = function membersInSpace(
  checker: Checker,
  symbol: CompilerSymbol,
  space: DeclarationSpace,
  construction: InspectionResultConstruction
): readonly CompilerSymbol[] {
  if (space === "namespace") {
    return bitwiseAnd(symbol.flags, SymbolFlags.Module) === 0
      ? []
      : resolvedNamespaceMembers(checker, symbol, construction);
  }

  const reserved =
    space === "value" && bitwiseAnd(symbol.flags, SymbolFlags.Module) !== 0
      ? reserveNamespaceExpansion(checker, symbol, construction)
      : 0;

  const members = memberType(checker, symbol, space)?.getProperties() ?? [];
  construction.consumeMemberCandidates(Math.max(0, members.length - reserved));

  return members;
};

/** Lists immediate caller-accessible names without projecting their declarations. */
export const discoverPublicMembers = function discoverPublicMembers(
  checker: Checker,
  symbol: CompilerSymbol,
  query: string | undefined,
  construction: InspectionResultConstruction
): DiscoveredPublicMembers {
  publicMemberDeclarations(checker, symbol);
  const names = new Map<string, DeclarationSpace[]>();

  for (const space of memberDeclarationSpaceSchema.literals) {
    const candidates = membersInSpace(checker, symbol, space, construction);

    const valueType =
      space === "value" ? memberType(checker, symbol, space) : undefined;

    for (const candidate of candidates) {
      if (!hasPublicDeclaration(checker, candidate)) {
        continue;
      }

      if (isUndeclaredPublicProperty(resolveAliasTarget(checker, candidate))) {
        throw new UnsupportedInspectionError(
          "Member Discovery cannot describe public members without declaration evidence."
        );
      }

      const { name } = candidate;

      if (
        name.length === 0 ||
        Buffer.byteLength(name) > MAX_MEMBER_PATH_SEGMENT_BYTES ||
        candidate.escapedName !== escapeLeadingUnderscores(name)
      ) {
        throw new UnsupportedInspectionError(
          "Member Discovery found a public name without a bounded exact selector."
        );
      }

      // Enumeration includes type-only star exports that exact value lookup rejects.
      if (
        valueType === undefined ||
        valueType.getProperty(name) === candidate
      ) {
        const spaces = names.get(name) ?? [];
        spaces.push(space);
        names.set(name, spaces);
      }
    }
  }

  const normalizedQuery = query?.toLowerCase();

  const members = [...names]
    .flatMap(([name, spaces]) =>
      normalizedQuery === undefined ||
      name.toLowerCase().includes(normalizedQuery)
        ? [{ name, spaces }]
        : []
    )
    .toSorted((left, right) => {
      if (left.name < right.name) {
        return -1;
      }

      if (left.name > right.name) {
        return 1;
      }

      return 0;
    });

  if (members.length > MAX_MEMBER_MATCHES) {
    throw new InspectionLimitError(
      "member-matches",
      "Inspection exceeded its Member match limit."
    );
  }

  return { members, totalMembers: names.size };
};
