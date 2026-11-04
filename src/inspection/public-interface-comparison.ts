import { InspectionLimitError } from "#typepeek/inspection/errors";
import type {
  InspectionFailure,
  InspectionOutcome,
  InterfaceOverview,
  PublicInterfaceComparison,
  PublicInterfaceComparisonTarget,
} from "#typepeek/inspection/protocol";
import { assertInspectionResultConstructionBound } from "#typepeek/inspection/result-construction";

const comparisonTarget = function comparisonTarget(
  overview: InterfaceOverview
): PublicInterfaceComparisonTarget {
  const target = {
    resolutionVariant: overview.resolutionVariant,
    specifier: overview.specifier,
  };

  if (overview.packageIdentity === undefined) {
    return { ...target, declarationProvider: overview.declarationProvider };
  }

  return {
    ...target,
    packageIdentity: overview.packageIdentity,
    ...(overview.declarationProvider !== undefined && {
      declarationProvider: overview.declarationProvider,
    }),
  };
};

const difference = function difference<Value>(
  values: readonly Value[],
  excludedValues: readonly Value[],
  key: (value: Value) => string
): readonly Value[] {
  const excluded = new Set(excludedValues.map(key));

  return values.filter((value) => !excluded.has(key(value)));
};

const comparisonConstructionFailure = function comparisonConstructionFailure(
  cause: unknown
): InspectionFailure {
  return cause instanceof InspectionLimitError
    ? {
        exceededBudget: cause.exceededBudget,
        message: cause.message,
        reason: "budget-exceeded",
        status: "limit-exceeded",
      }
    : {
        message:
          "Public Interface comparison could not construct a valid result.",
        reason: "invalid-result",
        status: "unsupported",
      };
};

/** Constructs one bounded directional delta while preserving both Resolution Variants. */
export const compareInterfaceOverviews = function compareInterfaceOverviews(
  before: InterfaceOverview,
  after: InterfaceOverview
): InspectionOutcome<PublicInterfaceComparison> {
  try {
    const result: PublicInterfaceComparison = {
      after: comparisonTarget(after),
      before: comparisonTarget(before),
      intent: "public-interface-comparison",
      moduleExports: {
        added: difference(
          after.moduleExports,
          before.moduleExports,
          ({ name }) => name
        ),
        removed: difference(
          before.moduleExports,
          after.moduleExports,
          ({ name }) => name
        ),
      },
      publicSubpaths: {
        added: difference(
          after.publicSubpaths,
          before.publicSubpaths,
          ({ specifier }) => specifier
        ),
        removed: difference(
          before.publicSubpaths,
          after.publicSubpaths,
          ({ specifier }) => specifier
        ),
      },
      scope: "interface-overview",
    };

    assertInspectionResultConstructionBound(result);

    return { result, status: "success" };
  } catch (error) {
    return comparisonConstructionFailure(error);
  }
};
