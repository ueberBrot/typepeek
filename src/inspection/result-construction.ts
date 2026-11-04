import { MAX_MEMBER_CANDIDATES } from "#typepeek/inspection/budget-policy";
import { InspectionLimitError } from "#typepeek/inspection/errors";
import { FocusedInspectionResultConstruction } from "#typepeek/inspection/focused-result-construction";
import type { MemberPath } from "#typepeek/inspection/member-path";
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-object-parameters -- The construction budget measures heterogeneous trusted result fragments without changing their domain types. */
import type {
  AtomicInspectionResult,
  ExportSearch,
  InspectionPlan,
  InspectionResultIdentity,
  InterfaceOverview,
  MemberDiscovery,
  PublicSubpath,
  PublicSubpathDiscovery,
  ResolutionVariant,
} from "#typepeek/inspection/protocol";
import { ResultConstructionBudget } from "#typepeek/inspection/result-construction-budget";
import type {
  FocusedInspectionConstruction,
  InspectionResultConstructionTarget,
  SignatureInspectionConstruction,
} from "#typepeek/inspection/result-construction-contracts";
import { OwnedSignatureInspectionConstruction } from "#typepeek/inspection/signature-result-construction";

export type {
  FocusedInspectionConstruction,
  SignatureInspectionConstruction,
} from "#typepeek/inspection/result-construction-contracts";

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
  focused(): FocusedInspectionConstruction {
    return new FocusedInspectionResultConstruction(this.#target, this.#budget);
  }
  signatures(): SignatureInspectionConstruction {
    return new OwnedSignatureInspectionConstruction(this.#target, this.#budget);
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
