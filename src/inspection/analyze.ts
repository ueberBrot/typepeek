import { constVoid } from "effect/Function";

import { closeCompilerSessions } from "#typepeek/inspection/compiler-session";
import {
  InspectionLimitError,
  StaticBoundaryInspectionError,
  UnsupportedInspectionError,
} from "#typepeek/inspection/errors";
import type {
  InspectionCacheHitNotice,
  InspectionCacheIdentity,
  InspectionCacheWriteReceipt,
} from "#typepeek/inspection/inspection-cache";
import {
  createInspectionCacheHitNotice,
  createInspectionCacheIdentity,
  createInspectionCacheWriteReceipt,
  readInspectionCacheOutcome,
} from "#typepeek/inspection/inspection-cache";
import { executeInspectionQueries } from "#typepeek/inspection/inspection-query-execution";
import { selectInspectableModule } from "#typepeek/inspection/installed-evidence";
import type { InstalledEvidenceProof } from "#typepeek/inspection/installed-evidence-fingerprint";
import { createInstalledEvidenceFingerprintRecorder } from "#typepeek/inspection/installed-evidence-fingerprint";
import { profileInspectionPhase } from "#typepeek/inspection/performance-profile";
import type {
  AnalysisRequest,
  InspectionFailure,
  InspectionOutcome,
} from "#typepeek/inspection/protocol";

export interface AnalysisExecution {
  readonly cacheMessage?:
    | InspectionCacheHitNotice
    | InspectionCacheWriteReceipt;
  readonly outcome: InspectionOutcome;
}

const missingSpecifierOutcome = function missingSpecifierOutcome(
  specifier: string
): InspectionFailure {
  return {
    message: `Specifier "${specifier}" is not installed from this Resolution Context.`,
    reason: "specifier-not-found",
    status: "not-found",
  };
};

const readCachedAnalysis = function readCachedAnalysis(
  identity: InspectionCacheIdentity | undefined,
  proof: InstalledEvidenceProof | undefined,
  readCache: boolean
): AnalysisExecution | undefined {
  if (!readCache || identity === undefined || proof === undefined) {
    return undefined;
  }

  const cachedOutcome = readInspectionCacheOutcome(identity, proof);

  if (cachedOutcome === undefined) {
    return undefined;
  }

  const outcome = profileInspectionPhase(
    "inspection-cache-hit",
    () => cachedOutcome
  );

  const cacheMessage = createInspectionCacheHitNotice(identity);

  return cacheMessage === undefined ? { outcome } : { cacheMessage, outcome };
};

const prepareAnalyzedCacheWrite = function prepareAnalyzedCacheWrite(
  identity: InspectionCacheIdentity | undefined,
  proof: InstalledEvidenceProof | undefined,
  outcome: InspectionOutcome
): AnalysisExecution {
  const cacheMessage =
    outcome.status === "success" && identity !== undefined
      ? createInspectionCacheWriteReceipt(identity, proof)
      : undefined;

  return cacheMessage === undefined ? { outcome } : { cacheMessage, outcome };
};

const errorOutcome = function errorOutcome(cause: unknown): InspectionOutcome {
  if (cause instanceof InspectionLimitError) {
    return {
      exceededBudget: cause.exceededBudget,
      message: cause.message,
      reason: "budget-exceeded",
      status: "limit-exceeded",
    };
  }

  if (cause instanceof StaticBoundaryInspectionError) {
    return {
      message: cause.message,
      reason: "static-boundary",
      status: "static-boundary",
    };
  }

  // Unexpected errors may expose host paths or analyzer internals; return a generic failure.
  return cause instanceof UnsupportedInspectionError
    ? {
        message: cause.message,
        reason: "unsupported-evidence",
        status: "unsupported",
      }
    : {
        message: "Installed Evidence could not be inspected statically.",
        reason: "unsupported-evidence",
        status: "unsupported",
      };
};

/** Reuses a validated cache entry when its evidence matches; otherwise inspects the module. */
export const analyzeInspection = function analyzeInspection(
  analysisRequest: AnalysisRequest,
  readCache = true
): AnalysisExecution {
  const recorder = createInstalledEvidenceFingerprintRecorder();

  try {
    const selection = selectInspectableModule(
      analysisRequest.request,
      recorder
    );

    if (selection === undefined) {
      return {
        outcome: missingSpecifierOutcome(analysisRequest.request.specifier),
      };
    }

    const identity = createInspectionCacheIdentity(analysisRequest, selection);
    const cached = readCachedAnalysis(identity, recorder.snapshot(), readCache);

    if (cached !== undefined) {
      return cached;
    }

    profileInspectionPhase("inspection-cache-miss", constVoid);
    const outcome = executeInspectionQueries(analysisRequest, selection);

    return prepareAnalyzedCacheWrite(identity, recorder.snapshot(), outcome);
  } catch (error) {
    return { outcome: errorOutcome(error) };
  } finally {
    closeCompilerSessions();
  }
};
