import { Predicate } from "effect";
import {
  escapeLeadingUnderscores,
  InternalSymbolName,
  isExportDeclaration,
  SyntaxKind,
} from "tsrs/ast";
import type { Declaration } from "tsrs/ast";
import { SymbolFlags } from "tsrs/async";
import type { Checker, Symbol as CompilerSymbol, Type } from "tsrs/async";

import { aliasedSymbol } from "#typepeek/inspection/compiler/compiler-queries";
import {
  declarationsOf,
  valueDeclarationOf,
} from "#typepeek/inspection/compiler/compiler-session";
import { modifiersOf } from "#typepeek/inspection/compiler/compiler-syntax";
import { MAX_MEMBER_MATCHES } from "#typepeek/inspection/model/budget-policy";
import { assertMergedDeclarationLimit } from "#typepeek/inspection/model/declaration-limits";
import {
  InspectionLimitError,
  UnsupportedInspectionError,
} from "#typepeek/inspection/model/errors";
import type { MemberPath } from "#typepeek/inspection/model/member-path";
import {
  MAX_MEMBER_PATH_SEGMENT_BYTES,
  memberDeclarationSpaceSchema,
} from "#typepeek/inspection/model/member-path";
import type { DeclarationSpace } from "#typepeek/inspection/model/protocol";
import type { InspectionResultConstruction } from "#typepeek/inspection/model/result-construction";
import {
  isPrivateDeclaration,
  publicDeclarations,
} from "#typepeek/inspection/projection/public-declaration-selection";
import { mapAsync, filterAsync } from "#typepeek/shared/async-collection";
import { bitwiseAnd } from "#typepeek/shared/integer-bits";

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

export const publicMemberDeclarations = async function publicMemberDeclarations(
  checker: Checker,
  symbol: CompilerSymbol
): Promise<readonly Declaration[]> {
  const declarations = await publicDeclarations(
    checker,
    (await declarationsOf(symbol)) ?? []
  );

  assertMergedDeclarationLimit(declarations);

  return declarations.filter(isCallerAccessibleMemberDeclaration);
};

const resolveAliasTarget = async function resolveAliasTarget(
  checker: Checker,
  symbol: CompilerSymbol
): Promise<CompilerSymbol> {
  return bitwiseAnd(symbol.flags, SymbolFlags.Alias) === 0
    ? symbol
    : await aliasedSymbol(checker, symbol);
};

/** Bounds raw export tables and star edges before either value or namespace expansion. */
const reserveNamespaceExpansion = async function reserveNamespaceExpansion(
  checker: Checker,
  symbol: CompilerSymbol,
  construction: InspectionResultConstruction
): Promise<number> {
  let reserved = 0;
  const pending = [symbol];
  const visited = new Set<CompilerSymbol>();

  /* oxlint-disable eslint/no-await-in-loop -- Expansion updates shared candidate budgets and the pending export graph. */
  for (
    let current = pending.pop();
    current !== undefined;
    current = pending.pop()
  ) {
    if (visited.has(current)) {
      continue;
    }

    visited.add(current);
    const exportsResult = await current.getExports();
    const count = exportsResult.size ?? 0;
    construction.consumeMemberCandidates(count);
    reserved += count;

    const stars = exportsResult.get(InternalSymbolName.ExportStar);

    const declarations = await publicMemberDeclarations(
      checker,
      stars ?? current
    );

    if (stars !== undefined) {
      /* oxlint-disable eslint/no-await-in-loop -- Compiler queries share inspection state and must retain serial traversal order. */
      for (const declaration of declarations) {
        construction.consumeMemberCandidates(1);
        reserved += 1;

        if (
          !isExportDeclaration(declaration) ||
          declaration.moduleSpecifier === undefined
        ) {
          continue;
        }

        const target = await checker.getSymbolAtLocation(
          declaration.moduleSpecifier
        );

        if (target === undefined) {
          throw new UnsupportedInspectionError(
            "Member Discovery could not resolve a namespace reexport from Installed Evidence."
          );
        }

        pending.push(await resolveAliasTarget(checker, target));
      }
      /* oxlint-enable eslint/no-await-in-loop */
    }
  }
  /* oxlint-enable eslint/no-await-in-loop */

  return reserved;
};

const resolvedNamespaceMembers = async function resolvedNamespaceMembers(
  checker: Checker,
  symbol: CompilerSymbol,
  construction: InspectionResultConstruction
): Promise<readonly CompilerSymbol[]> {
  await reserveNamespaceExpansion(checker, symbol, construction);

  return await checker.getExportsOfModule(symbol);
};

const memberType = async function memberType(
  checker: Checker,
  symbol: CompilerSymbol,
  space: "type" | "value"
): Promise<Type | undefined> {
  if (space === "type") {
    return bitwiseAnd(symbol.flags, SymbolFlags.Type) === 0
      ? undefined
      : await checker.getDeclaredTypeOfSymbol(symbol);
  }

  let declaration = await valueDeclarationOf(symbol);

  if (declaration === undefined) {
    const declarations = await declarationsOf(symbol);
    [declaration] = declarations;
  }

  return declaration === undefined
    ? undefined
    : await checker.getTypeOfSymbolAtLocation(symbol, declaration);
};

