import {
  INSPECTION_CACHE_SEMANTICS,
  encodeInspectionCacheIdentityValue,
} from "#typepeek/inspection/cache/inspection-cache-codec";
import type { InspectionCacheIdentity } from "#typepeek/inspection/cache/inspection-cache-storage";
import {
  identityFromValue,
  readInspectionCacheCandidate,
} from "#typepeek/inspection/cache/inspection-cache-storage";
import { COMPILER_VERSION } from "#typepeek/inspection/compiler/compiler-metadata";
import type { InspectableModuleSelection } from "#typepeek/inspection/evidence/installed-evidence";
import type { InstalledEvidenceProof } from "#typepeek/inspection/evidence/installed-evidence-fingerprint";
import { installedEvidenceProofStillMatches } from "#typepeek/inspection/evidence/installed-evidence-proof";
import { INSPECTION_BUDGET_POLICY } from "#typepeek/inspection/model/budget-policy";
import type {
  AnalysisRequest,
  InspectionOutcome,
} from "#typepeek/inspection/model/protocol";
import { TYPEPEEK_VERSION } from "#typepeek/platform/package-metadata";

export {
  createInspectionCacheHitNotice,
  createInspectionCacheWriteReceipt,
  readInspectionCacheHitNotice,
  type InspectionCacheHitNotice,
  type InspectionCacheIdentity,
  type InspectionCacheWriteReceipt,
} from "#typepeek/inspection/cache/inspection-cache-storage";

export type InspectionCacheSelection = Pick<
  InspectableModuleSelection,
  | "declarationAuthority"
  | "kind"
  | "repositoryRoot"
  | "resolutionContextDirectory"
  | "resultIdentity"
>;

export const createInspectionCacheIdentity =
  function createInspectionCacheIdentity(
    request: AnalysisRequest,
    selection: InspectionCacheSelection
  ): InspectionCacheIdentity | undefined {
    const candidate = {
      budgetPolicy: INSPECTION_BUDGET_POLICY.identity,
      cacheSemantics: INSPECTION_CACHE_SEMANTICS,
      compilerVersion: COMPILER_VERSION,
      evidence: {
        declarationPath: selection.declarationAuthority.declarationPath,
        declarationRoot: selection.declarationAuthority.root.canonical,
        kind: selection.kind,
        repositoryRoot: selection.repositoryRoot,
        resolutionContextDirectory: selection.resolutionContextDirectory,
        resultIdentity: selection.resultIdentity,
      },
      request,
      typepeekVersion: TYPEPEEK_VERSION,
    };

    const value = encodeInspectionCacheIdentityValue(candidate);

    if (value === undefined) {
      return undefined;
    }

    return identityFromValue(value);
  };

/** Returns a cached outcome only when its full evidence proof still matches. */
export const readInspectionCacheOutcome =
  async function readInspectionCacheOutcome(
    identity: InspectionCacheIdentity,
    currentSelectionProof: InstalledEvidenceProof
  ): Promise<InspectionOutcome | undefined> {
    const entry = readInspectionCacheCandidate(identity);

    return entry !== undefined &&
      (await installedEvidenceProofStillMatches(
        entry.proof,
        currentSelectionProof
      ))
      ? entry.outcome
      : undefined;
  };
