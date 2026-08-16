import type {
  DeclarationInspection,
  ExportDeclarationSpace,
  ExportInspection,
  ExportNamespaceMember,
  ExportSearch,
  InspectedDeclaration,
  InspectionResult,
  InterfaceOverview,
  InspectionPlan,
  MemberInspection,
  PackageIdentity,
  PublicSubpathDiscovery,
  ResolutionVariant,
  SignatureInspection,
} from "#typepeek/inspection";
import { InspectionLimitError } from "#typepeek/inspection/errors";
import { terminalSafeLine } from "#typepeek/output-safety";

const MAX_TERMINAL_OUTPUT_BYTES = 128 * 1_024;

export interface TerminalRenderingOptions {
  readonly includePublicSubpaths?: boolean;
  readonly moduleExportMatch?: string;
}

/**
 * Renders a validated Inspection Result as deterministic plain text. Every
 * value originating in Installed Evidence is escaped before terminal display.
 */
export function renderInspection(
  result: InspectionResult,
  options: TerminalRenderingOptions = {},
): string {
  const rendered = renderInspectionResult(result, options);
  if (Buffer.byteLength(rendered) > MAX_TERMINAL_OUTPUT_BYTES) {
    throw new InspectionLimitError("Inspection exceeded its terminal output limit.");
  }
  return rendered;
}

function renderInspectionResult(
  result: InspectionResult,
  options: TerminalRenderingOptions,
): string {
  switch (result.intent) {
    case "interface-overview":
      return renderInterfaceOverview(
        result,
        options.includePublicSubpaths === true,
        options.moduleExportMatch,
      );
    case "export-inspection":
      return renderExportInspection(result);
    case "signature-inspection":
      return renderSignatureInspection(result);
    case "inspection-plan":
      return renderInspectionPlan(result, options);
    case "export-search":
      return renderExportSearch(result);
    case "public-subpath-discovery":
      return renderPublicSubpathDiscovery(result);
    case "declaration-inspection":
      return renderDeclarationInspection(result);
    case "member-inspection":
      return renderMemberInspection(result);
  }
}

function renderDeclarationInspection(result: DeclarationInspection): string {
  const alias =
    result.moduleExport.alias === undefined
      ? ""
      : ` (alias of ${terminalSafeLine(result.moduleExport.alias.targetName)})`;
  return [
    "Declaration Inspection",
    ...renderInspectionTarget(result.specifier, result.resolutionVariant),
    ...renderEvidenceIdentities(result.packageIdentity, result.declarationProvider),
    `Module Export: ${terminalSafeLine(result.moduleExport.name)}${alias}`,
    ...(result.moduleExport.alias === undefined
      ? []
      : ["Alias Declaration:", ...renderDeclaration(result.moduleExport.alias.declaration)]),
    "Declaration Spaces:",
    ...result.moduleExport.spaces.flatMap(renderDeclarationSpace),
  ].join("\n");
}

function renderMemberInspection(result: MemberInspection): string {
  return [
    "Member Inspection",
    ...renderInspectionTarget(result.specifier, result.resolutionVariant),
    ...renderEvidenceIdentities(result.packageIdentity, result.declarationProvider),
    `Member: ${terminalSafeLine([result.moduleExportName, ...result.memberPath].join("."))}`,
    ...result.declarations.flatMap(renderDeclaration),
  ].join("\n");
}

function renderExportSearch(result: ExportSearch): string {
  return [
    "Export Search",
    ...renderInspectionTarget(result.specifier, result.resolutionVariant),
    ...renderEvidenceIdentities(result.packageIdentity, result.declarationProvider),
    `Module Exports (${result.matches.length} matching "${terminalSafeLine(result.query)}"; ${result.totalModuleExports} total):`,
    ...result.matches.map(({ name }) => `- ${terminalSafeLine(name)}`),
  ].join("\n");
}

function renderPublicSubpathDiscovery(result: PublicSubpathDiscovery): string {
  return [
    "Public Subpath Discovery",
    ...renderInspectionTarget(result.specifier, result.resolutionVariant),
    ...renderEvidenceIdentities(result.packageIdentity, result.declarationProvider),
    `Public Subpaths (${result.publicSubpaths.length}):`,
    ...result.publicSubpaths.map(({ specifier }) => `- ${terminalSafeLine(specifier)}`),
  ].join("\n");
}

function renderInspectionPlan(result: InspectionPlan, options: TerminalRenderingOptions): string {
  return [
    `Inspection Plan (${result.inspections.length}):`,
    ...result.inspections.flatMap((inspection, index) => [
      `Inspection ${index + 1}:`,
      renderInspectionResult(inspection, options),
    ]),
  ].join("\n");
}

function renderInterfaceOverview(
  result: InterfaceOverview,
  includePublicSubpaths: boolean,
  moduleExportMatch: string | undefined,
): string {
  const moduleExports = matchingModuleExports(result, moduleExportMatch);
  return [
    "Interface Overview",
    ...renderInspectionTarget(result.specifier, result.resolutionVariant),
    ...renderEvidenceIdentities(result.packageIdentity, result.declarationProvider),
    renderModuleExportsHeading(result, moduleExports.length, moduleExportMatch),
    ...moduleExports.map(({ name }) => `- ${terminalSafeLine(name)}`),
    includePublicSubpaths
      ? `Public Subpaths (${result.publicSubpaths.length}):`
      : `Public Subpaths (${result.publicSubpaths.length}; use --subpaths to list):`,
    ...(includePublicSubpaths
      ? result.publicSubpaths.map(({ specifier }) => `- ${terminalSafeLine(specifier)}`)
      : []),
  ].join("\n");
}

