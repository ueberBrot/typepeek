import { MAX_MEMBER_CANDIDATES } from "#typepeek/inspection/model/budget-policy";
import { InspectionLimitError } from "#typepeek/inspection/model/errors";
import type { MemberPath } from "#typepeek/inspection/model/member-path";
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-object-parameters -- The construction budget measures heterogeneous trusted result fragments without changing their domain types. */
import type {
  AtomicInspectionResult,
  DeclarationInspection,
  DeclarationSpace,
  ExportAlias,
  ExportDeclarationSpace,
  ExportInspection,
  ExportNamespaceMember,
  ExportSignature,
  InspectedDeclaration,
  InspectedModuleExport,
  InspectedModuleExportDeclarations,
  InspectedModuleExportSignatures,
  InspectedSignature,
  ExportSearch,
  InspectionPlan,
  InspectionResultIdentity,
  InterfaceOverview,
  MemberDiscovery,
  MemberInspection,
  PackageDocumentation,
  PublicSubpath,
  PublicSubpathDiscovery,
  ResolutionVariant,
  SignatureInspection,
  SupportingType,
} from "#typepeek/inspection/model/protocol";
import { ResultConstructionBudget } from "#typepeek/inspection/model/result-construction-budget";

interface InspectionResultConstructionTarget {
  readonly identity: InspectionResultIdentity;
  readonly resolutionVariant: ResolutionVariant;
  readonly specifier: string;
}

const createFocusedInspectionConstruction = (
  target: InspectionResultConstructionTarget,
  budget: ResultConstructionBudget
) =>
  ({
    alias(
      targetName: string,
      declaration: ExportAlias["declaration"]
    ): ExportAlias {
      return budget.container({ declaration, targetName }, [declaration]);
    },
    declaration<Value extends InspectedDeclaration>(value: Value): Value {
      return budget.leaf(value);
    },
    declarationResult(
      moduleExport: InspectedModuleExportDeclarations
    ): DeclarationInspection {
      return budget.container(
        {
          intent: "declaration-inspection",
          resolutionVariant: target.resolutionVariant,
          specifier: target.specifier,
          ...target.identity,
          moduleExport,
        },
        [moduleExport]
      );
    },
    declarationSpace(
      space: Exclude<DeclarationSpace, "namespace">,
      declarations: readonly InspectedDeclaration[]
    ): ExportDeclarationSpace {
      return budget.container({ declarations, space }, declarations);
    },
    documentation(value: PackageDocumentation): PackageDocumentation {
      return budget.leaf(value);
    },
    exportResult(
      moduleExport: InspectedModuleExport,
      supportingTypes: readonly SupportingType[],
      packageDocumentation: PackageDocumentation | undefined
    ): ExportInspection {
      const result: ExportInspection = {
        intent: "export-inspection",
        resolutionVariant: target.resolutionVariant,
        specifier: target.specifier,
        ...target.identity,
        moduleExport,
        supportingTypes,
        ...(packageDocumentation !== undefined && { packageDocumentation }),
      };

      return budget.container(result, [
        moduleExport,
        ...supportingTypes,
        ...(packageDocumentation === undefined ? [] : [packageDocumentation]),
      ]);
    },
    memberResult(
      moduleExportName: string,
      memberPath: MemberPath,
      declarations: readonly InspectedDeclaration[]
    ): MemberInspection {
      return budget.container(
        {
          intent: "member-inspection",
          resolutionVariant: target.resolutionVariant,
          specifier: target.specifier,
          ...target.identity,
          declarations,
          memberPath,
          moduleExportName,
        },
        declarations
      );
    },
    moduleExport(options: {
      readonly alias?: ExportAlias;
      readonly name: string;
      readonly signatures: readonly ExportSignature[];
      readonly spaces: readonly ExportDeclarationSpace[];
    }): InspectedModuleExport {
      const value = {
        name: options.name,
        ...(options.alias !== undefined && { alias: options.alias }),
        signatures: options.signatures,
        spaces: options.spaces,
      };

      return budget.container(value, [
        ...(options.alias === undefined ? [] : [options.alias]),
        ...options.spaces,
        ...options.signatures,
      ]);
    },
    moduleExportDeclarations(options: {
      readonly alias?: ExportAlias;
      readonly name: string;
      readonly spaces: readonly ExportDeclarationSpace[];
    }): InspectedModuleExportDeclarations {
      const value = {
        name: options.name,
        ...(options.alias !== undefined && { alias: options.alias }),
        spaces: options.spaces,
      };

      return budget.container(value, [
        ...(options.alias === undefined ? [] : [options.alias]),
        ...options.spaces,
      ]);
    },
    namespaceMember(
      name: string,
      declarations: readonly InspectedDeclaration[],
      members: readonly ExportNamespaceMember[]
    ): ExportNamespaceMember {
      return budget.container({ declarations, members, name }, [
        ...declarations,
        ...members,
      ]);
    },
    namespaceSpace(
      members: readonly ExportNamespaceMember[]
    ): ExportDeclarationSpace {
      return budget.container({ members, space: "namespace" }, members);
    },
    signature(value: ExportSignature): ExportSignature {
      return budget.leaf(value);
    },
    supportingType(
      name: string,
      declarations: readonly InspectedDeclaration[]
    ): SupportingType {
      return budget.container({ declarations, name }, declarations);
    },
  }) as const;