const memberInSpace = async function memberInSpace(
  checker: Checker,
  symbol: CompilerSymbol,
  name: string,
  space: DeclarationSpace,
  construction: InspectionResultConstruction
): Promise<CompilerSymbol | undefined> {
  if (space === "namespace") {
    if (bitwiseAnd(symbol.flags, SymbolFlags.Module) === 0) {
      return undefined;
    }

    const exportsResult = await symbol.getExports();
    const direct = exportsResult.get(escapeLeadingUnderscores(name));

    if (
      direct !== undefined ||
      !exportsResult.has(InternalSymbolName.ExportStar)
    ) {
      return direct;
    }

    const resolvedNamespaceMembersResult = await resolvedNamespaceMembers(
      checker,
      symbol,
      construction
    );

    return resolvedNamespaceMembersResult.find(
      (member) => member.name === name
    );
  }

  if (space === "value") {
    const exports = await symbol.getExports();

    if (exports.has(InternalSymbolName.ExportStar)) {
      await reserveNamespaceExpansion(checker, symbol, construction);
    }
  }

  const memberTypeResult = await memberType(checker, symbol, space);

  return await memberTypeResult?.getProperty(name);
};

const publicMemberCandidates = async function publicMemberCandidates(
  checker: Checker,
  symbol: CompilerSymbol,
  memberName: string,
  space: DeclarationSpace | undefined,
  construction: InspectionResultConstruction
): Promise<readonly CompilerSymbol[]> {
  const spaces =
    space === undefined ? memberDeclarationSpaceSchema.literals : [space];

  const mappedValues = await mapAsync(
    spaces,
    async (selectedSpace) =>
      await memberInSpace(
        checker,
        symbol,
        memberName,
        selectedSpace,
        construction
      )
  );

  const candidates = mappedValues.filter(
    (candidate): candidate is CompilerSymbol => candidate !== undefined
  );

  return [...new Set(candidates)];
};

const isUndeclaredPublicProperty = async function isUndeclaredPublicProperty(
  symbol: CompilerSymbol
): Promise<boolean> {
  if (
    bitwiseAnd(symbol.flags, SymbolFlags.Property) === 0 ||
    bitwiseAnd(symbol.flags, SymbolFlags.Prototype) !== 0
  ) {
    return false;
  }

  const declarations = await declarationsOf(symbol);

  return declarations.length === 0;
};

const hasPublicDeclaration = async function hasPublicDeclaration(
  checker: Checker,
  symbol: CompilerSymbol
): Promise<boolean> {
  const target = await resolveAliasTarget(checker, symbol);

  const publicMemberDeclarationsResult = await publicMemberDeclarations(
    checker,
    target
  );

  return (
    publicMemberDeclarationsResult.length > 0 ||
    (await isUndeclaredPublicProperty(target))
  );
};

/** Resolves only exact names in the type, value, and namespace declaration spaces. */
export const resolvePublicMemberPath = async function resolvePublicMemberPath(
  checker: Checker,
  root: CompilerSymbol,
  memberPath: MemberPath,
  construction: InspectionResultConstruction
): Promise<PublicMemberPathResolution> {
  let selected = root;

  /* oxlint-disable eslint/no-await-in-loop -- Compiler queries share inspection state and must retain serial traversal order. */
  for (const segment of memberPath) {
    const memberName = Predicate.isString(segment) ? segment : segment.name;
    const space = Predicate.isString(segment) ? undefined : segment.space;
    await publicMemberDeclarations(checker, selected);

    const members = await filterAsync(
      await publicMemberCandidates(
        checker,
        selected,
        memberName,
        space,
        construction
      ),
      async (candidate) => await hasPublicDeclaration(checker, candidate)
    );

    const [member] = members;

    if (member === undefined || members.length !== 1) {
      return {
        status: member === undefined ? "member-not-found" : "ambiguous-member",
      };
    }

    selected = await resolveAliasTarget(checker, member);
  }
  /* oxlint-enable eslint/no-await-in-loop */

  return { status: "success", symbol: selected };
};

const membersInSpace = async function membersInSpace(
  checker: Checker,
  symbol: CompilerSymbol,
  space: DeclarationSpace,
  construction: InspectionResultConstruction
): Promise<readonly CompilerSymbol[]> {
  if (space === "namespace") {
    return bitwiseAnd(symbol.flags, SymbolFlags.Module) === 0
      ? []
      : await resolvedNamespaceMembers(checker, symbol, construction);
  }

  const reserved =
    space === "value" && bitwiseAnd(symbol.flags, SymbolFlags.Module) !== 0
      ? await reserveNamespaceExpansion(checker, symbol, construction)
      : 0;

  const memberTypeResult = await memberType(checker, symbol, space);
  const members = (await memberTypeResult?.getProperties()) ?? [];

  construction.consumeMemberCandidates(Math.max(0, members.length - reserved));

  return members;
};

/** Lists immediate caller-accessible names without projecting their declarations. */
export const discoverPublicMembers = async function discoverPublicMembers(
  checker: Checker,
  symbol: CompilerSymbol,
  query: string | undefined,
  construction: InspectionResultConstruction
): Promise<DiscoveredPublicMembers> {
  await publicMemberDeclarations(checker, symbol);
  const names = new Map<string, DeclarationSpace[]>();

  /* oxlint-disable eslint/no-await-in-loop -- Compiler queries share inspection state and must retain serial traversal order. */
  for (const space of memberDeclarationSpaceSchema.literals) {
    const candidates = await membersInSpace(
      checker,
      symbol,
      space,
      construction
    );

    const valueType =
      space === "value" ? await memberType(checker, symbol, space) : undefined;

    for (const candidate of candidates) {
      if (!(await hasPublicDeclaration(checker, candidate))) {
        continue;
      }

      if (
        await isUndeclaredPublicProperty(
          await resolveAliasTarget(checker, candidate)
        )
      ) {
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
        (await valueType.getProperty(name)) === candidate
      ) {
        const spaces = names.get(name) ?? [];
        spaces.push(space);
        names.set(name, spaces);
      }
    }
  }
  /* oxlint-enable eslint/no-await-in-loop */

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
