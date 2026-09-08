import ts from "@typescript/typescript6";

import { INSPECTION_BUDGET_POLICY } from "#typepeek/inspection/budget-policy";
import {
  INSPECTION_CACHE_SEMANTICS,
  encodeInspectionCacheIdentityValue,
} from "#typepeek/inspection/inspection-cache-codec";
import {
  identityFromValue,
  readInspectionCacheCandidate,
  type InspectionCacheIdentity,
} from "#typepeek/inspection/inspection-cache-storage";
import type { InspectableModuleSelection } from "#typepeek/inspection/installed-evidence";
import type { InstalledEvidenceProof } from "#typepeek/inspection/installed-evidence-fingerprint";
import { installedEvidenceProofStillMatches } from "#typepeek/inspection/installed-evidence-proof";
import type { AnalysisRequest, InspectionOutcome } from "#typepeek/inspection/protocol";
import { TYPEPEEK_VERSION } from "#typepeek/package-metadata";

export {
  createInspectionCacheHitNotice,
  createInspectionCacheWriteReceipt,
  readInspectionCacheHitNotice,
  type InspectionCacheIdentity,
  type InspectionCacheHitNotice,
  type InspectionCacheWriteReceipt,
} from "#typepeek/inspection/inspection-cache-storage";

/** Creates the complete non-content portion of one cache key after bounded resolution. */
export function createInspectionCacheIdentity(
  request: AnalysisRequest,
  selection: InspectableModuleSelection,
): InspectionCacheIdentity | undefined {
  const candidate = {
    budgetPolicy: INSPECTION_BUDGET_POLICY.identity,
    cacheSemantics: INSPECTION_CACHE_SEMANTICS,
    compilerVersion: ts.version,
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
}

/** Reads an untrusted candidate only after its complete evidence proof still matches. */
export function readInspectionCacheOutcome(
  identity: InspectionCacheIdentity,
  currentSelectionProof: InstalledEvidenceProof,
): InspectionOutcome | undefined {
  const entry = readInspectionCacheCandidate(identity);
  return entry !== undefined &&
    installedEvidenceProofStillMatches(entry.proof, currentSelectionProof)
    ? entry.outcome
    : undefined;
}
