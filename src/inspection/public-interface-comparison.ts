import { InspectionLimitError } from "#typepeek/inspection/errors";
import type {
  InspectionFailure,
  InspectionOutcome,
  InterfaceOverview,
  PublicInterfaceComparison,
  PublicInterfaceComparisonTarget,
} from "#typepeek/inspection/protocol";
import { assertInspectionResultConstructionBound } from "#typepeek/inspection/result-construction";

/** Constructs one bounded directional delta while preserving both Resolution Variants. */
export function compareInterfaceOverviews(
  before: InterfaceOverview,
  after: InterfaceOverview,
): InspectionOutcome<PublicInterfaceComparison> {
  try {
    const result: PublicInterfaceComparison = {
      intent: "public-interface-comparison",
      scope: "interface-overview",
      before: comparisonTarget(before),
      after: comparisonTarget(after),
      moduleExports: {
        added: difference(after.moduleExports, before.moduleExports, ({ name }) => name),
        removed: difference(before.moduleExports, after.moduleExports, ({ name }) => name),
      },
      publicSubpaths: {
        added: difference(
          after.publicSubpaths,
          before.publicSubpaths,
          ({ specifier }) => specifier,
        ),
        removed: difference(
          before.publicSubpaths,
          after.publicSubpaths,
          ({ specifier }) => specifier,
        ),
      },
    };
    assertInspectionResultConstructionBound(result);
    return { status: "success", result };
  } catch (error) {
    return comparisonConstructionFailure(error);
  }
}

function comparisonTarget(overview: InterfaceOverview): PublicInterfaceComparisonTarget {
  const target = {
    specifier: overview.specifier,
    resolutionVariant: overview.resolutionVariant,
  };
  if (overview.packageIdentity === undefined) {
    return { ...target, declarationProvider: overview.declarationProvider };
  }
  return {
    ...target,
    packageIdentity: overview.packageIdentity,
    ...(overview.declarationProvider === undefined
      ? {}
      : { declarationProvider: overview.declarationProvider }),
  };
}

function difference<Value>(
  values: readonly Value[],
  excludedValues: readonly Value[],
  key: (value: Value) => string,
): readonly Value[] {
  const excluded = new Set(excludedValues.map(key));
  return values.filter((value) => !excluded.has(key(value)));
}

function comparisonConstructionFailure(error: unknown): InspectionFailure {
  return error instanceof InspectionLimitError
    ? {
        status: "limit-exceeded",
        reason: "budget-exceeded",
        exceededBudget: error.exceededBudget,
        message: error.message,
      }
    : {
        status: "unsupported",
        reason: "invalid-result",
        message: "Public Interface comparison could not construct a valid result.",
      };
}
