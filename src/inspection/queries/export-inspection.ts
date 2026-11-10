import { isBindingElement, isNamespaceExport } from "tsrs/ast";
import type { Declaration } from "tsrs/ast";
import { SymbolFlags } from "tsrs/async";
import type { Checker, Symbol as CompilerSymbol } from "tsrs/async";

import { declarationsOf } from "#typepeek/inspection/compiler/compiler-session";
import type { InspectableModuleEvidence } from "#typepeek/inspection/evidence/installed-evidence";
import { MAX_NAMESPACE_DEPTH } from "#typepeek/inspection/model/budget-policy";
import { assertMergedDeclarationLimit } from "#typepeek/inspection/model/declaration-limits";
import {
  InspectionLimitError,
  UnsupportedInspectionError,
} from "#typepeek/inspection/model/errors";
import type { MemberPath } from "#typepeek/inspection/model/member-path";
import { MAX_MEMBER_PATH_SEGMENTS } from "#typepeek/inspection/model/member-path";
import type {
  DeclarationInspection,
  ExportAlias,
  ExportDeclarationSpace,
  ExportInspection,
  ExportNamespaceMember,
  InspectedDeclaration,
  InspectedModuleExport,
  MemberDiscovery,
  MemberInspection,
} from "#typepeek/inspection/model/protocol";
import type {
  FocusedInspectionConstruction,
  InspectionResultConstruction,
} from "#typepeek/inspection/model/result-construction";
import { inspectPackageDocumentation } from "#typepeek/inspection/projection/package-documentation";
import {
  declarationKind,
  declarationSpaces,
  publicDeclarations,
} from "#typepeek/inspection/projection/public-declaration-selection";
import { inspectResolvedExportSignatures } from "#typepeek/inspection/projection/public-signatures";
import { createExportDeclarationInspection } from "#typepeek/inspection/queries/export-declaration-inspection";
import type {
  AliasDeclaration,
  FocusedExportResolution,
} from "#typepeek/inspection/queries/focused-export";
import {
  resolveFocusedExport,
  resolveFocusedExportSymbol,
} from "#typepeek/inspection/queries/focused-export";
import type { PublicMemberPathResolution } from "#typepeek/inspection/queries/member-inspection";
import {
  discoverPublicMembers,
  publicMemberDeclarations,
  resolvePublicMemberPath,
} from "#typepeek/inspection/queries/member-inspection";
import { mapAsync } from "#typepeek/shared/async-collection";
import { bitwiseAnd } from "#typepeek/shared/integer-bits";

const MAX_NAMESPACE_MEMBERS = 128;

interface NamespaceMemberEvidence {
  readonly name: string;
  readonly declarations: readonly Declaration[];
  readonly members: readonly NamespaceMemberEvidence[];
}

interface NamespaceTraversalState {
  memberCount: number;
  readonly visited: Set<CompilerSymbol>;
}

interface FocusedDeclarationEvidence {
  readonly construction: FocusedInspectionConstruction;
  readonly namespaceMembers: readonly NamespaceMemberEvidence[];
  readonly resolution: FocusedExportResolution;
}

export type FocusedMemberFailureStatus =
  | "ambiguous-member"
  | "export-not-found"
  | "member-not-found"
  | "unsupported-member";

export type FocusedMemberInspection =
  | {
      readonly status: "success";
      readonly result: MemberInspection;
    }
  | {
      readonly status: FocusedMemberFailureStatus;
    };

const selectedDeclarationIsUnsupported =
  function selectedDeclarationIsUnsupported(
    declarations: readonly Declaration[],
    aliasDeclaration: AliasDeclaration | undefined
  ): boolean {
    if (
      declarations.length === 0 ||
      declarations.some((item) => declarationKind(item) !== undefined)
    ) {
      return false;
    }

    if (aliasDeclaration === undefined) {
      return true;
    }

    return declarations.some(isBindingElement);
  };

const assertSupportedSelectedDeclarationKind =
  async function assertSupportedSelectedDeclarationKind(
    checker: Checker,
    symbol: CompilerSymbol,
    aliasDeclaration: AliasDeclaration | undefined
  ): Promise<void> {
    const declarations = await publicDeclarations(
      checker,
      (await declarationsOf(symbol)) ?? []
    );

    if (selectedDeclarationIsUnsupported(declarations, aliasDeclaration)) {
      throw new UnsupportedInspectionError(
        "The selected Module Export contains an unsupported declaration kind."
      );
    }
  };

