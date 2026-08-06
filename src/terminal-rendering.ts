import type {
  ExportInspection,
  InspectedDeclaration,
  InspectionResult,
  InterfaceOverview,
  PackageIdentity,
} from "#typepeek/inspection";

const UNSAFE_TERMINAL_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x061c, 0x061c],
  [0x200e, 0x200f],
  [0x2028, 0x202e],
  [0x2066, 0x2069],
];

export function renderInspection(result: InspectionResult): string {
  return result.intent === "interface-overview"
    ? renderInterfaceOverview(result)
    : renderExportInspection(result);
}

function renderInterfaceOverview(result: InterfaceOverview): string {
  return [
    "Interface Overview",
    `Specifier: ${terminalSafeLine(result.specifier)}`,
    `Package: ${renderPackageIdentity(result.packageIdentity)}`,
    `Module Exports (${result.moduleExports.length}):`,
    ...result.moduleExports.map(({ name }) => `- ${terminalSafeLine(name)}`),
  ].join("\n");
}

function renderExportInspection(result: ExportInspection): string {
  const alias =
    result.moduleExport.alias === undefined
      ? ""
      : ` (alias of ${terminalSafeLine(result.moduleExport.alias.targetName)})`;
  return [
    "Export Inspection",
    `Specifier: ${terminalSafeLine(result.specifier)}`,
    `Package: ${renderPackageIdentity(result.packageIdentity)}`,
    `Module Export: ${terminalSafeLine(result.moduleExport.name)}${alias}`,
    ...(result.moduleExport.alias === undefined
      ? []
      : ["Alias Declaration:", ...renderDeclaration(result.moduleExport.alias.declaration)]),
    "Declaration Spaces:",
    ...result.moduleExport.spaces.flatMap(({ space, declarations }) => [
      `- ${terminalSafeLine(space)}`,
      ...declarations.flatMap(renderDeclaration),
    ]),
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

function terminalSafeLine(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return isUnsafeTerminalCodePoint(codePoint)
      ? `\\u{${codePoint.toString(16).toUpperCase()}}`
      : character;
  }).join("");
}

function isUnsafeTerminalCodePoint(codePoint: number): boolean {
  return UNSAFE_TERMINAL_RANGES.some(
    ([rangeStart, rangeEnd]) => codePoint >= rangeStart && codePoint <= rangeEnd,
  );
}
