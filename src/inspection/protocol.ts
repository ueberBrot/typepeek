import { type } from "arktype";

const MAX_PROTOCOL_GRAPH_OBJECTS = 4_096;
const MAX_PROTOCOL_GRAPH_VALUES = 16_384;

const portableRelativePathSchema = type("string").narrow(isPortableRelativePath);
const positiveIntegerSchema = type("number.integer").narrow((value) => value > 0);
const nonArrayRecordSchema = type("object").narrow((value): boolean => isRecord(value));
const record = <const Definition extends object>(definition: Definition) =>
  [nonArrayRecordSchema, "&", definition] as const;

const inspectionSchemas = type.module({
  accessStyle: "'import' | 'require'",
  inspectionTarget: record({
    resolutionContext: "string",
    specifier: "string",
    "accessStyle?": "accessStyle | undefined",
  }),
  exportInspectionRequest: record({
    "...": "inspectionTarget",
    exportName: "string",
  }),
  signatureInspectionRequest: record({
    "...": "inspectionTarget",
    exportName: "string",
  }),
  normalizedInspectionTarget: record({
    resolutionContext: "string",
    specifier: "string",
    accessStyle: "accessStyle",
  }),
  normalizedExportInspectionRequest: record({
    "...": "normalizedInspectionTarget",
    exportName: "string",
  }),
  normalizedSignatureInspectionRequest: record({
    "...": "normalizedInspectionTarget",
    exportName: "string",
  }),
  interfaceOverviewAnalysisEnvelope: record({
    intent: "'interface-overview'",
    request: "unknown",
  }),
  exportInspectionAnalysisEnvelope: record({
    intent: "'export-inspection'",
    request: "unknown",
  }),
  signatureInspectionAnalysisEnvelope: record({
    intent: "'signature-inspection'",
    request: "unknown",
  }),
  analysisRequestEnvelope:
    "interfaceOverviewAnalysisEnvelope | exportInspectionAnalysisEnvelope | signatureInspectionAnalysisEnvelope",
  interfaceOverviewAnalysisRequest: record({
    intent: "'interface-overview'",
    request: "normalizedInspectionTarget",
  }),
  exportInspectionAnalysisRequest: record({
    intent: "'export-inspection'",
    request: "normalizedExportInspectionRequest",
  }),
  signatureInspectionAnalysisRequest: record({
    intent: "'signature-inspection'",
    request: "normalizedSignatureInspectionRequest",
  }),
  analysisRequest:
    "interfaceOverviewAnalysisRequest | exportInspectionAnalysisRequest | signatureInspectionAnalysisRequest",
  moduleExportIndexEntry: record({
    name: "string",
  }),
  publicSubpath: record({
    specifier: "string",
  }),
  packageIdentity: record({
    name: "string",
    "version?": "string | undefined",
  }),
  declarationSpace: "'type' | 'value' | 'namespace'",
  declarationKind:
    "'alias' | 'class' | 'enum' | 'function' | 'interface' | 'namespace' | 'type-alias' | 'variable'",
  declarationProvenance: record({
    packageIdentity: "packageIdentity",
    file: portableRelativePathSchema,
    line: positiveIntegerSchema,
    column: positiveIntegerSchema,
  }),
  inspectedDeclaration: record({
    kind: "declarationKind",
    text: "string",
    provenance: "declarationProvenance",
  }),
  aliasDeclaration: record({
    kind: "'alias'",
    text: "string",
    provenance: "declarationProvenance",
  }),
  exportTypeOrValueDeclarationSpace: record({
    space: "'type' | 'value'",
    declarations: "inspectedDeclaration[]",
  }),
  exportNamespaceMember: record({
    name: "string",
    declarations: "inspectedDeclaration[]",
    members: "exportNamespaceMember[]",
  }),
  exportNamespaceDeclarationSpace: record({
    space: "'namespace'",
    members: "exportNamespaceMember[]",
  }),
  exportDeclarationSpace: "exportTypeOrValueDeclarationSpace | exportNamespaceDeclarationSpace",
  exportAlias: record({
    targetName: "string",
    declaration: "aliasDeclaration",
  }),
  exportSignature: record({
    kind: "'call' | 'construct'",
    text: "string",
  }),
  signatureIdentifierBinding: record({
    kind: "'identifier'",
    name: "string",
    synthetic: "boolean",
  }),
  signaturePatternBinding: record({
    kind: "'pattern'",
    text: "string",
  }),
  signatureBinding: "signatureIdentifierBinding | signaturePatternBinding",
  signatureParameter: record({
    binding: "signatureBinding",
    type: "string",
    optional: "boolean",
    rest: "boolean",
  }),
  signatureThisParameter: record({
    type: "string",
  }),
  signatureTypeParameterModifier: "'const' | 'in' | 'out'",
  signatureTypeParameter: record({
    name: "string",
    modifiers: "signatureTypeParameterModifier[]",
    "constraint?": "string | undefined",
    "default?": "string | undefined",
    synthetic: "boolean",
  }),
  signatureTypeReturn: record({
    kind: "'type'",
    type: "string",
  }),
  signaturePredicateReturn: record({
    kind: "'predicate'",
    parameter: "string",
    type: "string",
  }),
  signatureAssertionReturn: record({
    kind: "'assertion'",
    parameter: "string",
    "type?": "string | undefined",
  }),
  signatureReturn: "signatureTypeReturn | signaturePredicateReturn | signatureAssertionReturn",
  inspectedSignature: record({
    kind: "'call' | 'construct'",
    text: "string",
    typeParameters: "signatureTypeParameter[]",
    "thisParameter?": "signatureThisParameter | undefined",
    parameters: "signatureParameter[]",
    returns: "signatureReturn",
  }),
  inspectedModuleExport: record({
    name: "string",
    "alias?": "exportAlias | undefined",
    spaces: "exportDeclarationSpace[]",
    signatures: "exportSignature[]",
  }),
  inspectedModuleExportSignatures: record({
    name: "string",
    "aliasTargetName?": "string | undefined",
    signatures: "inspectedSignature[]",
  }),
  supportingType: record({
    name: "string",
    declarations: "inspectedDeclaration[]",
  }),
  packageDocumentation: record({
    provenance: "'installed-evidence'",
    trust: "'untrusted'",
    text: "string",
  }),
  packageInterfaceOverview: record({
    intent: "'interface-overview'",
    specifier: "string",
    packageIdentity: "packageIdentity",
    "declarationProvider?": "packageIdentity | undefined",
    publicSubpaths: "publicSubpath[]",
    moduleExports: "moduleExportIndexEntry[]",
  }),
  platformInterfaceOverview: record({
    intent: "'interface-overview'",
    specifier: "string",
    "packageIdentity?": "undefined",
    declarationProvider: "packageIdentity",
    publicSubpaths: "publicSubpath[]",
    moduleExports: "moduleExportIndexEntry[]",
  }),
  interfaceOverview: "packageInterfaceOverview | platformInterfaceOverview",
  packageExportInspection: record({
    intent: "'export-inspection'",
    specifier: "string",
    packageIdentity: "packageIdentity",
    "declarationProvider?": "packageIdentity | undefined",
    moduleExport: "inspectedModuleExport",
    supportingTypes: "supportingType[]",
    "packageDocumentation?": "packageDocumentation | undefined",
  }),
  platformExportInspection: record({
    intent: "'export-inspection'",
    specifier: "string",
    "packageIdentity?": "undefined",
    declarationProvider: "packageIdentity",
    moduleExport: "inspectedModuleExport",
    supportingTypes: "supportingType[]",
    "packageDocumentation?": "packageDocumentation | undefined",
  }),
  exportInspection: "packageExportInspection | platformExportInspection",
  packageSignatureInspection: record({
    intent: "'signature-inspection'",
    specifier: "string",
    packageIdentity: "packageIdentity",
    "declarationProvider?": "packageIdentity | undefined",
    moduleExport: "inspectedModuleExportSignatures",
  }),
  platformSignatureInspection: record({
    intent: "'signature-inspection'",
    specifier: "string",
    "packageIdentity?": "undefined",
    declarationProvider: "packageIdentity",
    moduleExport: "inspectedModuleExportSignatures",
  }),
  signatureInspection: "packageSignatureInspection | platformSignatureInspection",
  inspectionResult: "interfaceOverview | exportInspection | signatureInspection",
  inspectionFailure: record({
    status: "'not-found' | 'unsupported' | 'static-boundary' | 'limit-exceeded'",
    message: "string",
  }),
  inspectionSuccess: record({
    status: "'success'",
    result: "inspectionResult",
  }),
  inspectionOutcome: "inspectionSuccess | inspectionFailure",
});

