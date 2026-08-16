import type {
  AccessStyle,
  AnalysisRequest,
  AnalysisRequestReading,
  InspectionFailure,
  InspectionRequestReading,
  InspectionResult,
  NormalizedExportInspectionRequest,
  NormalizedInterfaceOverviewRequest,
  NormalizedSignatureInspectionRequest,
} from "#typepeek/inspection/protocol";

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
  "signature-inspection": {
    status: "unsupported",
    message: "Inspection received an invalid Signature Inspection request.",
  },
} as const satisfies Readonly<Record<InspectionResult["intent"], InspectionFailure>>;

/** Snapshots and validates one untrusted caller request without loading the outcome codec. */
export function readInspectionRequest(
  intent: "interface-overview",
  value: unknown,
): InspectionRequestReading<NormalizedInterfaceOverviewRequest>;
export function readInspectionRequest(
  intent: "export-inspection",
  value: unknown,
): InspectionRequestReading<NormalizedExportInspectionRequest>;
export function readInspectionRequest(
  intent: "signature-inspection",
  value: unknown,
): InspectionRequestReading<NormalizedSignatureInspectionRequest>;
export function readInspectionRequest(
  intent: InspectionResult["intent"],
  value: unknown,
):
  | InspectionRequestReading<NormalizedInterfaceOverviewRequest>
  | InspectionRequestReading<NormalizedExportInspectionRequest>
  | InspectionRequestReading<NormalizedSignatureInspectionRequest> {
  try {
    const candidate = snapshotRecord(value);
    const target = candidate === undefined ? undefined : readInspectionTarget(candidate);
    if (target === undefined) {
      return { accepted: false, outcome: INVALID_REQUEST_OUTCOMES[intent] };
    }
    if (intent === "interface-overview") {
      return { accepted: true, request: target };
    }
    const exportName = candidate?.["exportName"];
    return typeof exportName === "string"
      ? { accepted: true, request: { ...target, exportName } }
      : { accepted: false, outcome: INVALID_REQUEST_OUTCOMES[intent] };
  } catch {
    return { accepted: false, outcome: INVALID_REQUEST_OUTCOMES[intent] };
  }
}

/** Revalidates the structured-cloned request at the isolated analysis-process seam. */
export function readAnalysisRequest(value: unknown): AnalysisRequestReading {
  try {
    const envelope = snapshotRecord(value);
    const intent = envelope?.["intent"];
    if (!isInspectionIntent(intent)) {
      return { accepted: false, outcome: INVALID_ANALYSIS_REQUEST_OUTCOME };
    }
    const reading = readRequestForIntent(intent, envelope?.["request"]);
    return reading === undefined
      ? { accepted: false, outcome: INVALID_ANALYSIS_REQUEST_OUTCOME }
      : { accepted: true, request: reading };
  } catch {
    return { accepted: false, outcome: INVALID_ANALYSIS_REQUEST_OUTCOME };
  }
}

function readRequestForIntent(
  intent: InspectionResult["intent"],
  value: unknown,
): AnalysisRequest | undefined {
  if (intent === "interface-overview") {
    const reading = readInspectionRequest(intent, value);
    return reading.accepted ? { intent, request: reading.request } : undefined;
  }
  if (intent === "export-inspection") {
    const reading = readInspectionRequest(intent, value);
    return reading.accepted ? { intent, request: reading.request } : undefined;
  }
  const reading = readInspectionRequest(intent, value);
  return reading.accepted ? { intent, request: reading.request } : undefined;
}

function readInspectionTarget(
  value: Readonly<Record<string, unknown>>,
): NormalizedInterfaceOverviewRequest | undefined {
  const resolutionContext = value["resolutionContext"];
  const specifier = value["specifier"];
  const accessStyle = value["accessStyle"];
  if (
    typeof resolutionContext !== "string" ||
    typeof specifier !== "string" ||
    !isAccessStyle(accessStyle)
  ) {
    return undefined;
  }
  return { resolutionContext, specifier, accessStyle: accessStyle ?? "import" };
}

function isAccessStyle(value: unknown): value is AccessStyle | undefined {
  return value === undefined || value === "import" || value === "require";
}

function isInspectionIntent(value: unknown): value is InspectionResult["intent"] {
  return (
    value === "interface-overview" ||
    value === "export-inspection" ||
    value === "signature-inspection"
  );
}

function snapshotRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      return undefined;
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
