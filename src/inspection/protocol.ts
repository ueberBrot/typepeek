export type AccessStyle = "import" | "require";

export interface InterfaceOverviewRequest {
  readonly resolutionContext: string;
  readonly specifier: string;
  readonly accessStyle?: AccessStyle;
}

export interface NormalizedInspectionTarget {
  readonly resolutionContext: string;
  readonly specifier: string;
  readonly accessStyle: AccessStyle;
}

export type NormalizedInterfaceOverviewRequest = NormalizedInspectionTarget;

export interface ExportInspectionRequest extends InterfaceOverviewRequest {
  readonly exportName: string;
}

export interface NormalizedExportInspectionRequest extends NormalizedInspectionTarget {
  readonly exportName: string;
}

export interface ModuleExportIndexEntry {
  readonly name: string;
}

export interface PackageIdentity {
  readonly name: string;
  readonly version?: string;
}

export interface InterfaceOverview {
  readonly intent: "interface-overview";
  readonly specifier: string;
  readonly packageIdentity: PackageIdentity;
  readonly moduleExports: readonly ModuleExportIndexEntry[];
}

export type DeclarationSpace = "type" | "value" | "namespace";

export type DeclarationKind =
  | "alias"
  | "class"
  | "enum"
  | "function"
  | "interface"
  | "namespace"
  | "type-alias"
  | "variable";