const inspectionOutcomeSchema = inspectionSchemas.inspectionOutcome.onDeepUndeclaredKey("reject");
const interfaceOverviewRequestSchema = inspectionSchemas.inspectionTarget;
const exportInspectionRequestSchema = inspectionSchemas.exportInspectionRequest;
const signatureInspectionRequestSchema = inspectionSchemas.signatureInspectionRequest;
const analysisRequestEnvelopeSchema = inspectionSchemas.analysisRequestEnvelope;

/**
 * Projects ArkType-inferred protocol values into readonly TypeScript shapes.
 * Optional properties stay optional rather than becoming required properties
 * whose values include `undefined`.
 */
export type ProtocolType<Value> = Value extends readonly (infer Item)[]
  ? readonly ProtocolType<Item>[]
  : Value extends object
    ? {
        readonly [Key in keyof Value as {} extends Pick<Value, Key> ? never : Key]: ProtocolType<
          Value[Key]
        >;
      } & {
        readonly [Key in keyof Value as {} extends Pick<Value, Key> ? Key : never]?: ProtocolType<
          Exclude<Value[Key], undefined>
        >;
      }
    : Value;

export type AccessStyle = ProtocolType<typeof inspectionSchemas.accessStyle.infer>;
export type InterfaceOverviewRequest = ProtocolType<
  typeof inspectionSchemas.inspectionTarget.infer
