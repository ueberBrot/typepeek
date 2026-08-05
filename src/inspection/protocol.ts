export type AccessStyle = "import" | "require";

export interface InterfaceOverviewRequest {
  readonly resolutionContext: string;
  readonly specifier: string;
  readonly accessStyle?: AccessStyle;
}

export interface NormalizedInterfaceOverviewRequest {
  readonly resolutionContext: string;
  readonly specifier: string;
  readonly accessStyle: AccessStyle;
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

export type InspectionOutcome =
  | {
      readonly status: "success";
      readonly result: InterfaceOverview;
    }
  | {
      readonly status: "not-found" | "unsupported" | "limit-exceeded";
      readonly message: string;
    };

export type InterfaceOverviewRequestReading =
  | {
      readonly accepted: true;
      readonly request: NormalizedInterfaceOverviewRequest;
    }
  | {
      readonly accepted: false;
      readonly outcome: InspectionOutcome;
    };

const FAILURE_STATUSES = new Set(["not-found", "unsupported", "limit-exceeded"]);
const INVALID_REQUEST_OUTCOME: InspectionOutcome = {
  status: "unsupported",
  message: "Inspection received an invalid Interface Overview request.",
};
const INVALID_RESULT_OUTCOME: InspectionOutcome = {
  status: "unsupported",
  message: "Inspection returned an invalid result.",
};

export function readInterfaceOverviewRequest(value: unknown): InterfaceOverviewRequestReading {
  if (
    !isRecord(value) ||
    typeof value["resolutionContext"] !== "string" ||
    typeof value["specifier"] !== "string"
  ) {
    return { accepted: false, outcome: INVALID_REQUEST_OUTCOME };
  }

  const accessStyle = value["accessStyle"] ?? "import";
  return isAccessStyle(accessStyle)
    ? {
        accepted: true,
        request: {
          resolutionContext: value["resolutionContext"],
          specifier: value["specifier"],
          accessStyle,
        },
      }
    : { accepted: false, outcome: INVALID_REQUEST_OUTCOME };
}

export function enforceInspectionOutcome(value: unknown): InspectionOutcome {
  return isInspectionOutcome(value) ? value : INVALID_RESULT_OUTCOME;
}

function isAccessStyle(value: unknown): value is AccessStyle {
  return value === "import" || value === "require";
}

function isInspectionOutcome(value: unknown): value is InspectionOutcome {
  if (!isRecord(value)) {
    return false;
  }
  return value["status"] === "success"
    ? isInterfaceOverview(value["result"])
    : FAILURE_STATUSES.has(String(value["status"])) && typeof value["message"] === "string";
}

function isInterfaceOverview(value: unknown): value is InterfaceOverview {
  return (
    isRecord(value) &&
    value["intent"] === "interface-overview" &&
    typeof value["specifier"] === "string" &&
    isPackageIdentity(value["packageIdentity"]) &&
    Array.isArray(value["moduleExports"]) &&
    value["moduleExports"].every(isModuleExportIndexEntry)
  );
}

function isPackageIdentity(value: unknown): value is PackageIdentity {
  return (
    isRecord(value) &&
    typeof value["name"] === "string" &&
    (value["version"] === undefined || typeof value["version"] === "string")
  );
}

function isModuleExportIndexEntry(value: unknown): value is ModuleExportIndexEntry {
  return isRecord(value) && typeof value["name"] === "string";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