export interface DeclarationProvenance {
  readonly packageIdentity: PackageIdentity;
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export interface InspectedDeclaration {
  readonly kind: DeclarationKind;
  readonly text: string;
  readonly provenance: DeclarationProvenance;
}

export interface ExportTypeOrValueDeclarationSpace {
  readonly space: "type" | "value";
  readonly declarations: readonly InspectedDeclaration[];
}

export interface ExportNamespaceMember {
  readonly name: string;
  readonly declarations: readonly InspectedDeclaration[];
  readonly members: readonly ExportNamespaceMember[];
}

export interface ExportNamespaceDeclarationSpace {
  readonly space: "namespace";
  readonly members: readonly ExportNamespaceMember[];
}

export type ExportDeclarationSpace =
  | ExportTypeOrValueDeclarationSpace
  | ExportNamespaceDeclarationSpace;

export interface ExportAlias {
  readonly targetName: string;
  readonly declaration: InspectedDeclaration;
}

export interface ExportSignature {
  readonly kind: "call" | "construct";
  readonly text: string;
}

export interface InspectedModuleExport {
  readonly name: string;
  readonly alias?: ExportAlias;
  readonly spaces: readonly ExportDeclarationSpace[];
  readonly signatures: readonly ExportSignature[];
}

export interface SupportingType {
  readonly name: string;
  readonly declarations: readonly InspectedDeclaration[];
}

export interface PackageDocumentation {
  readonly provenance: "installed-evidence";
  readonly trust: "untrusted";
  readonly text: string;
}

export interface ExportInspection {
  readonly intent: "export-inspection";
  readonly specifier: string;
  readonly packageIdentity: PackageIdentity;
  readonly moduleExport: InspectedModuleExport;
  readonly supportingTypes: readonly SupportingType[];
  readonly packageDocumentation?: PackageDocumentation;
}

export type InspectionResult = InterfaceOverview | ExportInspection;

export interface InspectionFailure {
  readonly status: "not-found" | "unsupported" | "limit-exceeded";
  readonly message: string;
}

export type InspectionOutcome<Result extends InspectionResult = InspectionResult> =
  | {
      readonly status: "success";
      readonly result: Result;
    }
  | InspectionFailure;

export type InspectionRequestReading<Request> =
  | {
      readonly accepted: true;
      readonly request: Request;
    }
  | {
      readonly accepted: false;
      readonly outcome: InspectionFailure;
    };

export type AnalysisRequest =
  | {
      readonly intent: "interface-overview";
      readonly request: NormalizedInterfaceOverviewRequest;
    }
  | {
      readonly intent: "export-inspection";
      readonly request: NormalizedExportInspectionRequest;
    };

export type AnalysisRequestReading =
  | {
      readonly accepted: true;
      readonly request: AnalysisRequest;
    }
  | {
      readonly accepted: false;
      readonly outcome: InspectionFailure;
    };

const FAILURE_STATUSES = new Set(["not-found", "unsupported", "limit-exceeded"]);
const INVALID_ANALYSIS_REQUEST_OUTCOME: InspectionFailure = {
  status: "unsupported",
  message: "Inspection received an invalid request.",
};
const INVALID_REQUEST_OUTCOMES = {
  "interface-overview": {
    status: "unsupported",
    message: "Inspection received an invalid Interface Overview request.",
  },
  "export-inspection": {
    status: "unsupported",
    message: "Inspection received an invalid Export Inspection request.",
  },
} as const satisfies Readonly<Record<InspectionResult["intent"], InspectionFailure>>;
const INVALID_RESULT_OUTCOME: InspectionFailure = {
  status: "unsupported",
  message: "Inspection returned an invalid result.",
};

export function readInspectionRequest(
  intent: "interface-overview",
  value: unknown,
): InspectionRequestReading<NormalizedInterfaceOverviewRequest>;
export function readInspectionRequest(
  intent: "export-inspection",
  value: unknown,
): InspectionRequestReading<NormalizedExportInspectionRequest>;
export function readInspectionRequest(
  intent: InspectionResult["intent"],
  value: unknown,
):
  | InspectionRequestReading<NormalizedInterfaceOverviewRequest>
  | InspectionRequestReading<NormalizedExportInspectionRequest> {
  const target = readInspectionTarget(value);
  if (target === undefined) {
    return { accepted: false, outcome: INVALID_REQUEST_OUTCOMES[intent] };
  }
  if (intent === "interface-overview") {
    return { accepted: true, request: target };
  }
  return isRecord(value) && typeof value["exportName"] === "string"
    ? {
        accepted: true,
        request: {
          ...target,
          exportName: value["exportName"],
        },
      }
    : { accepted: false, outcome: INVALID_REQUEST_OUTCOMES[intent] };
}

export function readAnalysisRequest(value: unknown): AnalysisRequestReading {
  if (!isRecord(value)) {
    return { accepted: false, outcome: INVALID_ANALYSIS_REQUEST_OUTCOME };
  }

  if (value["intent"] === "interface-overview") {
    const reading = readInspectionRequest(value["intent"], value["request"]);
    return reading.accepted
      ? {
          accepted: true,
          request: { intent: value["intent"], request: reading.request },
        }
      : { accepted: false, outcome: INVALID_ANALYSIS_REQUEST_OUTCOME };
  }
  if (value["intent"] === "export-inspection") {
    const reading = readInspectionRequest(value["intent"], value["request"]);
    return reading.accepted
      ? {
          accepted: true,
          request: { intent: value["intent"], request: reading.request },
        }
      : { accepted: false, outcome: INVALID_ANALYSIS_REQUEST_OUTCOME };
  }
  return { accepted: false, outcome: INVALID_ANALYSIS_REQUEST_OUTCOME };
}

export function enforceInspectionOutcome(
  intent: "interface-overview",
  value: unknown,
): InspectionOutcome<InterfaceOverview>;
export function enforceInspectionOutcome(
  intent: "export-inspection",
  value: unknown,
): InspectionOutcome<ExportInspection>;
export function enforceInspectionOutcome(
  intent: InspectionResult["intent"],
  value: unknown,
): InspectionOutcome;
export function enforceInspectionOutcome(
  intent: InspectionResult["intent"],
  value: unknown,
): InspectionOutcome {
  if (!isInspectionOutcome(value)) {
    return INVALID_RESULT_OUTCOME;
  }
  return value.status !== "success" || value.result.intent === intent
    ? value
    : INVALID_RESULT_OUTCOME;
}

function isAccessStyle(value: unknown): value is AccessStyle {
  return value === "import" || value === "require";
}

function readInspectionTarget(value: unknown): NormalizedInspectionTarget | undefined {
  if (
    !isRecord(value) ||
    typeof value["resolutionContext"] !== "string" ||
    typeof value["specifier"] !== "string"
  ) {
    return undefined;
  }

  const accessStyle = value["accessStyle"] ?? "import";
  return isAccessStyle(accessStyle)
    ? {
        resolutionContext: value["resolutionContext"],
        specifier: value["specifier"],
        accessStyle,
      }
    : undefined;
}

function isInspectionOutcome(value: unknown): value is InspectionOutcome {
  if (!isRecord(value)) {
    return false;
  }
  return value["status"] === "success"
    ? hasOnlyKeys(value, ["status", "result"]) &&
        (isInterfaceOverview(value["result"]) || isExportInspection(value["result"]))
    : hasOnlyKeys(value, ["status", "message"]) &&
        FAILURE_STATUSES.has(String(value["status"])) &&
        typeof value["message"] === "string";
}

function isExportInspection(value: unknown): value is ExportInspection {
  if (!isRecord(value)) {
    return false;
  }
  if (
    !hasOnlyKeys(value, [
      "intent",
      "specifier",
      "packageIdentity",
      "moduleExport",
      "supportingTypes",
      "packageDocumentation",
    ])
  ) {
    return false;
  }
  return [
    value["intent"] === "export-inspection",
    typeof value["specifier"] === "string",
    isPackageIdentity(value["packageIdentity"]),
    isInspectedModuleExport(value["moduleExport"]),
    isArrayOf(value["supportingTypes"], isSupportingType),
    isOptional(value["packageDocumentation"], isPackageDocumentation),
  ].every(Boolean);
}

function isInspectedModuleExport(value: unknown): value is InspectedModuleExport {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["name", "alias", "spaces", "signatures"]) &&
    typeof value["name"] === "string" &&
    (value["alias"] === undefined || isExportAlias(value["alias"])) &&
    isDensePlainArray(value["spaces"]) &&
    value["spaces"].every(isExportDeclarationSpace) &&
    isDensePlainArray(value["signatures"]) &&
    value["signatures"].every(isExportSignature)
  );
}

