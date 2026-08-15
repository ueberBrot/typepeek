/** Transport-neutral package API for CLI, MCP, and other inspection adapters. */
export {
  inspectExport,
  inspectExportSignatures,
  inspectInterfaceOverview,
} from "#typepeek/inspection/core";
export type {
  ExportDeclarationSpace,
  ExportInspection,
  ExportInspectionRequest,
  ExportNamespaceMember,
  InspectedDeclaration,
  InspectedSignature,
  InspectionOutcome,
  InspectionResult,
  InterfaceOverview,
  InterfaceOverviewRequest,
  PackageIdentity,
  ResolutionVariant,
  SignatureInspection,
  SignatureInspectionRequest,
  SignatureBinding,
  SignatureParameter,
  SignatureReturn,
  SignatureThisParameter,
  SignatureTypeParameter,
  SignatureTypeParameterModifier,
} from "#typepeek/inspection/protocol";