const assertNamespaceTraversalAllowed =
  function assertNamespaceTraversalAllowed(
    symbol: CompilerSymbol,
    state: NamespaceTraversalState,
    depth: number
  ): void {
    if (depth > MAX_NAMESPACE_DEPTH) {
      throw new InspectionLimitError(
        "namespace-depth",
        "Inspection exceeded its namespace traversal depth limit."
      );
    }

    if (state.visited.has(symbol)) {
      throw new UnsupportedInspectionError(
        "The selected Module Export contains a circular namespace re-export."
      );
    }
  };

const reserveNamespaceMembers = function reserveNamespaceMembers(
  state: NamespaceTraversalState,
  count: number
): void {
  state.memberCount += count;

  if (state.memberCount > MAX_NAMESPACE_MEMBERS) {
    throw new InspectionLimitError(
      "namespace-members",
      "Inspection exceeded its namespace member limit."
    );
  }
};

const inspectableDeclarations = async function inspectableDeclarations(
  checker: Checker,
  symbol: CompilerSymbol
): Promise<readonly Declaration[]> {
  const publicDeclarationsResult = await publicDeclarations(
    checker,
    (await declarationsOf(symbol)) ?? []
  );

  const declarations = publicDeclarationsResult.filter(
    (declaration) => declarationKind(declaration) !== undefined
  );

  assertMergedDeclarationLimit(declarations);

  return declarations;
};

const namespaceInspection = {
  async collectNamespaceMembers(
    checker: Checker,
    symbol: CompilerSymbol,
    state: NamespaceTraversalState,
    depth: number
  ): Promise<readonly NamespaceMemberEvidence[]> {
    if (bitwiseAnd(symbol.flags, SymbolFlags.Module) === 0) {
      return [];
    }

    assertNamespaceTraversalAllowed(symbol, state, depth);
    // `visited` tracks the current path rather than all previously seen symbols,
    // allowing shared namespaces in sibling branches while rejecting cycles.
    state.visited.add(symbol);
    const exportedMembers = await checker.getExportsOfModule(symbol);
    reserveNamespaceMembers(state, exportedMembers.length);

    const members = await mapAsync(
      exportedMembers,
      async (member) =>
        await namespaceInspection.inspectNamespaceMember(
          checker,
          symbol,
          member,
          state,
          depth
        )
    );

    state.visited.delete(symbol);

    return members;
  },
  async inspectNamespaceMember(
    checker: Checker,
    moduleSymbol: CompilerSymbol,
    member: CompilerSymbol,
    state: NamespaceTraversalState,
    depth: number
  ): Promise<NamespaceMemberEvidence> {
    const { aliasDeclaration, targetSymbol } = await resolveFocusedExportSymbol(
      checker,
      member,
      moduleSymbol
    );

    const namespaceAliasDeclaration =
      aliasDeclaration !== undefined && isNamespaceExport(aliasDeclaration)
        ? [aliasDeclaration]
        : [];

    const declarations = [
      ...namespaceAliasDeclaration,
      ...(await inspectableDeclarations(checker, targetSymbol)),
    ];

    assertMergedDeclarationLimit(declarations);

    return {
      declarations,
      members: await namespaceInspection.collectNamespaceMembers(
        checker,
        targetSymbol,
        state,
        depth + 1
      ),
      name: member.name,
    };
  },
};

const inspectNamespaceMemberEvidence =
  async function inspectNamespaceMemberEvidence(
    checker: Checker,
    symbol: CompilerSymbol
  ): Promise<readonly NamespaceMemberEvidence[]> {
    return await namespaceInspection.collectNamespaceMembers(
      checker,
      symbol,
      {
        memberCount: 0,
        visited: new Set(),
      },
      0
    );
  };

const inspectableMemberDeclarations =
  async function inspectableMemberDeclarations(
    checker: Checker,
    symbol: CompilerSymbol
  ): Promise<readonly Declaration[]> {
    const publicMemberDeclarationsResult = await publicMemberDeclarations(
      checker,
      symbol
    );

    return publicMemberDeclarationsResult.filter(
      (declaration) => declarationKind(declaration) !== undefined
    );
  };

const namespaceMemberDeclarations = function namespaceMemberDeclarations(
  members: readonly NamespaceMemberEvidence[]
): readonly Declaration[] {
  return members.flatMap((member) => [
    ...member.declarations,
    ...namespaceMemberDeclarations(member.members),
  ]);
};

const supportingRootDeclarations = async function supportingRootDeclarations(
  checker: Checker,
  selectedSymbol: CompilerSymbol,
  namespaceMembers: readonly NamespaceMemberEvidence[]
): Promise<readonly Declaration[]> {
  return [
    ...(await inspectableDeclarations(checker, selectedSymbol)),
    ...namespaceMemberDeclarations(namespaceMembers),
  ];
};

