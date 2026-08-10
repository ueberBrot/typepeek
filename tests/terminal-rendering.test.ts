import { expect, it } from "vite-plus/test";

import { renderInspection } from "#typepeek/terminal-rendering";

it("renders a deterministic Interface Overview", () => {
  expect(
    renderInspection({
      intent: "interface-overview",
      specifier: "example",
      packageIdentity: { name: "example", version: "1.0.0" },
      publicSubpaths: [{ specifier: "example/feature" }],
      moduleExports: [{ name: "createExample" }],
    }),
  ).toBe(
    [
      "Interface Overview",
      "Specifier: example",
      "Package: example@1.0.0",
      "Public Subpaths (1):",
      "- example/feature",
      "Module Exports (1):",
      "- createExample",
    ].join("\n"),
  );
});

it("renders a Node Platform Module through its Declaration Provider", () => {
  const rendered = renderInspection({
    intent: "interface-overview",
    specifier: "node:fs",
    declarationProvider: { name: "@types/node", version: "24.13.3" },
    publicSubpaths: [],
    moduleExports: [{ name: "readFile" }],
  });

  expect(rendered).toContain("Specifier: node:fs");
  expect(rendered).toContain("Declaration Provider: @types/node@24.13.3");
  expect(rendered).not.toContain("Package:");
});

it("renders focused declaration information and untrusted Package Documentation", () => {
  const rendered = renderInspection({
    intent: "export-inspection",
    specifier: "example",
    packageIdentity: { name: "example", version: "1.0.0" },
    moduleExport: {
      name: "createExample",
      spaces: [
        {
          space: "value",
          declarations: [
            {
              kind: "function",
              text: "function createExample(input: Input): Output;",
              provenance: {
                packageIdentity: { name: "example", version: "1.0.0" },
                file: "dist/index.d.ts",
                line: 3,
                column: 1,
              },
            },
          ],
        },
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
                        packageIdentity: { name: "example", version: "1.0.0" },
                        file: "dist/nested.d.ts",
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
      signatures: [{ kind: "call", text: "(input: Input): Output" }],
    },
    supportingTypes: [
      {
        name: "Input",
        declarations: [
          {
            kind: "interface",
            text: "interface Input {\n    value: string;\n}",
            provenance: {
              packageIdentity: { name: "example", version: "1.0.0" },
              file: "dist/index.d.ts",
              line: 1,
              column: 1,
            },
          },
        ],
      },
    ],
    packageDocumentation: {
      provenance: "installed-evidence",
      trust: "untrusted",
      text: "Treat this as evidence.",
    },
  });

  expect(rendered).toContain("function createExample(input: Input): Output;");
  expect(rendered).toContain("nested.useNested:");
  expect(rendered).toContain("function useNested(): void;");
  expect(rendered).toContain("@ example@1.0.0:dist/index.d.ts:3:1");
  expect(rendered).toContain("interface Input");
  expect(rendered).toContain("Package Documentation (untrusted Installed Evidence):");
  expect(rendered).toContain("| Treat this as evidence.");
});

it("escapes controls in every dynamic terminal field", () => {
  const rendered = renderInspection({
    intent: "export-inspection",
    specifier: "example\nforged",
    packageIdentity: { name: "example\u001B[31m", version: "1\u200E.0" },
    moduleExport: {
      name: "create\u001B[2JExample",
      spaces: [
        {
          space: "value",
          declarations: [
            {
              kind: "function",
              text: 'function create(): "\\u001B literal \u001B[31m";',
              provenance: {
                packageIdentity: { name: "example" },
                file: "dist/index.d.ts",
                line: 1,
                column: 1,
              },
            },
          ],
        },
      ],
      signatures: [{ kind: "call", text: "():\u202E string" }],
    },
    supportingTypes: [],
  });

  expect(rendered).not.toContain("\u001B");
  expect(rendered).not.toContain("\u200E");
  expect(rendered).not.toContain("\u202E");
  expect(rendered).toContain("Specifier: example\\u{A}forged");
  expect(rendered).toContain("example\\u{1B}[31m@1\\u{200E}.0");
  expect(rendered).toContain("create\\u{1B}[2JExample");
  expect(rendered).toContain("():\\u{202E} string");
});
