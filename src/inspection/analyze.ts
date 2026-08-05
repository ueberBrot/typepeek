import { inspectModuleExports } from "#typepeek/inspection/compiler";
import { InspectionLimitError, UnsupportedInspectionError } from "#typepeek/inspection/errors";
import {
  assertAbsoluteResolutionContext,
  findPackageRoot,
  parsePackageRootSpecifier,
  readManifest,
  resolveDeclarationPath,
} from "#typepeek/inspection/package-evidence";
import type {
  InspectionOutcome,
  InterfaceOverviewRequest,
  PackageIdentity,
} from "#typepeek/inspection/protocol";

export function analyzeInterfaceOverview(request: InterfaceOverviewRequest): InspectionOutcome {
  try {
    return inspectInstalledPackage(request);
  } catch (error) {
    return errorOutcome(error);
  }
}

function inspectInstalledPackage(request: InterfaceOverviewRequest): InspectionOutcome {
  assertAbsoluteResolutionContext(request.resolutionContext);
  const packageSegments = parsePackageRootSpecifier(request.specifier);
  if (packageSegments === undefined) {
    throw new UnsupportedInspectionError(
      "The initial Interface Overview supports package-root Specifiers only.",
    );
  }

  const packageRoot = findPackageRoot(request.resolutionContext, packageSegments);
  if (packageRoot === undefined) {
    return {
      status: "not-found",
      message: `Specifier "${request.specifier}" is not installed from this Resolution Context.`,
    };
  }

  const manifest = readManifest(packageRoot);
  const declarationPath = resolveDeclarationPath(packageRoot, manifest);
  return {
    status: "success",
    result: {
      intent: "interface-overview",
      specifier: request.specifier,
      packageIdentity: packageIdentity(manifest.name, manifest.version),
      moduleExports: inspectModuleExports(declarationPath, packageRoot),
    },
  };
}

function packageIdentity(name: string, version: unknown): PackageIdentity {
  return typeof version === "string" ? { name, version } : { name };
}

function errorOutcome(error: unknown): InspectionOutcome {
  if (error instanceof InspectionLimitError) {
    return { status: "limit-exceeded", message: error.message };
  }
  return error instanceof UnsupportedInspectionError
    ? { status: "unsupported", message: error.message }
    : {
        status: "unsupported",
        message: "Installed Evidence could not be inspected statically.",
      };
}