>;
export type NormalizedInspectionTarget = ProtocolType<
  typeof inspectionSchemas.normalizedInspectionTarget.infer
>;
export type NormalizedInterfaceOverviewRequest = NormalizedInspectionTarget;
export type ExportInspectionRequest = ProtocolType<
  typeof inspectionSchemas.exportInspectionRequest.infer
>;
export type NormalizedExportInspectionRequest = ProtocolType<
  typeof inspectionSchemas.normalizedExportInspectionRequest.infer
>;
export type SignatureInspectionRequest = ProtocolType<
  typeof inspectionSchemas.signatureInspectionRequest.infer
>;
export type NormalizedSignatureInspectionRequest = ProtocolType<
  typeof inspectionSchemas.normalizedSignatureInspectionRequest.infer
>;
export type ModuleExportIndexEntry = ProtocolType<
  typeof inspectionSchemas.moduleExportIndexEntry.infer
>;
export type PublicSubpath = ProtocolType<typeof inspectionSchemas.publicSubpath.infer>;
export type PackageIdentity = ProtocolType<typeof inspectionSchemas.packageIdentity.infer>;
export type InspectionResultIdentity =
  | {
      readonly packageIdentity: PackageIdentity;
      readonly declarationProvider?: PackageIdentity;
    }
  | {
      readonly packageIdentity?: never;
      readonly declarationProvider: PackageIdentity;
    };
export type InterfaceOverview = ProtocolType<typeof inspectionSchemas.interfaceOverview.infer>;
export type DeclarationSpace = ProtocolType<typeof inspectionSchemas.declarationSpace.infer>;
export type DeclarationKind = ProtocolType<typeof inspectionSchemas.declarationKind.infer>;
export type InspectedDeclaration = ProtocolType<
  typeof inspectionSchemas.inspectedDeclaration.infer
>;
export type ExportNamespaceMember = ProtocolType<
  typeof inspectionSchemas.exportNamespaceMember.infer
>;
export type ExportDeclarationSpace = ProtocolType<
  typeof inspectionSchemas.exportDeclarationSpace.infer
>;
export type ExportAlias = ProtocolType<typeof inspectionSchemas.exportAlias.infer>;
export type ExportSignature = ProtocolType<typeof inspectionSchemas.exportSignature.infer>;
export type SignatureBinding = ProtocolType<typeof inspectionSchemas.signatureBinding.infer>;
export type SignatureParameter = ProtocolType<typeof inspectionSchemas.signatureParameter.infer>;
export type SignatureThisParameter = ProtocolType<
  typeof inspectionSchemas.signatureThisParameter.infer
>;
export type SignatureTypeParameterModifier = ProtocolType<
  typeof inspectionSchemas.signatureTypeParameterModifier.infer
>;
export type SignatureTypeParameter = ProtocolType<
  typeof inspectionSchemas.signatureTypeParameter.infer
>;
export type SignatureReturn = ProtocolType<typeof inspectionSchemas.signatureReturn.infer>;
export type InspectedSignature = ProtocolType<typeof inspectionSchemas.inspectedSignature.infer>;
export type InspectedModuleExport = ProtocolType<
  typeof inspectionSchemas.inspectedModuleExport.infer
