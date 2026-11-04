import { describe, expect, it } from "vite-plus/test";

import { renderInspection } from "#typepeek/terminal-rendering";

describe("terminal-rendering", () => {
  it("renders Member Discovery selectors and escapes package-controlled names", () => {
    const rendered = renderInspection({
      intent: "member-discovery",
      memberPath: [{ name: "nested", space: "type" }],
      members: [{ name: "shared\nvalue", spaces: ["type", "value"] }],
      moduleExportName: "Shape",
      packageIdentity: { name: "example", version: "1.0.0" },
      query: "SHARED\u001B[31m",
      resolutionVariant: { accessStyle: "import" },
      specifier: "example",
      totalMembers: 3,
    });

    expect([
      rendered.includes("Members of: Shape.type:nested"),
      rendered.includes("3 total"),
      rendered.includes("(type, value)"),
      rendered.includes("\u001B"),
      rendered.includes("shared\nvalue"),
    ]).toStrictEqual([true, true, true, false, false]);
  });

  it("renders a deterministic Interface Overview", () => {
    expect(
      renderInspection({
        intent: "interface-overview",
        moduleExports: [{ name: "createExample" }],
        packageIdentity: { name: "example", version: "1.0.0" },
        publicSubpaths: [{ specifier: "example/feature" }],
        resolutionVariant: { accessStyle: "import" },
        specifier: "example",
      })
    ).toBe(
      [
        "Interface Overview",
        "Specifier: example",
        "Access Style: import",
        "Package: example@1.0.0",
        "Module Exports (1):",
        "- createExample",
        "Public Subpaths (1; use --subpaths to list):",
      ].join("\n")
    );
  });

  it("expands Public Subpaths after Module Exports when requested", () => {
    expect(
      renderInspection(
        {
          intent: "interface-overview",
          moduleExports: [{ name: "createExample" }],
          packageIdentity: { name: "example", version: "1.0.0" },
          publicSubpaths: [{ specifier: "example/feature" }],
          resolutionVariant: { accessStyle: "import" },
          specifier: "example",
        },
        { includePublicSubpaths: true }
      )
    ).toContain(
      [
        "Module Exports (1):",
        "- createExample",
        "Public Subpaths (1):",
        "- example/feature",
      ].join("\n")
    );
  });

  it("renders a Node Platform Module through its Declaration Provider", () => {
    const rendered = renderInspection({
      declarationProvider: { name: "@types/node", version: "24.13.3" },
      intent: "interface-overview",
      moduleExports: [{ name: "readFile" }],
      publicSubpaths: [],
      resolutionVariant: { accessStyle: "import" },
      specifier: "node:fs",
    });

    expect([
      rendered.includes("Specifier: node:fs"),
      rendered.includes("Declaration Provider: @types/node@24.13.3"),
      rendered.includes("Package:"),
    ]).toStrictEqual([true, true, false]);
  });

  it("renders focused declaration information and untrusted Package Documentation", () => {
    const rendered = renderInspection({
      intent: "export-inspection",
      moduleExport: {
        name: "createExample",
        signatures: [{ kind: "call", text: "(input: Input): Output" }],
        spaces: [
          {
            declarations: [
              {
                kind: "function",
                provenance: {
                  column: 1,
                  file: "dist/index.d.ts",
                  line: 3,
                  packageIdentity: { name: "example", version: "1.0.0" },
                },
                text: "function createExample(input: Input): Output;",
              },
            ],
            space: "value",
          },
          {
            members: [
              {
                declarations: [],
                members: [
                  {
                    declarations: [
                      {
                        kind: "function",
                        provenance: {
                          column: 1,
                          file: "dist/nested.d.ts",
                          line: 1,
                          packageIdentity: {
                            name: "example",
                            version: "1.0.0",
                          },
                        },
                        text: "function useNested(): void;",
                      },
                    ],
                    members: [],
                    name: "useNested",
                  },
                ],
                name: "nested",
              },
            ],
            space: "namespace",
          },
        ],
      },
      packageDocumentation: {
        provenance: "installed-evidence",
        text: "Treat this as evidence.",
        trust: "untrusted",
      },
      packageIdentity: { name: "example", version: "1.0.0" },
      resolutionVariant: { accessStyle: "import" },
      specifier: "example",
      supportingTypes: [
        {
          declarations: [
            {
              kind: "interface",
              provenance: {
                column: 1,
                file: "dist/index.d.ts",
                line: 1,
                packageIdentity: { name: "example", version: "1.0.0" },
              },
              text: "interface Input {\n    value: string;\n}",
            },
          ],
          name: "Input",
        },
      ],
    });

    expect([
      rendered.includes("function createExample(input: Input): Output;"),
      rendered.includes("nested.useNested:"),
      rendered.includes("function useNested(): void;"),
      rendered.includes("@ example@1.0.0:dist/index.d.ts:3:1"),
      rendered.includes("interface Input"),
      rendered.includes(
        "Package Documentation (untrusted Installed Evidence):"
      ),
      rendered.includes("| Treat this as evidence."),
    ]).toStrictEqual([true, true, true, true, true, true, true]);
  });

  it("renders a concise Signature Inspection", () => {
    expect(
      renderInspection({
        intent: "signature-inspection",
        moduleExport: {
          aliasTargetName: "buildExample",
          name: "createExample",
          signatures: [
            {
              kind: "call",
              parameters: [
                {
                  binding: {
                    kind: "identifier",
                    name: "input",
                    synthetic: false,
                  },
                  optional: false,
                  rest: false,
                  type: "string",
                },
              ],
              returns: { kind: "type", type: "number" },
              text: "(input: string): number",
              typeParameters: [],
            },
          ],
        },
        packageIdentity: { name: "example", version: "1.0.0" },
        resolutionVariant: { accessStyle: "require" },
        specifier: "example",
      })
    ).toBe(
      [
        "Signature Inspection",
        "Specifier: example",
        "Access Style: require",
        "Package: example@1.0.0",
        "Module Export: createExample (alias of buildExample)",
        "Signatures (1):",
        "- call: (input: string): number",
      ].join("\n")
    );
  });

  it("escapes controls in every dynamic terminal field", () => {
    const rendered = renderInspection({
      intent: "export-inspection",
      moduleExport: {
        name: "create\u001B[2JExample",
        signatures: [{ kind: "call", text: "():\u202E string" }],
        spaces: [
          {
            declarations: [
              {
                kind: "function",
                provenance: {
                  column: 1,
                  file: "dist/index.d.ts",
                  line: 1,
                  packageIdentity: { name: "example" },
                },
                text: 'function create(): "\\u001B literal \u001B[31m";',
              },
            ],
            space: "value",
          },
        ],
      },
      packageIdentity: { name: "example\u001B[31m", version: "1\u200E.0" },
      resolutionVariant: { accessStyle: "import" },
      specifier: "example\nforged",
      supportingTypes: [],
    });

    expect([
      rendered.includes("\u001B"),
      rendered.includes("\u200E"),
      rendered.includes("\u202E"),
      rendered.includes("Specifier: example\\u{A}forged"),
      rendered.includes("example\\u{1B}[31m@1\\u{200E}.0"),
      rendered.includes("create\\u{1B}[2JExample"),
      rendered.includes("():\\u{202E} string"),
    ]).toStrictEqual([false, false, false, true, true, true, true]);
  });

  it("fails explicitly when terminal escaping expands otherwise bounded evidence too far", () => {
    expect(() =>
      renderInspection({
        intent: "interface-overview",
        moduleExports: [],
        packageIdentity: { name: "example", version: "1.0.0" },
        publicSubpaths: [],
        resolutionVariant: { accessStyle: "import" },
        specifier: "\0".repeat(30_000),
      })
    ).toThrow("Inspection exceeded its terminal output limit.");
  });
});
