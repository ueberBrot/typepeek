import { expect, it } from "vite-plus/test";

import {
  enforceInspectionOutcome,
  readAnalysisRequest,
  readInspectionRequest,
} from "#typepeek/inspection/protocol";

it("normalizes the default Access Style at the worker protocol seam", () => {
  expect(
    readInspectionRequest("interface-overview", {
      resolutionContext: "/repository",
      specifier: "example",
    }),
  ).toEqual({
    accepted: true,
    request: {
      resolutionContext: "/repository",
      specifier: "example",
      accessStyle: "import",
    },
  });
});

it("rejects an invalid Access Style at the worker protocol seam", () => {
  expect(
    readInspectionRequest("interface-overview", {
      resolutionContext: "/repository",
      specifier: "example",
      accessStyle: "script",
    }),
  ).toEqual({
    accepted: false,
    outcome: {
      status: "unsupported",
      message: "Inspection received an invalid Interface Overview request.",
    },
  });
});

it("rejects a structurally incomplete successful Inspection Outcome", () => {
  expect(
    enforceInspectionOutcome("interface-overview", {
      status: "success",
      result: {},
    }),
  ).toEqual({
    status: "unsupported",
    message: "Inspection returned an invalid result.",
  });
});

it("normalizes an Export Inspection request at the worker protocol seam", () => {
  expect(
    readInspectionRequest("export-inspection", {
      resolutionContext: "/repository",
      specifier: "example",
      exportName: "createExample",
    }),
  ).toEqual({
    accepted: true,
    request: {
      resolutionContext: "/repository",
      specifier: "example",
      exportName: "createExample",
      accessStyle: "import",
    },
  });
});

it("discriminates the Export Inspection analysis intent", () => {
  expect(
    readAnalysisRequest({
      intent: "export-inspection",
      request: {
        resolutionContext: "/repository",
        specifier: "example",
        exportName: "createExample",
        accessStyle: "require",
      },
    }),
  ).toEqual({
    accepted: true,
    request: {
      intent: "export-inspection",
      request: {
        resolutionContext: "/repository",
        specifier: "example",
        exportName: "createExample",
        accessStyle: "require",
      },
    },
  });
});

it("rejects compiler-shaped data in a focused Inspection Outcome", () => {
  const spaces = Object.assign(
    [
      {
        space: "value",
        declarations: [
          {
            kind: "function",
            text: "function createExample(): void;",
            provenance: {
              packageIdentity: { name: "example" },
              file: "index.d.ts",
              line: 1,
              column: 1,
            },
          },
        ],
      },
    ],
    { compilerNode: { flags: 1 } },
  );
  expect(
    enforceInspectionOutcome("export-inspection", {
      status: "success",
      result: {
        intent: "export-inspection",
        specifier: "example",
        packageIdentity: { name: "example" },
        moduleExport: {
          name: "createExample",
          spaces,
          signatures: [],
        },
        supportingTypes: [],
      },
    }),
  ).toEqual({
    status: "unsupported",
    message: "Inspection returned an invalid result.",
  });
});

it("accepts recursively named namespace members in a focused Inspection Outcome", () => {
  const outcome = {
    status: "success",
    result: {
      intent: "export-inspection",
      specifier: "example",
      packageIdentity: { name: "example" },
      moduleExport: {
        name: "tools",
        spaces: [
          {
            space: "namespace",
            members: [
              {
                name: "nested",
                declarations: [],
                members: [
                  {
                    name: "useNested",
                    declarations: [
                      {
                        kind: "function",
                        text: "function useNested(): void;",
                        provenance: {
                          packageIdentity: { name: "example" },
                          file: "index.d.ts",
                          line: 1,
                          column: 1,
                        },
                      },
                    ],
                    members: [],
                  },
                ],
              },
            ],
          },
        ],
        signatures: [],
      },
      supportingTypes: [],
    },
  };

  expect(enforceInspectionOutcome("export-inspection", outcome)).toEqual(outcome);
});

it("rejects flattened declarations in a namespace space", () => {
  expect(
    enforceInspectionOutcome("export-inspection", {
      status: "success",
      result: {
        intent: "export-inspection",
        specifier: "example",
        packageIdentity: { name: "example" },
        moduleExport: {
          name: "tools",
          spaces: [
            {
              space: "namespace",
              declarations: [],
            },
          ],
          signatures: [],
        },
        supportingTypes: [],
      },
    }),
  ).toEqual({
    status: "unsupported",
    message: "Inspection returned an invalid result.",
  });
});

it("rejects sparse arrays in a focused Inspection Outcome", () => {
  const supportingTypes: unknown[] = [];
  supportingTypes.length = 1;

  expect(
    enforceInspectionOutcome("export-inspection", {
      status: "success",
      result: {
        intent: "export-inspection",
        specifier: "example",
        packageIdentity: { name: "example" },
        moduleExport: {
          name: "createExample",
          spaces: [],
          signatures: [],
        },
        supportingTypes,
      },
    }),
  ).toEqual({
    status: "unsupported",
    message: "Inspection returned an invalid result.",
  });
});

it("rejects non-portable declaration provenance", () => {
  expect(
    enforceInspectionOutcome("export-inspection", {
      status: "success",
      result: {
        intent: "export-inspection",
        specifier: "example",
        packageIdentity: { name: "example" },
        moduleExport: {
          name: "createExample",
          spaces: [
            {
              space: "value",
              declarations: [
                {
                  kind: "function",
                  text: "function createExample(): void;",
                  provenance: {
                    packageIdentity: { name: "example" },
                    file: "../../outside.d.ts",
                    line: -4,
                    column: 0,
                  },
                },
              ],
            },
          ],
          signatures: [],
        },
        supportingTypes: [],
      },
    }),
  ).toEqual({
    status: "unsupported",
    message: "Inspection returned an invalid result.",
  });
});
