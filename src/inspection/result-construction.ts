import {
  MAX_RESULT_CONSTRUCTION_BYTES,
  MAX_RESULT_CONSTRUCTION_NODES,
} from "#typepeek/inspection/budget-policy";
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

interface FragmentSize {
  readonly bytes: number;
  readonly nodes: number;
}

interface InspectionResultConstructionTarget {
  readonly identity: InspectionResultIdentity;
  readonly resolutionVariant: ResolutionVariant;
  readonly specifier: string;
}

export interface FocusedInspectionConstruction {
  readonly declaration: <Value extends InspectedDeclaration>(value: Value) => Value;
  readonly signature: (value: ExportSignature) => ExportSignature;
  readonly documentation: (value: PackageDocumentation) => PackageDocumentation;
  readonly alias: (targetName: string, declaration: ExportAlias["declaration"]) => ExportAlias;
  readonly declarationSpace: (
    space: Exclude<DeclarationSpace, "namespace">,
    declarations: readonly InspectedDeclaration[],
  ) => ExportDeclarationSpace;
  readonly namespaceMember: (
    name: string,
    declarations: readonly InspectedDeclaration[],
    members: readonly ExportNamespaceMember[],
  ) => ExportNamespaceMember;
  readonly namespaceSpace: (members: readonly ExportNamespaceMember[]) => ExportDeclarationSpace;
  readonly moduleExport: (options: {
    readonly alias?: ExportAlias;
    readonly name: string;
    readonly signatures: readonly ExportSignature[];
    readonly spaces: readonly ExportDeclarationSpace[];
  }) => InspectedModuleExport;
  readonly moduleExportDeclarations: (options: {
    readonly alias?: ExportAlias;
    readonly name: string;
    readonly spaces: readonly ExportDeclarationSpace[];
  }) => InspectedModuleExportDeclarations;
  readonly supportingType: (
    name: string,
    declarations: readonly InspectedDeclaration[],
  ) => SupportingType;
  readonly exportResult: (
    moduleExport: InspectedModuleExport,
    supportingTypes: readonly SupportingType[],
    packageDocumentation: PackageDocumentation | undefined,
  ) => ExportInspection;
  readonly declarationResult: (
    moduleExport: InspectedModuleExportDeclarations,
  ) => DeclarationInspection;
  readonly memberResult: (
    moduleExportName: string,
    memberPath: readonly string[],
    declarations: readonly InspectedDeclaration[],
  ) => MemberInspection;
}

export interface SignatureInspectionConstruction {
  readonly signature: (value: InspectedSignature) => InspectedSignature;
  readonly moduleExport: (
    name: string,
    aliasTargetName: string | undefined,
    signatures: readonly InspectedSignature[],
  ) => InspectedModuleExportSignatures;
  readonly result: (moduleExport: InspectedModuleExportSignatures) => SignatureInspection;
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
    if (
      this.#bytes > MAX_RESULT_CONSTRUCTION_BYTES ||
      this.#nodes > MAX_RESULT_CONSTRUCTION_NODES
    ) {
      throw new InspectionLimitError(
        "result-construction",
        "Inspection exceeded its output limit.",
      );
    }
    this.#fragmentSizes.set(value, size);
    return value;
  }
}

/** Applies the canonical aggregate result budget to a fully assembled core result. */
export function assertInspectionResultConstructionBound(value: object): void {
  new ResultConstructionBudget().leaf(value);
}

/** Owns one aggregate Inspection Result construction budget and all assembly paths. */
export class InspectionResultConstruction {
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
    moduleExports: readonly { readonly name: string }[],
  ): InterfaceOverview {
    const retainedSubpaths = publicSubpaths.map((subpath) => this.#budget.leaf(subpath));
    const retainedExports = moduleExports.map((moduleExport) => this.#budget.leaf(moduleExport));
    return this.#budget.container(
      {
        intent: "interface-overview",
        specifier: this.#target.specifier,
        resolutionVariant: this.#target.resolutionVariant,
        ...this.#target.identity,
        publicSubpaths: retainedSubpaths,
        moduleExports: retainedExports,
      },
      [...retainedSubpaths, ...retainedExports],
    );
  }

  exportSearch(
    query: string,
    totalModuleExports: number,
    matches: readonly { readonly name: string }[],
  ): ExportSearch {
    const retainedMatches = matches.map((match) => this.#budget.leaf(match));
    return this.#budget.container(
      {
        intent: "export-search",
        specifier: this.#target.specifier,
        resolutionVariant: this.#target.resolutionVariant,
        ...this.#target.identity,
        query,
        totalModuleExports,
        matches: retainedMatches,
      },
      retainedMatches,
    );
  }

  publicSubpathDiscovery(publicSubpaths: readonly PublicSubpath[]): PublicSubpathDiscovery {
    const retainedSubpaths = publicSubpaths.map((subpath) => this.#budget.leaf(subpath));
    return this.#budget.container(
      {
        intent: "public-subpath-discovery",
        specifier: this.#target.specifier,
        resolutionVariant: this.#target.resolutionVariant,
        ...this.#target.identity,
        publicSubpaths: retainedSubpaths,
      },
      retainedSubpaths,
    );
  }

  plan(inspections: readonly AtomicInspectionResult[]): InspectionPlan {
    return this.#budget.container({ intent: "inspection-plan", inspections }, inspections);
  }
}

/** Owns exact aggregate accounting and assembly for one Export Inspection. */
class FocusedInspectionResultConstruction implements FocusedInspectionConstruction {
  readonly #budget: ResultConstructionBudget;
  readonly #target: InspectionResultConstructionTarget;

  constructor(target: InspectionResultConstructionTarget, budget: ResultConstructionBudget) {
    this.#target = target;
    this.#budget = budget;
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
      specifier: this.#target.specifier,
      resolutionVariant: this.#target.resolutionVariant,
      ...this.#target.identity,
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
        specifier: this.#target.specifier,
        resolutionVariant: this.#target.resolutionVariant,
        ...this.#target.identity,
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
        specifier: this.#target.specifier,
        resolutionVariant: this.#target.resolutionVariant,
        ...this.#target.identity,
        moduleExportName,
        memberPath,
        declarations,
      },
      declarations,
    );
  }
}

/** Owns aggregate accounting and assembly for one Signature Inspection. */
class OwnedSignatureInspectionConstruction implements SignatureInspectionConstruction {
  readonly #budget: ResultConstructionBudget;
  readonly #target: InspectionResultConstructionTarget;

  constructor(target: InspectionResultConstructionTarget, budget: ResultConstructionBudget) {
    this.#target = target;
    this.#budget = budget;
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
        specifier: this.#target.specifier,
        resolutionVariant: this.#target.resolutionVariant,
        ...this.#target.identity,
        moduleExport,
      },
      [moduleExport],
    );
  }
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
