/** Transport-neutral package API for the CLI and future inspection adapters. */
export {
  comparePublicInterfaces,
  inspectExport,
  inspectExportDeclarations,
  inspectExportMember,
  inspectExportSearch,
  inspectExportSignatures,
  inspectInterfaceOverview,
  inspectPlan,
  inspectPublicSubpaths,
} from "#typepeek/inspection/core";
export {
  INSPECTION_INTENTS,
  INSPECTION_PROTOCOL_VERSION,
  inspectCapabilities,
  inspectionCapabilitiesSchema,
} from "#typepeek/inspection/protocol-metadata";
export { invokeInspectionProtocol } from "#typepeek/inspection/inspection-protocol";
export type {
  AtomicInspectionResult,
  DeclarationInspection,
  ExportDeclarationSpace,
  ExportInspection,
  ExportSearch,
  ExportNamespaceMember,
  InspectedDeclaration,
  InspectionPlan,
  InspectionPlanQuery,
  InspectionResult,
  InspectionRequestByIntent,
  InterfaceOverview,
  MemberInspection,
  PackageIdentity,
  PublicSubpathDiscovery,
  PublicInterfaceComparison,
  PublicInterfaceComparisonTarget,
  ResolutionVariant,
  SignatureInspection,
} from "#typepeek/inspection/protocol";
export type {
  InspectionProtocolRequest,
  InspectionProtocolResponse,
} from "#typepeek/inspection/inspection-protocol-schema";
export type { InspectionIntent } from "#typepeek/inspection/protocol-metadata";
