import { InspectionLimitError } from "#typepeek/inspection/errors";
import type {
  DeclarationSpace,
  DeclarationInspection,
  ExportAlias,
  ExportDeclarationSpace,
  ExportInspection,
  ExportNamespaceMember,
  ExportSignature,
  ExportSearch,
  InspectedDeclaration,
  InspectedModuleExport,
  InspectedModuleExportDeclarations,
  InspectionPlan,
  InspectionResultIdentity,
  InterfaceOverview,
  InspectedSignature,
  InspectedModuleExportSignatures,
  PackageDocumentation,
  PublicSubpath,
  PublicSubpathDiscovery,
  ResolutionVariant,
  SignatureInspection,
  SupportingType,
  AtomicInspectionResult,
  MemberInspection,
} from "#typepeek/inspection/protocol";

const MAX_RESULT_CONSTRUCTION_BYTES = 60 * 1_024;
const MAX_RESULT_NODES = 4_096;

interface FragmentSize {
  readonly bytes: number;
  readonly nodes: number;
}

export interface InspectionResultConstructionContext {
  readonly identity: InspectionResultIdentity;
  readonly resolutionVariant: ResolutionVariant;
  readonly specifier: string;
}

class ResultConstructionBudget {
  readonly #fragmentSizes = new WeakMap<object, FragmentSize>();
  #bytes = 0;
  #nodes = 0;

  leaf<Value extends object>(value: Value): Value {
    return this.#retain(value, []);
  }

  container<Value extends object>(value: Value, children: readonly object[]): Value {
    return this.#retain(value, children);
  }

  #retain<Value extends object>(value: Value, children: readonly object[]): Value {
    const size = measuredFragmentSize(value);
    const childSize = children.reduce<FragmentSize>(
      (total, child) => {
        const retained = this.#fragmentSizes.get(child);
        if (retained === undefined) {
          throw new Error("Inspection Result construction received an unretained child fragment.");
        }
        return { bytes: total.bytes + retained.bytes, nodes: total.nodes + retained.nodes };
      },
      { bytes: 0, nodes: 0 } satisfies FragmentSize,
    );
    this.#bytes += size.bytes - childSize.bytes;
    this.#nodes += size.nodes - childSize.nodes;
    if (this.#bytes > MAX_RESULT_CONSTRUCTION_BYTES || this.#nodes > MAX_RESULT_NODES) {
      throw new InspectionLimitError(
        "result-construction",
        "Inspection exceeded its output limit.",
      );
    }
    this.#fragmentSizes.set(value, size);
    return value;
  }
}

const constructionBudgets = new WeakMap<
  InspectionResultConstructionContext,
  ResultConstructionBudget
>();

export function createInspectionResultConstructionContext(
  context: Omit<InspectionResultConstructionContext, "budget">,
): InspectionResultConstructionContext {
  const constructionContext = { ...context };
  constructionBudgets.set(constructionContext, new ResultConstructionBudget());
  return constructionContext;
}

function constructionBudget(
  context: InspectionResultConstructionContext,
): ResultConstructionBudget {
  const budget = constructionBudgets.get(context);
  if (budget === undefined) {
    throw new Error("Inspection Result construction received an unowned context.");
  }
  return budget;
}

/** Owns exact aggregate accounting and assembly for one Export Inspection. */
export class FocusedInspectionConstruction {
  readonly #budget: ResultConstructionBudget;
  readonly #context: InspectionResultConstructionContext;

  constructor(context: InspectionResultConstructionContext) {
    this.#context = context;
    this.#budget = constructionBudget(context);
  }

  declaration<Value extends InspectedDeclaration>(value: Value): Value {
    return this.#budget.leaf(value);
  }

  signature(value: ExportSignature): ExportSignature {
    return this.#budget.leaf(value);
  }

  documentation(value: PackageDocumentation): PackageDocumentation {
    return this.#budget.leaf(value);
  }

  alias(targetName: string, declaration: ExportAlias["declaration"]): ExportAlias {
    return this.#budget.container({ targetName, declaration }, [declaration]);
  }

  declarationSpace(
    space: Exclude<DeclarationSpace, "namespace">,
    declarations: readonly InspectedDeclaration[],
  ): ExportDeclarationSpace {
    return this.#budget.container({ space, declarations }, declarations);
  }

  namespaceMember(
    name: string,
    declarations: readonly InspectedDeclaration[],
    members: readonly ExportNamespaceMember[],
  ): ExportNamespaceMember {
    return this.#budget.container({ name, declarations, members }, [...declarations, ...members]);
  }

  namespaceSpace(members: readonly ExportNamespaceMember[]): ExportDeclarationSpace {
    return this.#budget.container({ space: "namespace", members }, members);
  }