>;
export type SupportingType = ProtocolType<typeof inspectionSchemas.supportingType.infer>;
export type PackageDocumentation = ProtocolType<
  typeof inspectionSchemas.packageDocumentation.infer
>;
export type ExportInspection = ProtocolType<typeof inspectionSchemas.exportInspection.infer>;
export type InspectedModuleExportSignatures = ProtocolType<
  typeof inspectionSchemas.inspectedModuleExportSignatures.infer
>;
export type SignatureInspection = ProtocolType<typeof inspectionSchemas.signatureInspection.infer>;
export type InspectionResult = ProtocolType<typeof inspectionSchemas.inspectionResult.infer>;
export type InspectionFailure = ProtocolType<typeof inspectionSchemas.inspectionFailure.infer>;

/** A complete Inspection Result or an explicit non-authoritative failure. */
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

export type AnalysisRequest = ProtocolType<typeof inspectionSchemas.analysisRequest.infer>;

export type AnalysisRequestReading =
  | {
      readonly accepted: true;
      readonly request: AnalysisRequest;
    }
  | {
      readonly accepted: false;
      readonly outcome: InspectionFailure;
    };

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
const INVALID_RESULT_OUTCOME: InspectionFailure = {
  status: "unsupported",
  message: "Inspection returned an invalid result.",
};

/**
 * Snapshots and validates an untrusted caller request, applying `import` as the
 * default Access Style. Invalid or accessor-backed inputs return a typed failure
 * and never escape this function as exceptions.
 */
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
    if (candidate === undefined) {
      return { accepted: false, outcome: INVALID_REQUEST_OUTCOMES[intent] };
    }
    if (intent === "interface-overview") {
      const request = interfaceOverviewRequestSchema(candidate);
      return request instanceof type.errors
        ? { accepted: false, outcome: INVALID_REQUEST_OUTCOMES[intent] }
        : { accepted: true, request: normalizeInspectionTarget(request) };
    }
    const request =
      intent === "export-inspection"
        ? exportInspectionRequestSchema(candidate)
        : signatureInspectionRequestSchema(candidate);
    return request instanceof type.errors
      ? { accepted: false, outcome: INVALID_REQUEST_OUTCOMES[intent] }
      : {
          accepted: true,
          request: {
            ...normalizeInspectionTarget(request),
            exportName: request.exportName,
          },
        };
  } catch {
    return { accepted: false, outcome: INVALID_REQUEST_OUTCOMES[intent] };
  }
}

/**
 * Revalidates the request envelope received by the analysis process entry and delegates
 * nested request validation to the same seam used by direct callers.
 */
export function readAnalysisRequest(value: unknown): AnalysisRequestReading {
  try {
    const candidate = snapshotRecord(value);
    if (candidate === undefined) {
      return { accepted: false, outcome: INVALID_ANALYSIS_REQUEST_OUTCOME };
    }
    const envelope = analysisRequestEnvelopeSchema(candidate);
    if (envelope instanceof type.errors) {
      return { accepted: false, outcome: INVALID_ANALYSIS_REQUEST_OUTCOME };
    }

    if (envelope.intent === "interface-overview") {
      const reading = readInspectionRequest(envelope.intent, envelope.request);
      return reading.accepted
        ? {
            accepted: true,
            request: { intent: envelope.intent, request: reading.request },
          }
        : { accepted: false, outcome: INVALID_ANALYSIS_REQUEST_OUTCOME };
    }
    if (envelope.intent === "export-inspection") {
      const reading = readInspectionRequest(envelope.intent, envelope.request);
      return reading.accepted
        ? {
            accepted: true,
            request: { intent: envelope.intent, request: reading.request },
          }
        : { accepted: false, outcome: INVALID_ANALYSIS_REQUEST_OUTCOME };
    }
    const reading = readInspectionRequest("signature-inspection", envelope.request);
    return reading.accepted
      ? {
          accepted: true,
          request: { intent: "signature-inspection", request: reading.request },
        }
      : { accepted: false, outcome: INVALID_ANALYSIS_REQUEST_OUTCOME };
  } catch {
    return { accepted: false, outcome: INVALID_ANALYSIS_REQUEST_OUTCOME };
  }
}

/**
 * Accepts only a bounded, dense, data-property-only outcome for the requested
 * intent. Invalid process messages collapse to a generic failure rather than
 * exposing analyzer or transport details.
 */