const createSignatureInspectionConstruction = (
  target: InspectionResultConstructionTarget,
  budget: ResultConstructionBudget
) =>
  ({
    moduleExport(
      name: string,
      aliasTargetName: string | undefined,
      signatures: readonly InspectedSignature[]
    ): InspectedModuleExportSignatures {
      return budget.container(
        {
          name,
          ...(aliasTargetName !== undefined && { aliasTargetName }),
          signatures,
        },
        signatures
      );
    },
    result(moduleExport: InspectedModuleExportSignatures): SignatureInspection {
      return budget.container(
        {
          intent: "signature-inspection",
          resolutionVariant: target.resolutionVariant,
          specifier: target.specifier,
          ...target.identity,
          moduleExport,
        },
        [moduleExport]
      );
    },
    signature(value: InspectedSignature): InspectedSignature {
      return budget.leaf(value);
    },
  }) as const;

export type FocusedInspectionConstruction = ReturnType<
  InspectionResultConstruction["focused"]
>;

/** Checks the aggregate budget of an assembled result. */
export const assertInspectionResultConstructionBound =
  function assertInspectionResultConstructionBound(value: object): void {
    new ResultConstructionBudget().leaf(value);
  };

/** Shares one result budget across all queries in an inspection. */
export class InspectionResultConstruction {
  #memberCandidates = 0;
  readonly #budget = new ResultConstructionBudget();
  readonly #target: InspectionResultConstructionTarget;
  private constructor(target: InspectionResultConstructionTarget) {
    this.#target = target;
  }
  static create(target: {
    readonly identity: InspectionResultIdentity;
    readonly resolutionVariant: ResolutionVariant;
    readonly specifier: string;
  }): InspectionResultConstruction {
    return new InspectionResultConstruction({ ...target });
  }
  get specifier(): string {
    return this.#target.specifier;
  }
  focused() {
    return createFocusedInspectionConstruction(this.#target, this.#budget);
  }
  signatures() {
    return createSignatureInspectionConstruction(this.#target, this.#budget);
  }
  interfaceOverview(
    publicSubpaths: readonly PublicSubpath[],
    moduleExports: readonly {
      readonly name: string;
    }[],
    exportPage?: InterfaceOverview["exportPage"]
  ): InterfaceOverview {
    const retainedSubpaths = publicSubpaths.map((subpath) =>
      this.#budget.leaf(subpath)
    );

    const retainedExports = moduleExports.map((moduleExport) =>
      this.#budget.leaf(moduleExport)
    );

    const retainedPage =
      exportPage === undefined ? undefined : this.#budget.leaf(exportPage);

    return this.#budget.container(
      {
        intent: "interface-overview",
        resolutionVariant: this.#target.resolutionVariant,
        specifier: this.#target.specifier,
        ...this.#target.identity,
        moduleExports: retainedExports,
        publicSubpaths: retainedSubpaths,
        ...(retainedPage !== undefined && { exportPage: retainedPage }),
      },
      [
        ...retainedSubpaths,
        ...retainedExports,
        ...(retainedPage === undefined ? [] : [retainedPage]),
      ]
    );
  }
  exportSearchMatch(
    match: ExportSearch["matches"][number]
  ): ExportSearch["matches"][number] {
    return this.#budget.leaf(match);
  }
  exportSearch(
    query: string,
    totalModuleExports: number,
    matches: ExportSearch["matches"],
    scope?: ExportSearch["scope"]
  ): ExportSearch {
    const retainedMatches = matches;

    return this.#budget.container(
      {
        intent: "export-search",
        resolutionVariant: this.#target.resolutionVariant,
        specifier: this.#target.specifier,
        ...this.#target.identity,
        query,
        ...(scope !== undefined && { scope }),
        matches: retainedMatches,
        totalModuleExports,
      },
      retainedMatches
    );
  }
  consumeMemberCandidates(count: number): void {
    this.#memberCandidates += count;

    if (this.#memberCandidates > MAX_MEMBER_CANDIDATES) {
      throw new InspectionLimitError(
        "member-candidates",
        "Inspection exceeded its Member candidate limit."
      );
    }
  }
  memberDiscovery(
    moduleExportName: string,
    memberPath: MemberPath,
    query: string | undefined,
    totalMembers: number,
    members: MemberDiscovery["members"]
  ): MemberDiscovery {
    const retainedMembers = members.map((member) => this.#budget.leaf(member));

    return this.#budget.container(
      {
        intent: "member-discovery",
        resolutionVariant: this.#target.resolutionVariant,
        specifier: this.#target.specifier,
        ...this.#target.identity,
        memberPath,
        moduleExportName,
        ...(query !== undefined && { query }),
        members: retainedMembers,
        totalMembers,
      },
      retainedMembers
    );
  }
  publicSubpathDiscovery(
    publicSubpaths: readonly PublicSubpath[]
  ): PublicSubpathDiscovery {
    const retainedSubpaths = publicSubpaths.map((subpath) =>
      this.#budget.leaf(subpath)
    );

    return this.#budget.container(
      {
        intent: "public-subpath-discovery",
        resolutionVariant: this.#target.resolutionVariant,
        specifier: this.#target.specifier,
        ...this.#target.identity,
        publicSubpaths: retainedSubpaths,
      },
      retainedSubpaths
    );
  }
  plan(inspections: readonly AtomicInspectionResult[]): InspectionPlan {
    return this.#budget.container(
      { inspections, intent: "inspection-plan" },
      inspections
    );
  }
}