function matchingModuleExports(
  result: InterfaceOverview,
  match: string | undefined,
): InterfaceOverview["moduleExports"] {
  if (match === undefined) {
    return result.moduleExports;
  }
  const normalizedMatch = match.toLowerCase();
  return result.moduleExports.filter(({ name }) => name.toLowerCase().includes(normalizedMatch));
}

function renderModuleExportsHeading(
  result: InterfaceOverview,
  matchedCount: number,
  match: string | undefined,
): string {
  return match === undefined
    ? `Module Exports (${result.moduleExports.length}):`
    : `Module Exports (${matchedCount} matching "${terminalSafeLine(match)}"; ${result.moduleExports.length} total):`;
}

function renderExportInspection(result: ExportInspection): string {
  const alias =
    result.moduleExport.alias === undefined
      ? ""
      : ` (alias of ${terminalSafeLine(result.moduleExport.alias.targetName)})`;
  return [
    "Export Inspection",
    ...renderInspectionTarget(result.specifier, result.resolutionVariant),
    ...renderEvidenceIdentities(result.packageIdentity, result.declarationProvider),
    `Module Export: ${terminalSafeLine(result.moduleExport.name)}${alias}`,
    ...(result.moduleExport.alias === undefined
      ? []
      : ["Alias Declaration:", ...renderDeclaration(result.moduleExport.alias.declaration)]),
    "Declaration Spaces:",
    ...result.moduleExport.spaces.flatMap(renderDeclarationSpace),
    `Signatures (${result.moduleExport.signatures.length}):`,
    ...result.moduleExport.signatures.map(
      ({ kind, text }) => `- ${terminalSafeLine(kind)}: ${terminalSafeLine(text)}`,
    ),
    `Supporting Types (${result.supportingTypes.length}):`,
    ...result.supportingTypes.flatMap(({ name, declarations }) => [
      `- ${terminalSafeLine(name)}`,
      ...declarations.flatMap(renderDeclaration),
    ]),
    ...(result.packageDocumentation === undefined
      ? []
      : [
          "Package Documentation (untrusted Installed Evidence):",
          ...result.packageDocumentation.text
            .split("\n")
            .map((line) => `| ${terminalSafeLine(line)}`),
        ]),
  ].join("\n");
}

function renderSignatureInspection(result: SignatureInspection): string {
  const alias =
    result.moduleExport.aliasTargetName === undefined
      ? ""
      : ` (alias of ${terminalSafeLine(result.moduleExport.aliasTargetName)})`;
  return [
    "Signature Inspection",
    ...renderInspectionTarget(result.specifier, result.resolutionVariant),
    ...renderEvidenceIdentities(result.packageIdentity, result.declarationProvider),
    `Module Export: ${terminalSafeLine(result.moduleExport.name)}${alias}`,
    `Signatures (${result.moduleExport.signatures.length}):`,
    ...result.moduleExport.signatures.map(
      ({ kind, text }) => `- ${terminalSafeLine(kind)}: ${terminalSafeLine(text)}`,
    ),
  ].join("\n");
}

function renderDeclarationSpace(space: ExportDeclarationSpace): readonly string[] {
  return space.space === "namespace"
    ? [
        `- ${terminalSafeLine(space.space)}`,
        ...space.members.flatMap((member) => renderNamespaceMember(member, [])),
      ]
    : [`- ${terminalSafeLine(space.space)}`, ...space.declarations.flatMap(renderDeclaration)];
}

function renderNamespaceMember(
  member: ExportNamespaceMember,
  parentPath: readonly string[],
): readonly string[] {
  const path = [...parentPath, member.name];
  return [
    `  ${terminalSafeLine(path.join("."))}:`,
    ...member.declarations.flatMap(renderDeclaration),
    ...member.members.flatMap((child) => renderNamespaceMember(child, path)),
  ];
}

function renderDeclaration(declaration: InspectedDeclaration): readonly string[] {
  return [
    `  ${terminalSafeLine(declaration.kind)}:`,
    ...declaration.text.split("\n").map((line) => `    ${terminalSafeLine(line)}`),
    `  @ ${renderPackageIdentity(declaration.provenance.packageIdentity)}:${terminalSafeLine(declaration.provenance.file)}:${declaration.provenance.line}:${declaration.provenance.column}`,
  ];
}

function renderPackageIdentity(packageIdentity: PackageIdentity): string {
  const version =
    packageIdentity.version === undefined ? "" : `@${terminalSafeLine(packageIdentity.version)}`;
  return `${terminalSafeLine(packageIdentity.name)}${version}`;
}

function renderEvidenceIdentities(
  packageIdentity: PackageIdentity | undefined,
  declarationProvider: PackageIdentity | undefined,
): readonly string[] {
  return [
    ...(packageIdentity === undefined
      ? []
      : [`Package: ${renderPackageIdentity(packageIdentity)}`]),
    ...(declarationProvider === undefined
      ? []
      : [`Declaration Provider: ${renderPackageIdentity(declarationProvider)}`]),
  ];
}

function renderInspectionTarget(
  specifier: string,
  resolutionVariant: ResolutionVariant,
): readonly string[] {
  return [
    `Specifier: ${terminalSafeLine(specifier)}`,
    `Access Style: ${terminalSafeLine(resolutionVariant.accessStyle)}`,
  ];
}
