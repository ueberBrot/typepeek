import { expectTypeOf, it } from "vite-plus/test";

import type {
  AnalysisRequest,
  ExportDeclarationSpace,
  ExportInspection,
  ExportNamespaceMember,
  InspectionPlanQuery,
  InspectionRequestByIntent,
  InterfaceOverview,
  InterfaceOverviewRequest,
  MemberInspectionRequest,
  ModuleExportIndexEntry,
  NormalizedInspectionTarget,
  PackageIdentity,
  PublicSubpath,
} from "#typepeek/inspection/protocol";

it("derives the existing deeply readonly protocol types", () => {
  const assertReadonly = (
    packageIdentity: PackageIdentity,
    overview: InterfaceOverview,
    inspection: ExportInspection,
  ): void => {
    // @ts-expect-error Protocol fields remain readonly.
    packageIdentity.name = "changed";
    // @ts-expect-error Protocol arrays remain readonly.
    overview.moduleExports.push({ name: "changed" });
    // @ts-expect-error Public Subpaths remain readonly.
    overview.publicSubpaths.push({ specifier: "changed" });
    // @ts-expect-error Nested Protocol arrays remain readonly.
    inspection.moduleExport.spaces.push({ space: "namespace", members: [] });
  };

  type AcceptsExplicitUndefined = {
    readonly name: string;
    readonly version: undefined;
  } extends PackageIdentity
    ? true
    : false;
  type PackageIdentityHasStringIndex = string extends keyof PackageIdentity ? true : false;

  expectTypeOf(assertReadonly).toBeFunction();
  expectTypeOf<AcceptsExplicitUndefined>().toEqualTypeOf<false>();
  expectTypeOf<PackageIdentityHasStringIndex>().toEqualTypeOf<false>();
  expectTypeOf<InterfaceOverview["moduleExports"]>().toEqualTypeOf<
    readonly ModuleExportIndexEntry[]
  >();
  expectTypeOf<InterfaceOverview["publicSubpaths"]>().toEqualTypeOf<readonly PublicSubpath[]>();
  expectTypeOf<ExportInspection["moduleExport"]["spaces"]>().toEqualTypeOf<
    readonly ExportDeclarationSpace[]
  >();
  expectTypeOf<ExportNamespaceMember["members"][number]>().toEqualTypeOf<ExportNamespaceMember>();
});

it("derives request and analysis types from their normalized schemas", () => {
  type RequestAcceptsExplicitUndefined = {
    readonly resolutionContext: string;
    readonly specifier: string;
    readonly accessStyle: undefined;
  } extends InterfaceOverviewRequest
    ? true
    : false;
  type OverviewAnalysisRequest = Extract<
    AnalysisRequest,
    { readonly intent: "interface-overview" }
  >;
  type MemberPlanQuery = Extract<InspectionPlanQuery, { readonly intent: "member-inspection" }>;

  expectTypeOf<InterfaceOverviewRequest>().toEqualTypeOf<{
    readonly resolutionContext: string;
    readonly specifier: string;
    readonly accessStyle?: "import" | "require" | undefined;
  }>();
  expectTypeOf<NormalizedInspectionTarget>().toEqualTypeOf<{
    readonly resolutionContext: string;
    readonly specifier: string;
    readonly accessStyle: "import" | "require";
  }>();
  expectTypeOf<RequestAcceptsExplicitUndefined>().toEqualTypeOf<true>();
  expectTypeOf<OverviewAnalysisRequest["request"]>().toEqualTypeOf<NormalizedInspectionTarget>();
  expectTypeOf<MemberPlanQuery["memberPath"]>().toEqualTypeOf<readonly string[]>();
  expectTypeOf<
    InspectionRequestByIntent["member-inspection"]
  >().toEqualTypeOf<MemberInspectionRequest>();
});
