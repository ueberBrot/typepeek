import type { MemberPath } from "#typepeek/inspection/member-path";
import type {
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
  MemberInspection,
  PackageDocumentation,
  SupportingType,
} from "#typepeek/inspection/protocol";
import type { ResultConstructionBudget } from "#typepeek/inspection/result-construction-budget";
import type {
  FocusedInspectionConstruction,
  InspectionResultConstructionTarget,
} from "#typepeek/inspection/result-construction-contracts";

export class FocusedInspectionResultConstruction implements FocusedInspectionConstruction {
  readonly #budget: ResultConstructionBudget;
  readonly #target: InspectionResultConstructionTarget;
  constructor(
    target: InspectionResultConstructionTarget,
    budget: ResultConstructionBudget
  ) {
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
  alias(
    targetName: string,
    declaration: ExportAlias["declaration"]
  ): ExportAlias {
    return this.#budget.container({ declaration, targetName }, [declaration]);
  }
  declarationSpace(
    space: Exclude<DeclarationSpace, "namespace">,
    declarations: readonly InspectedDeclaration[]
  ): ExportDeclarationSpace {
    return this.#budget.container({ declarations, space }, declarations);
  }
  namespaceMember(
    name: string,
    declarations: readonly InspectedDeclaration[],
    members: readonly ExportNamespaceMember[]
  ): ExportNamespaceMember {
    return this.#budget.container({ declarations, members, name }, [
      ...declarations,
      ...members,
    ]);
  }
  namespaceSpace(
    members: readonly ExportNamespaceMember[]
  ): ExportDeclarationSpace {
    return this.#budget.container({ members, space: "namespace" }, members);
  }
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
      ...(options.alias !== undefined && { alias: options.alias }),
      spaces: options.spaces,
    };

    return this.#budget.container(value, [
      ...(options.alias === undefined ? [] : [options.alias]),
      ...options.spaces,
    ]);
  }
  supportingType(
    name: string,
    declarations: readonly InspectedDeclaration[]
  ): SupportingType {
    return this.#budget.container({ declarations, name }, declarations);
  }
  exportResult(
    moduleExport: InspectedModuleExport,
    supportingTypes: readonly SupportingType[],
    packageDocumentation: PackageDocumentation | undefined
  ): ExportInspection {
    const result: ExportInspection = {
      intent: "export-inspection",
      resolutionVariant: this.#target.resolutionVariant,
      specifier: this.#target.specifier,
      ...this.#target.identity,
      moduleExport,
      supportingTypes,
      ...(packageDocumentation !== undefined && { packageDocumentation }),
    };

    return this.#budget.container(result, [
      moduleExport,
      ...supportingTypes,
      ...(packageDocumentation === undefined ? [] : [packageDocumentation]),
    ]);
  }
  declarationResult(
    moduleExport: InspectedModuleExportDeclarations
  ): DeclarationInspection {
    return this.#budget.container(
      {
        intent: "declaration-inspection",
        resolutionVariant: this.#target.resolutionVariant,
        specifier: this.#target.specifier,
        ...this.#target.identity,
        moduleExport,
      },
      [moduleExport]
    );
  }
  memberResult(
    moduleExportName: string,
    memberPath: MemberPath,
    declarations: readonly InspectedDeclaration[]
  ): MemberInspection {
    return this.#budget.container(
      {
        intent: "member-inspection",
        resolutionVariant: this.#target.resolutionVariant,
        specifier: this.#target.specifier,
        ...this.#target.identity,
        declarations,
        memberPath,
        moduleExportName,
      },
      declarations
    );
  }
}