  moduleExport(options: {
    readonly alias?: ExportAlias;
    readonly name: string;
    readonly signatures: readonly ExportSignature[];
    readonly spaces: readonly ExportDeclarationSpace[];
  }): InspectedModuleExport {
    const value = {
      name: options.name,
      ...(options.alias === undefined ? {} : { alias: options.alias }),
      spaces: options.spaces,
      signatures: options.signatures,
    };
    return this.#budget.container(value, [
      ...(options.alias === undefined ? [] : [options.alias]),
      ...options.spaces,
      ...options.signatures,
    ]);
  }

  moduleExportDeclarations(options: {
    readonly alias?: ExportAlias;
    readonly name: string;
    readonly spaces: readonly ExportDeclarationSpace[];
  }): InspectedModuleExportDeclarations {
    const value = {
      name: options.name,
      ...(options.alias === undefined ? {} : { alias: options.alias }),
      spaces: options.spaces,
    };
    return this.#budget.container(value, [
      ...(options.alias === undefined ? [] : [options.alias]),
      ...options.spaces,
    ]);
  }

  supportingType(name: string, declarations: readonly InspectedDeclaration[]): SupportingType {
    return this.#budget.container({ name, declarations }, declarations);
  }

  exportResult(
    moduleExport: InspectedModuleExport,
    supportingTypes: readonly SupportingType[],
    packageDocumentation: PackageDocumentation | undefined,
  ): ExportInspection {
    const result: ExportInspection = {
      intent: "export-inspection",
      specifier: this.#context.specifier,
      resolutionVariant: this.#context.resolutionVariant,
      ...this.#context.identity,
      moduleExport,
      supportingTypes,
      ...(packageDocumentation === undefined ? {} : { packageDocumentation }),
    };
    return this.#budget.container(result, [
      moduleExport,
      ...supportingTypes,
      ...(packageDocumentation === undefined ? [] : [packageDocumentation]),
    ]);
  }

  declarationResult(moduleExport: InspectedModuleExportDeclarations): DeclarationInspection {
    return this.#budget.container(
      {
        intent: "declaration-inspection",
        specifier: this.#context.specifier,
        resolutionVariant: this.#context.resolutionVariant,
        ...this.#context.identity,
        moduleExport,
      },
      [moduleExport],
    );
  }

  memberResult(
    moduleExportName: string,
    memberPath: readonly string[],
    declarations: readonly InspectedDeclaration[],
  ): MemberInspection {
    return this.#budget.container(
      {
        intent: "member-inspection",
        specifier: this.#context.specifier,
        resolutionVariant: this.#context.resolutionVariant,
        ...this.#context.identity,
        moduleExportName,
        memberPath,
        declarations,
      },
      declarations,
    );
  }
}

/** Owns aggregate accounting and assembly for one Signature Inspection. */
export class SignatureInspectionConstruction {
  readonly #budget: ResultConstructionBudget;
  readonly #context: InspectionResultConstructionContext;

  constructor(context: InspectionResultConstructionContext) {
    this.#context = context;
    this.#budget = constructionBudget(context);
  }

  signature(value: InspectedSignature): InspectedSignature {
    return this.#budget.leaf(value);
  }

  moduleExport(
    name: string,
    aliasTargetName: string | undefined,
    signatures: readonly InspectedSignature[],
  ): InspectedModuleExportSignatures {
    return this.#budget.container(
      {
        name,
        ...(aliasTargetName === undefined ? {} : { aliasTargetName }),
        signatures,
      },
      signatures,
    );
  }

  result(moduleExport: InspectedModuleExportSignatures): SignatureInspection {
    return this.#budget.container(
      {
        intent: "signature-inspection",
        specifier: this.#context.specifier,
        resolutionVariant: this.#context.resolutionVariant,
        ...this.#context.identity,
        moduleExport,
      },
      [moduleExport],
    );
  }
}

/** Assembles and exactly charges one bounded Interface Overview. */
export function constructInterfaceOverview(
  context: InspectionResultConstructionContext,
  publicSubpaths: readonly PublicSubpath[],
  moduleExports: readonly { readonly name: string }[],
): InterfaceOverview {
  const budget = constructionBudget(context);
  const retainedSubpaths = publicSubpaths.map((subpath) => budget.leaf(subpath));
  const retainedExports = moduleExports.map((moduleExport) => budget.leaf(moduleExport));
  return budget.container(
    {
      intent: "interface-overview",
      specifier: context.specifier,
      resolutionVariant: context.resolutionVariant,
      ...context.identity,
      publicSubpaths: retainedSubpaths,
      moduleExports: retainedExports,
    },
    [...retainedSubpaths, ...retainedExports],
  );
}

/** Assembles one bounded case-insensitive Module Export search result. */
export function constructExportSearch(
  context: InspectionResultConstructionContext,
  query: string,
  totalModuleExports: number,
  matches: readonly { readonly name: string }[],
): ExportSearch {
  const budget = constructionBudget(context);
  const retainedMatches = matches.map((match) => budget.leaf(match));
  return budget.container(
    {
      intent: "export-search",
      specifier: context.specifier,
      resolutionVariant: context.resolutionVariant,
      ...context.identity,
      query,
      totalModuleExports,
      matches: retainedMatches,
    },
    retainedMatches,
  );
}

/** Assembles bounded manifest-only Public Subpath discovery evidence. */
export function constructPublicSubpathDiscovery(
  context: InspectionResultConstructionContext,
  publicSubpaths: readonly PublicSubpath[],
): PublicSubpathDiscovery {
  const budget = constructionBudget(context);
  const retainedSubpaths = publicSubpaths.map((subpath) => budget.leaf(subpath));
  return budget.container(
    {
      intent: "public-subpath-discovery",
      specifier: context.specifier,
      resolutionVariant: context.resolutionVariant,
      ...context.identity,
      publicSubpaths: retainedSubpaths,
    },
    retainedSubpaths,
  );
}

/** Completes one ordered plan while charging its children to the same aggregate budget. */
export function constructInspectionPlan(
  context: InspectionResultConstructionContext,
  inspections: readonly AtomicInspectionResult[],
): InspectionPlan {
  return constructionBudget(context).container(
    { intent: "inspection-plan", inspections },
    inspections,
  );
}

function measuredFragmentSize(value: object): FragmentSize {
  return {
    bytes: Buffer.byteLength(JSON.stringify(value)),
    nodes: countResultNodes(value),
  };
}

function countResultNodes(value: unknown): number {
  if (value === null || typeof value !== "object") {
    return 1;
  }
  return 1 + Object.values(value).reduce((count, child) => count + countResultNodes(child), 0);
}
