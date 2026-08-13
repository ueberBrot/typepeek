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
  InspectionOutcome,
  InspectionResult,
  InterfaceOverview,
  InterfaceOverviewRequest,
  PackageIdentity,
  SignatureInspection,
  SignatureInspectionRequest,
} from "#typepeek/inspection/protocol";
