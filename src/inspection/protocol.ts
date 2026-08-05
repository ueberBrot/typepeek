export type AccessStyle = "import" | "require";

export interface InterfaceOverviewRequest {
  readonly resolutionContext: string;
  readonly specifier: string;
  readonly accessStyle?: AccessStyle;
}

export interface ModuleExportIndexEntry {
  readonly name: string;
}

export interface PackageIdentity {
  readonly name: string;
  readonly version?: string;
}

export interface InterfaceOverview {
  readonly intent: "interface-overview";
  readonly specifier: string;
  readonly packageIdentity: PackageIdentity;
  readonly moduleExports: readonly ModuleExportIndexEntry[];
}

export type InspectionOutcome =
  | {
      readonly status: "success";
      readonly result: InterfaceOverview;
    }
  | {
      readonly status: "not-found" | "unsupported" | "limit-exceeded";
      readonly message: string;
    };
