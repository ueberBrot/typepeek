import { isBindingElement, isNamespaceExport } from "tsrs/ast";
import type { Declaration } from "tsrs/ast";
import { SymbolFlags } from "tsrs/sync";
import type { Checker, Symbol as CompilerSymbol } from "tsrs/sync";

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
  function assertSupportedSelectedDeclarationKind(
    checker: Checker,
    symbol: CompilerSymbol,
    aliasDeclaration: AliasDeclaration | undefined
  ): void {
    const declarations = publicDeclarations(
      checker,
      declarationsOf(symbol) ?? []
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

const inspectableDeclarations = function inspectableDeclarations(
  checker: Checker,
  symbol: CompilerSymbol
): readonly Declaration[] {
  const declarations = publicDeclarations(
    checker,
    declarationsOf(symbol) ?? []
  ).filter((declaration) => declarationKind(declaration) !== undefined);

  assertMergedDeclarationLimit(declarations);

  return declarations;
};

const namespaceInspection = {
  collectNamespaceMembers(
    checker: Checker,
    symbol: CompilerSymbol,
    state: NamespaceTraversalState,
    depth: number
  ): readonly NamespaceMemberEvidence[] {
    if (bitwiseAnd(symbol.flags, SymbolFlags.Module) === 0) {
      return [];
    }

    assertNamespaceTraversalAllowed(symbol, state, depth);
    // `visited` tracks the current path rather than all previously seen symbols,
    // allowing shared namespaces in sibling branches while rejecting cycles.
    state.visited.add(symbol);
    const exportedMembers = checker.getExportsOfModule(symbol);
    reserveNamespaceMembers(state, exportedMembers.length);

    const members = exportedMembers.map((member) =>
      namespaceInspection.inspectNamespaceMember(
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
  inspectNamespaceMember(
    checker: Checker,
    moduleSymbol: CompilerSymbol,
    member: CompilerSymbol,
    state: NamespaceTraversalState,
    depth: number
  ): NamespaceMemberEvidence {
    const { aliasDeclaration, targetSymbol } = resolveFocusedExportSymbol(
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
      ...inspectableDeclarations(checker, targetSymbol),
    ];

    assertMergedDeclarationLimit(declarations);

    return {
      declarations,
      members: namespaceInspection.collectNamespaceMembers(
        checker,
        targetSymbol,
        state,
        depth + 1
      ),
      name: member.name,
    };
  },
};

const inspectNamespaceMemberEvidence = function inspectNamespaceMemberEvidence(
  checker: Checker,
  symbol: CompilerSymbol
): readonly NamespaceMemberEvidence[] {
  return namespaceInspection.collectNamespaceMembers(
    checker,
    symbol,
    {
      memberCount: 0,
      visited: new Set(),
    },
    0
  );
};

const inspectableMemberDeclarations = function inspectableMemberDeclarations(
  checker: Checker,
  symbol: CompilerSymbol
): readonly Declaration[] {
  return publicMemberDeclarations(checker, symbol).filter(
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

const supportingRootDeclarations = function supportingRootDeclarations(
  checker: Checker,
  selectedSymbol: CompilerSymbol,
  namespaceMembers: readonly NamespaceMemberEvidence[]
): readonly Declaration[] {
  return [
    ...inspectableDeclarations(checker, selectedSymbol),
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

    const resolveFocusedMember = function resolveFocusedMember(
      exportName: string,
      memberPath: MemberPath
    ):
      | PublicMemberPathResolution
      | {
          readonly status: "export-not-found";
        } {
      const resolution = resolveFocusedExport(
        evidence.checker,
        evidence.moduleSymbol,
        exportName
      );

      return resolution === undefined
        ? { status: "export-not-found" }
        : resolvePublicMemberPath(
            evidence.checker,
            resolution.targetSymbol,
            memberPath,
            constructionOwner
          );
    };

    const discoverFocusedModuleExportMembers =
      function discoverFocusedModuleExportMembers(
        exportName: string,
        memberPath: MemberPath,
        query: string | undefined
      ):
        | {
            readonly status: "success";
            readonly result: MemberDiscovery;
          }
        | Exclude<
            FocusedMemberInspection,
            {
              readonly status: "success";
            }
          > {
        const memberResolution = resolveFocusedMember(exportName, memberPath);

        if (memberResolution.status !== "success") {
          return memberResolution;
        }

        const discovery = discoverPublicMembers(
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
      function readFocusedDeclarationEvidence(
        exportName: string
      ): FocusedDeclarationEvidence | undefined {
        const resolution = resolveFocusedExport(
          evidence.checker,
          evidence.moduleSymbol,
          exportName
        );

        if (resolution === undefined) {
          return undefined;
        }

        const { targetSymbol, aliasDeclaration, spaces } = resolution;
        assertSupportedSelectedDeclarationKind(
          evidence.checker,
          targetSymbol,
          aliasDeclaration
        );

        return {
          construction: constructionOwner.focused(),
          namespaceMembers: spaces.includes("namespace")
            ? inspectNamespaceMemberEvidence(evidence.checker, targetSymbol)
            : [],
          resolution,
        };
      };

    const inspectAlias = function inspectAlias(
      resolution: FocusedExportResolution,
      construction: FocusedInspectionConstruction
    ): ExportAlias | undefined {
      const { aliasDeclaration } = resolution;

      if (
        aliasDeclaration === undefined ||
        resolution.aliasTargetName === undefined
      ) {
        return undefined;
      }

      const declaration = inspectDeclaration(
        aliasDeclaration,
        construction,
        "alias"
      );

      return construction.alias(resolution.aliasTargetName, declaration);
    };

    const inspectNamespaceMembers = function inspectNamespaceMembers(
      members: readonly NamespaceMemberEvidence[],
      construction: FocusedInspectionConstruction
    ): readonly ExportNamespaceMember[] {
      return members.map((member) => {
        const declarations = member.declarations.map((declaration) =>
          inspectDeclaration(declaration, construction)
        );

        const childMembers = inspectNamespaceMembers(
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

    const inspectedDeclarations = function inspectedDeclarations(
      declarations: readonly Declaration[],
      aliasDeclaration: AliasDeclaration | undefined,
      construction: FocusedInspectionConstruction
    ): readonly InspectedDeclaration[] {
      if (declarations.length > 0) {
        return declarations.map((declaration) =>
          inspectDeclaration(declaration, construction)
        );
      }

      return aliasDeclaration === undefined
        ? []
        : [inspectDeclaration(aliasDeclaration, construction, "alias")];
    };

    const inspectDeclarationSpaces = function inspectDeclarationSpaces({
      resolution,
      namespaceMembers,
      construction,
    }: FocusedDeclarationEvidence): readonly ExportDeclarationSpace[] {
      const { targetSymbol, aliasDeclaration, spaces } = resolution;

      const declarations = inspectableDeclarations(
        evidence.checker,
        targetSymbol
      );

      return spaces.map((space): ExportDeclarationSpace => {
        if (space === "namespace") {
          return construction.namespaceSpace(
            inspectNamespaceMembers(namespaceMembers, construction)
          );
        }

        return construction.declarationSpace(
          space,
          inspectedDeclarations(
            declarations.filter((declaration) =>
              declarationSpaces(declaration).includes(space)
            ),
            aliasDeclaration,
            construction
          )
        );
      });
    };

    /** Inspects only one Module Export's declarations, without signatures or Supporting Types. */
    const inspectFocusedModuleExportDeclarations =
      function inspectFocusedModuleExportDeclarations(
        exportName: string
      ): DeclarationInspection | undefined {
        const focused = readFocusedDeclarationEvidence(exportName);

        if (focused === undefined) {
          return undefined;
        }

        const alias = inspectAlias(focused.resolution, focused.construction);

        const moduleExport = focused.construction.moduleExportDeclarations({
          name: focused.resolution.exportedSymbol.name,
          ...(alias !== undefined && { alias }),
          spaces: inspectDeclarationSpaces(focused),
        });

        return focused.construction.declarationResult(moduleExport);
      };

    const inspectModuleExport = function inspectModuleExport(
      focused: FocusedDeclarationEvidence
    ): InspectedModuleExport {
      const { resolution, construction } = focused;
      const alias = inspectAlias(resolution, construction);
      const focusedDeclarationSpaces = inspectDeclarationSpaces(focused);

      const signatures = inspectResolvedExportSignatures(
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
    const inspectFocusedModuleExport = function inspectFocusedModuleExport(
      exportName: string
    ): ExportInspection | undefined {
      const focused = readFocusedDeclarationEvidence(exportName);

      if (focused === undefined) {
        return undefined;
      }

      const packageDocumentationEvidence = inspectPackageDocumentation(
        evidence.checker,
        focused.resolution.exportedSymbol,
        focused.resolution.targetSymbol,
        focused.resolution.aliasDeclaration
      );

      const packageDocumentation =
        packageDocumentationEvidence === undefined
          ? undefined
          : focused.construction.documentation(packageDocumentationEvidence);

      const moduleExport = inspectModuleExport(focused);

      const supportingTypes = inspectSupportingTypes(
        focused.resolution.targetSymbol,
        supportingRootDeclarations(
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
      function inspectFocusedModuleExportMember(
        exportName: string,
        memberPath: MemberPath
      ): FocusedMemberInspection {
        const memberResolution = resolveFocusedMember(exportName, memberPath);

        if (memberResolution.status !== "success") {
          return { status: memberResolution.status };
        }

        const memberDeclarations = inspectableMemberDeclarations(
          evidence.checker,
          memberResolution.symbol
        );

        if (memberDeclarations.length === 0) {
          return { status: "unsupported-member" };
        }

        const construction = constructionOwner.focused();

        const declarations = memberDeclarations.map((declaration) =>
          inspectDeclaration(declaration, construction)
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
