import { expectTypeOf, it } from "vite-plus/test";

import type {
  ExportDeclarationSpace,
  ExportInspection,
  ExportNamespaceMember,
  InterfaceOverview,
  ModuleExportIndexEntry,
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
