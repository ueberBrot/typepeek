import type { Scope } from "effect";
import { Cause, Effect } from "effect";
import { constVoid } from "effect/Function";

import type {
  InspectionCacheHitNotice,
  InspectionCacheIdentity,
  InspectionCacheWriteReceipt,
} from "#typepeek/inspection/cache/inspection-cache";
import {
  createInspectionCacheHitNotice,
  createInspectionCacheIdentity,
  createInspectionCacheWriteReceipt,
  readInspectionCacheOutcome,
} from "#typepeek/inspection/cache/inspection-cache";
import {
  CompilerTaskError,
  compilerTask,
} from "#typepeek/inspection/compiler/compiler-effect";
import { createCompilerSessionOwner } from "#typepeek/inspection/compiler/compiler-session-owner";
import { selectInspectableModule } from "#typepeek/inspection/evidence/installed-evidence";
import type { InstalledEvidenceProof } from "#typepeek/inspection/evidence/installed-evidence-fingerprint";
import { createInstalledEvidenceFingerprintRecorder } from "#typepeek/inspection/evidence/installed-evidence-fingerprint";
import { profileInspectionPhase } from "#typepeek/inspection/execution/performance-profile";
import {
  InspectionLimitError,
  StaticBoundaryInspectionError,
  UnsupportedInspectionError,
} from "#typepeek/inspection/model/errors";
import type {
  AnalysisRequest,
  InspectionFailure,
  InspectionOutcome,
} from "#typepeek/inspection/model/protocol";
import { executeInspectionQueries } from "#typepeek/inspection/queries/inspection-query-execution";

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

const readCachedAnalysis = async function readCachedAnalysis(
  identity: InspectionCacheIdentity | undefined,
  proof: InstalledEvidenceProof | undefined,
  readCache: boolean
): Promise<AnalysisExecution | undefined> {
  if (!readCache || identity === undefined || proof === undefined) {
    return undefined;
  }

  const cachedOutcome = await readInspectionCacheOutcome(identity, proof);

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
export const analyzeInspectionEffect = Effect.fnUntraced(
  function* analyzeInspectionEffect(
    analysisRequest: AnalysisRequest,
    readCache: boolean
  ): Effect.fn.Return<AnalysisExecution, CompilerTaskError, Scope.Scope> {
    const owner = yield* Effect.acquireRelease(
      Effect.sync(createCompilerSessionOwner),
      (sessions) => sessions.closeEffect
    );

    const recorder = createInstalledEvidenceFingerprintRecorder();

    const selection = yield* compilerTask(
      async () =>
        await selectInspectableModule(analysisRequest.request, recorder, owner)
    );

    if (selection === undefined) {
      return {
        outcome: missingSpecifierOutcome(analysisRequest.request.specifier),
      };
    }

    const identity = createInspectionCacheIdentity(analysisRequest, selection);

    const cached = yield* compilerTask(
      async () =>
        await readCachedAnalysis(identity, recorder.snapshot(), readCache)
    );

    if (cached !== undefined) {
      return cached;
    }

    profileInspectionPhase("inspection-cache-miss", constVoid);

    const outcome = yield* compilerTask(
      async () => await executeInspectionQueries(analysisRequest, selection)
    );

    return prepareAnalyzedCacheWrite(identity, recorder.snapshot(), outcome);
  },
  (execution) =>
    execution.pipe(
      Effect.scoped,
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => {
          const error = Cause.squash(cause);

          return Effect.succeed<AnalysisExecution>({
            outcome: errorOutcome(
              error instanceof CompilerTaskError ? error.cause : error
            ),
          });
        }
      )
    )
);

export const analyzeInspection = async (
  analysisRequest: AnalysisRequest,
  readCache = true
): Promise<AnalysisExecution> =>
  await Effect.runPromise(analyzeInspectionEffect(analysisRequest, readCache));