function isExportAlias(value: unknown): value is ExportAlias {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["targetName", "declaration"]) &&
    typeof value["targetName"] === "string" &&
    isInspectedDeclaration(value["declaration"]) &&
    value["declaration"].kind === "alias"
  );
}

function isExportDeclarationSpace(value: unknown): value is ExportDeclarationSpace {
  if (!isRecord(value) || !isDeclarationSpace(value["space"])) {
    return false;
  }
  return value["space"] === "namespace"
    ? hasOnlyKeys(value, ["space", "members"]) &&
        isDensePlainArray(value["members"]) &&
        value["members"].every((member) => isExportNamespaceMember(member, new Set(), 0))
    : hasOnlyKeys(value, ["space", "declarations"]) &&
        isDensePlainArray(value["declarations"]) &&
        value["declarations"].every(isInspectedDeclaration);
}

function isExportNamespaceMember(
  value: unknown,
  ancestors: Set<object>,
  depth: number,
): value is ExportNamespaceMember {
  if (
    depth > 8 ||
    !isRecord(value) ||
    ancestors.has(value) ||
    !hasOnlyKeys(value, ["name", "declarations", "members"]) ||
    typeof value["name"] !== "string" ||
    !isDensePlainArray(value["declarations"]) ||
    !value["declarations"].every(isInspectedDeclaration) ||
    !isDensePlainArray(value["members"])
  ) {
    return false;
  }
  ancestors.add(value);
  const valid = value["members"].every((member) =>
    isExportNamespaceMember(member, ancestors, depth + 1),
  );
  ancestors.delete(value);
  return valid;
}

function isDeclarationSpace(value: unknown): value is DeclarationSpace {
  return value === "type" || value === "value" || value === "namespace";
}

function isExportSignature(value: unknown): value is ExportSignature {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["kind", "text"]) &&
    (value["kind"] === "call" || value["kind"] === "construct") &&
    typeof value["text"] === "string"
  );
}

function isSupportingType(value: unknown): value is SupportingType {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["name", "declarations"]) &&
    typeof value["name"] === "string" &&
    isDensePlainArray(value["declarations"]) &&
    value["declarations"].every(isInspectedDeclaration)
  );
}

function isInspectedDeclaration(value: unknown): value is InspectedDeclaration {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["kind", "text", "provenance"]) &&
    isDeclarationKind(value["kind"]) &&
    typeof value["text"] === "string" &&
    isDeclarationProvenance(value["provenance"])
  );
}

function isDeclarationKind(value: unknown): value is DeclarationKind {
  return (
    value === "alias" ||
    value === "class" ||
    value === "enum" ||
    value === "function" ||
    value === "interface" ||
    value === "namespace" ||
    value === "type-alias" ||
    value === "variable"
  );
}

function isDeclarationProvenance(value: unknown): value is DeclarationProvenance {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["packageIdentity", "file", "line", "column"]) &&
    isPackageIdentity(value["packageIdentity"]) &&
    isPortableRelativePath(value["file"]) &&
    Number.isInteger(value["line"]) &&
    Number(value["line"]) > 0 &&
    Number.isInteger(value["column"]) &&
    Number(value["column"]) > 0
  );
}

function isPortableRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\")) {
    return false;
  }
  const segments = value.split("/");
  return (
    !value.startsWith("/") &&
    !/^[A-Za-z]:/u.test(value) &&
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function isPackageDocumentation(value: unknown): value is PackageDocumentation {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["provenance", "trust", "text"]) &&
    value["provenance"] === "installed-evidence" &&
    value["trust"] === "untrusted" &&
    typeof value["text"] === "string"
  );
}

function isInterfaceOverview(value: unknown): value is InterfaceOverview {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["intent", "specifier", "packageIdentity", "moduleExports"]) &&
    value["intent"] === "interface-overview" &&
    typeof value["specifier"] === "string" &&
    isPackageIdentity(value["packageIdentity"]) &&
    isDensePlainArray(value["moduleExports"]) &&
    value["moduleExports"].every(isModuleExportIndexEntry)
  );
}

function isPackageIdentity(value: unknown): value is PackageIdentity {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["name", "version"]) &&
    typeof value["name"] === "string" &&
    (value["version"] === undefined || typeof value["version"] === "string")
  );
}

function isModuleExportIndexEntry(value: unknown): value is ModuleExportIndexEntry {
  return isRecord(value) && hasOnlyKeys(value, ["name"]) && typeof value["name"] === "string";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDensePlainArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.length === value.length &&
    keys.every((key, index) => key === String(index)) &&
    value.every((_, index) => Object.hasOwn(value, index))
  );
}

function isArrayOf<Item>(
  value: unknown,
  isItem: (item: unknown) => item is Item,
): value is readonly Item[] {
  return isDensePlainArray(value) && value.every(isItem);
}

function isOptional<Value>(
  value: unknown,
  validate: (candidate: unknown) => candidate is Value,
): value is Value | undefined {
  return value === undefined || validate(value);
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}
