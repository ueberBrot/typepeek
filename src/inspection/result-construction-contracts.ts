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
  InspectedModuleExportSignatures,
  InspectedSignature,
  InspectionResultIdentity,
  MemberInspection,
  PackageDocumentation,
  ResolutionVariant,
  SignatureInspection,
  SupportingType,
} from "#typepeek/inspection/protocol";

export interface InspectionResultConstructionTarget {
  readonly identity: InspectionResultIdentity;
  readonly resolutionVariant: ResolutionVariant;
  readonly specifier: string;
}

export interface FocusedInspectionConstruction {
  readonly declaration: <Value extends InspectedDeclaration>(
    value: Value
  ) => Value;
  readonly signature: (value: ExportSignature) => ExportSignature;
  readonly documentation: (value: PackageDocumentation) => PackageDocumentation;
  readonly alias: (
    targetName: string,
    declaration: ExportAlias["declaration"]
  ) => ExportAlias;
  readonly declarationSpace: (
    space: Exclude<DeclarationSpace, "namespace">,
    declarations: readonly InspectedDeclaration[]
  ) => ExportDeclarationSpace;
  readonly namespaceMember: (
    name: string,
    declarations: readonly InspectedDeclaration[],
    members: readonly ExportNamespaceMember[]
  ) => ExportNamespaceMember;
  readonly namespaceSpace: (
    members: readonly ExportNamespaceMember[]
  ) => ExportDeclarationSpace;
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
    declarations: readonly InspectedDeclaration[]
  ) => SupportingType;
  readonly exportResult: (
    moduleExport: InspectedModuleExport,
    supportingTypes: readonly SupportingType[],
    packageDocumentation: PackageDocumentation | undefined
  ) => ExportInspection;
  readonly declarationResult: (
    moduleExport: InspectedModuleExportDeclarations
  ) => DeclarationInspection;
  readonly memberResult: (
    moduleExportName: string,
    memberPath: MemberPath,
    declarations: readonly InspectedDeclaration[]
  ) => MemberInspection;
}

export interface SignatureInspectionConstruction {
  readonly signature: (value: InspectedSignature) => InspectedSignature;
  readonly moduleExport: (
    name: string,
    aliasTargetName: string | undefined,
    signatures: readonly InspectedSignature[]
  ) => InspectedModuleExportSignatures;
  readonly result: (
    moduleExport: InspectedModuleExportSignatures
  ) => SignatureInspection;
}