export function enforceInspectionOutcome(
  intent: "interface-overview",
  value: unknown,
): InspectionOutcome<InterfaceOverview>;
export function enforceInspectionOutcome(
  intent: "export-inspection",
  value: unknown,
): InspectionOutcome<ExportInspection>;
export function enforceInspectionOutcome(
  intent: "signature-inspection",
  value: unknown,
): InspectionOutcome<SignatureInspection>;
export function enforceInspectionOutcome(
  intent: InspectionResult["intent"],
  value: unknown,
): InspectionOutcome;
export function enforceInspectionOutcome(
  intent: InspectionResult["intent"],
  value: unknown,
): InspectionOutcome {
  try {
    if (!isInspectionOutcome(value)) {
      return INVALID_RESULT_OUTCOME;
    }
    return value.status !== "success" || value.result.intent === intent
      ? value
      : INVALID_RESULT_OUTCOME;
  } catch {
    return INVALID_RESULT_OUTCOME;
  }
}

function normalizeInspectionTarget(
  request: typeof inspectionSchemas.inspectionTarget.infer,
): NormalizedInspectionTarget {
  return {
    resolutionContext: request.resolutionContext,
    specifier: request.specifier,
    accessStyle: request.accessStyle ?? "import",
  };
}

function isInspectionOutcome(value: unknown): value is InspectionOutcome {
  // Manual graph guards run before ArkType so cyclic, sparse, accessor-backed,
  // or excessively deep values cannot make recursive schema validation unsafe.
  return (
    hasDenseProtocolArrays(value) &&
    hasBoundedNamespaceGraph(value) &&
    inspectionOutcomeSchema.allows(value)
  );
}

function hasDenseProtocolArrays(value: unknown): boolean {
  const pending = [value];
  const visited = new Set<object>();

  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const candidate = pending[cursor];
    if (typeof candidate !== "object" || candidate === null || visited.has(candidate)) {
      continue;
    }
    visited.add(candidate);
    if (visited.size > MAX_PROTOCOL_GRAPH_OBJECTS) {
      return false;
    }

    if (!queueProtocolChildren(candidate, pending) || pending.length > MAX_PROTOCOL_GRAPH_VALUES) {
      return false;
    }
  }
  return true;
}

function queueProtocolChildren(candidate: object, pending: unknown[]): boolean {
  const keys = Object.keys(candidate);
  if (Array.isArray(candidate)) {
    return queueDenseArrayItems(candidate, keys, pending);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      return false;
    }
    pending.push(descriptor.value);
  }
  return true;
}

function queueDenseArrayItems(
  values: readonly unknown[],
  keys: readonly string[],
  pending: unknown[],
): boolean {
  if (keys.length !== values.length) {
    return false;
  }
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined || key !== String(index)) {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(values, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      return false;
    }
    pending.push(descriptor.value);
  }
  return true;
}

function hasBoundedNamespaceGraph(value: unknown): boolean {
  // Namespace members are the protocol's recursive shape. Keep this transport
  // guard aligned with the analyzer depth budget and reject object cycles.
  if (!isRecord(value) || value["status"] !== "success") {
    return true;
  }
  const result = value["result"];
  if (!isRecord(result) || result["intent"] !== "export-inspection") {
    return true;
  }
  const moduleExport = result["moduleExport"];
  if (!isRecord(moduleExport) || !Array.isArray(moduleExport["spaces"])) {
    return true;
  }

  return everyArrayItem(moduleExport["spaces"], (space) => {
    if (!isRecord(space) || space["space"] !== "namespace" || !Array.isArray(space["members"])) {
      return true;
    }
    return everyArrayItem(space["members"], (member) =>
      hasBoundedNamespaceMember(member, new Set(), 0),
    );
  });
}

function hasBoundedNamespaceMember(value: unknown, ancestors: Set<object>, depth: number): boolean {
  if (depth > 8 || (isRecord(value) && ancestors.has(value))) {
    return false;
  }
  if (!isRecord(value) || !Array.isArray(value["members"])) {
    return true;
  }

  ancestors.add(value);
  const valid = everyArrayItem(value["members"], (member) =>
    hasBoundedNamespaceMember(member, ancestors, depth + 1),
  );
  ancestors.delete(value);
  return valid;
}

function everyArrayItem(
  values: readonly unknown[],
  predicate: (value: unknown) => boolean,
): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (!predicate(values[index])) {
      return false;
    }
  }
  return true;
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snapshotRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  // Copy own data properties once so validation never invokes getters and the
  // accepted values cannot change between schema checks and normalization.
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
