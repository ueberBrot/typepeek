import { InspectionLimitError, UnsupportedInspectionError } from "#typepeek/inspection/errors";
import { inspectFocusedModuleExport } from "#typepeek/inspection/export-inspection";
import {
  type InstalledPackageModule,
  readInstalledPackageModule,
} from "#typepeek/inspection/installed-evidence";
import type { AnalysisRequest, InspectionOutcome } from "#typepeek/inspection/protocol";

const MAX_MODULE_EXPORTS = 200;

/**
 * Runs one already-normalized analysis request inside the worker. Expected
 * inspection limits and unsupported cases retain their category; unexpected
 * analyzer failures are deliberately collapsed to a generic unsupported result.
 */
export function analyzeInspection(analysisRequest: AnalysisRequest): InspectionOutcome {
  try {
    return inspectInstalledPackage(analysisRequest);
  } catch (error) {
    return errorOutcome(error);
  }
}

function inspectInstalledPackage(analysisRequest: AnalysisRequest): InspectionOutcome {
  const { request } = analysisRequest;
  const evidence = readInstalledPackageModule(request);
  if (evidence === undefined) {
    return {
      status: "not-found",
      message: `Specifier "${request.specifier}" is not installed from this Resolution Context.`,
    };
  }

  if (analysisRequest.intent === "export-inspection") {
    const result = inspectFocusedModuleExport(
      evidence,
      analysisRequest.request.exportName,
      request.specifier,
    );
    return result === undefined
      ? {
          status: "not-found",
          message: `Module Export "${analysisRequest.request.exportName}" was not found in "${request.specifier}".`,
        }
      : { status: "success", result };
  }

  return {
    status: "success",
    result: {
      intent: "interface-overview",
      specifier: request.specifier,
      packageIdentity: evidence.packageIdentity,
      publicSubpaths: evidence.publicSubpaths,
      moduleExports: inspectModuleExports(evidence),
    },
  };
}

function inspectModuleExports({
  checker,
  moduleSymbol,
}: InstalledPackageModule): readonly { readonly name: string }[] {
  const moduleExports = checker
    .getExportsOfModule(moduleSymbol)
    .map((symbol) => ({ name: symbol.getName() }))
    .sort(compareModuleExports);

  if (moduleExports.length > MAX_MODULE_EXPORTS) {
    throw new InspectionLimitError("Inspection exceeded its Module Export limit.");
  }
  return moduleExports;
}

function compareModuleExports(
  left: { readonly name: string },
  right: { readonly name: string },
): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function errorOutcome(error: unknown): InspectionOutcome {
  if (error instanceof InspectionLimitError) {
    return { status: "limit-exceeded", message: error.message };
  }
  // Unexpected errors may contain host paths or analyzer details, neither of
  // which belongs in the transport-neutral Inspection Result.
  return error instanceof UnsupportedInspectionError
    ? { status: "unsupported", message: error.message }
    : {
        status: "unsupported",
        message: "Installed Evidence could not be inspected statically.",
      };
}