export const createModuleExportInspection =
  function createModuleExportInspection(
    evidence: InspectableModuleEvidence,
    constructionOwner: InspectionResultConstruction
  ) {
    const { inspectDeclaration, inspectSupportingTypes } =
      createExportDeclarationInspection(evidence);

    const resolveFocusedMember = async function resolveFocusedMember(
      exportName: string,
      memberPath: MemberPath
    ): Promise<
      | PublicMemberPathResolution
      | {
          readonly status: "export-not-found";
        }
    > {
      const resolution = await resolveFocusedExport(
        evidence.checker,
        evidence.moduleSymbol,
        exportName
      );

      return resolution === undefined
        ? { status: "export-not-found" }
        : await resolvePublicMemberPath(
            evidence.checker,
            resolution.targetSymbol,
            memberPath,
            constructionOwner
          );
    };

    const discoverFocusedModuleExportMembers =
      async function discoverFocusedModuleExportMembers(
        exportName: string,
        memberPath: MemberPath,
        query: string | undefined
      ): Promise<
        | {
            readonly status: "success";
            readonly result: MemberDiscovery;
          }
        | Exclude<
            FocusedMemberInspection,
            {
              readonly status: "success";
            }
          >
      > {
        const memberResolution = await resolveFocusedMember(
          exportName,
          memberPath
        );

        if (memberResolution.status !== "success") {
          return memberResolution;
        }

        const discovery = await discoverPublicMembers(
          evidence.checker,
          memberResolution.symbol,
          query,
          constructionOwner
        );

        if (
          memberPath.length === MAX_MEMBER_PATH_SEGMENTS &&
          discovery.totalMembers > 0
        ) {
          throw new UnsupportedInspectionError(
            "Member Discovery cannot select children beyond the Member path depth limit."
          );
        }

        return {
          result: constructionOwner.memberDiscovery(
            exportName,
            memberPath,
            query,
            discovery.totalMembers,
            discovery.members
          ),
          status: "success",
        };
      };

    const readFocusedDeclarationEvidence =
      async function readFocusedDeclarationEvidence(
        exportName: string
      ): Promise<FocusedDeclarationEvidence | undefined> {
        const resolution = await resolveFocusedExport(
          evidence.checker,
          evidence.moduleSymbol,
          exportName
        );

        if (resolution === undefined) {
          return undefined;
        }

        const { targetSymbol, aliasDeclaration, spaces } = resolution;
        await assertSupportedSelectedDeclarationKind(
          evidence.checker,
          targetSymbol,
          aliasDeclaration
        );

        return {
          construction: constructionOwner.focused(),
          namespaceMembers: spaces.includes("namespace")
            ? await inspectNamespaceMemberEvidence(
                evidence.checker,
                targetSymbol
              )
            : [],
          resolution,
        };
      };

    const inspectAlias = async function inspectAlias(
      resolution: FocusedExportResolution,
      construction: FocusedInspectionConstruction
    ): Promise<ExportAlias | undefined> {
      const { aliasDeclaration } = resolution;

      if (
        aliasDeclaration === undefined ||
        resolution.aliasTargetName === undefined
      ) {
        return undefined;
      }

      const declaration = await inspectDeclaration(
        aliasDeclaration,
        construction,
        "alias"
      );

      return construction.alias(resolution.aliasTargetName, declaration);
    };

    const inspectNamespaceMembers = async function inspectNamespaceMembers(
      members: readonly NamespaceMemberEvidence[],
      construction: FocusedInspectionConstruction
    ): Promise<readonly ExportNamespaceMember[]> {
      return await mapAsync(members, async (member) => {
        const declarations = await mapAsync(
          member.declarations,
          async (declaration) =>
            await inspectDeclaration(declaration, construction)
        );

        const childMembers = await inspectNamespaceMembers(
          member.members,
          construction
        );

        return construction.namespaceMember(
          member.name,
          declarations,
          childMembers
        );
      });
    };

    const inspectedDeclarations = async function inspectedDeclarations(
      declarations: readonly Declaration[],
      aliasDeclaration: AliasDeclaration | undefined,
      construction: FocusedInspectionConstruction
    ): Promise<readonly InspectedDeclaration[]> {
      if (declarations.length > 0) {
        return await mapAsync(
          declarations,
          async (declaration) =>
            await inspectDeclaration(declaration, construction)
        );
      }

      return aliasDeclaration === undefined
        ? []
        : [await inspectDeclaration(aliasDeclaration, construction, "alias")];
    };

    const inspectDeclarationSpaces = async function inspectDeclarationSpaces({
      resolution,
      namespaceMembers,
      construction,
    }: FocusedDeclarationEvidence): Promise<readonly ExportDeclarationSpace[]> {
      const { targetSymbol, aliasDeclaration, spaces } = resolution;

      const declarations = await inspectableDeclarations(
        evidence.checker,
        targetSymbol
      );

      return await mapAsync(
        spaces,
        async (space): Promise<ExportDeclarationSpace> => {
          if (space === "namespace") {
            return construction.namespaceSpace(
              await inspectNamespaceMembers(namespaceMembers, construction)
            );
          }

          return construction.declarationSpace(
            space,
            await inspectedDeclarations(
              declarations.filter((declaration) =>
                declarationSpaces(declaration).includes(space)
              ),
              aliasDeclaration,
              construction
            )
          );
        }
      );
    };

    /** Inspects only one Module Export's declarations, without signatures or Supporting Types. */
    const inspectFocusedModuleExportDeclarations =
      async function inspectFocusedModuleExportDeclarations(
        exportName: string
      ): Promise<DeclarationInspection | undefined> {
        const focused = await readFocusedDeclarationEvidence(exportName);

        if (focused === undefined) {
          return undefined;
        }

        const alias = await inspectAlias(
          focused.resolution,
          focused.construction
        );

        const moduleExport = focused.construction.moduleExportDeclarations({
          name: focused.resolution.exportedSymbol.name,
          ...(alias !== undefined && { alias }),
          spaces: await inspectDeclarationSpaces(focused),
        });

        return focused.construction.declarationResult(moduleExport);
      };

    const inspectModuleExport = async function inspectModuleExport(
      focused: FocusedDeclarationEvidence
    ): Promise<InspectedModuleExport> {
      const { resolution, construction } = focused;
      const alias = await inspectAlias(resolution, construction);
      const focusedDeclarationSpaces = await inspectDeclarationSpaces(focused);

      const signatures = await inspectResolvedExportSignatures(
        evidence.checker,
        resolution,
        (value) => construction.signature(value)
      );

      return construction.moduleExport({
        name: resolution.exportedSymbol.name,
        ...(alias !== undefined && { alias }),
        signatures,
        spaces: focusedDeclarationSpaces,
      });
    };

    /**
     * Produces a bounded Export Inspection from one Inspectable Module backed by
     * Installed Evidence. Returns `undefined` only when the named Module Export is
     * absent; unsupported declaration shapes and exhausted budgets use typed errors.
     */
    const inspectFocusedModuleExport =
      async function inspectFocusedModuleExport(
        exportName: string
      ): Promise<ExportInspection | undefined> {
        const focused = await readFocusedDeclarationEvidence(exportName);

        if (focused === undefined) {
          return undefined;
        }

        const packageDocumentationEvidence = await inspectPackageDocumentation(
          evidence.checker,
          focused.resolution.exportedSymbol,
          focused.resolution.targetSymbol,
          focused.resolution.aliasDeclaration
        );

        const packageDocumentation =
          packageDocumentationEvidence === undefined
            ? undefined
            : focused.construction.documentation(packageDocumentationEvidence);

        const moduleExport = await inspectModuleExport(focused);

        const supportingTypes = await inspectSupportingTypes(
          focused.resolution.targetSymbol,
          await supportingRootDeclarations(
            evidence.checker,
            focused.resolution.targetSymbol,
            focused.namespaceMembers
          ),
          focused.construction
        );

        return focused.construction.exportResult(
          moduleExport,
          supportingTypes,
          packageDocumentation
        );
      };

    const inspectFocusedModuleExportMember =
      async function inspectFocusedModuleExportMember(
        exportName: string,
        memberPath: MemberPath
      ): Promise<FocusedMemberInspection> {
        const memberResolution = await resolveFocusedMember(
          exportName,
          memberPath
        );

        if (memberResolution.status !== "success") {
          return { status: memberResolution.status };
        }

        const memberDeclarations = await inspectableMemberDeclarations(
          evidence.checker,
          memberResolution.symbol
        );

        if (memberDeclarations.length === 0) {
          return { status: "unsupported-member" };
        }

        const construction = constructionOwner.focused();

        const declarations = await mapAsync(
          memberDeclarations,
          async (declaration) =>
            await inspectDeclaration(declaration, construction)
        );

        return {
          result: construction.memberResult(
            exportName,
            memberPath,
            declarations
          ),
          status: "success",
        };
      };

    return {
      discoverMembers: discoverFocusedModuleExportMembers,
      inspectDeclarations: inspectFocusedModuleExportDeclarations,
      inspectExport: inspectFocusedModuleExport,
      inspectMember: inspectFocusedModuleExportMember,
    };
  };

export type ModuleExportInspection = ReturnType<
  typeof createModuleExportInspection
>;
