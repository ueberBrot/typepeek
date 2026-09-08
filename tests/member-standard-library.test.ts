import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";

import { inspectExportMember, inspectExportMembers } from "#typepeek/inspection";

let resolutionContext: string;
const specifier = "standard-library-members";
beforeAll(async () => {
  resolutionContext = await mkdtemp(join(tmpdir(), "typepeek-standard-library-members-"));
  const packageRoot = join(resolutionContext, "node_modules", specifier);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(resolutionContext, "package.json"), '{"type":"module"}');
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: specifier, type: "module", types: "index.d.ts" }),
  );
  await writeFile(
    join(packageRoot, "index.d.ts"),
    "export interface Container { items: string[]; } export interface Failure extends Error { code: number; }",
  );
});
afterAll(async () => {
  await rm(resolutionContext, { recursive: true, force: true });
});

it("fails explicitly when standard-library Members cannot yield a complete selectable index", async () => {
  const outcome = await inspectExportMembers({
    resolutionContext,
    specifier,
    exportName: "Container",
    memberPath: ["items"],
  });
  expect(outcome).toMatchObject({ status: "unsupported", reason: "unsupported-evidence" });
  expect(outcome).not.toHaveProperty("result");
  const filtered = await inspectExportMembers({
    resolutionContext,
    specifier,
    exportName: "Container",
    memberPath: ["items"],
    query: "length",
  });
  expect(filtered).toMatchObject({ status: "unsupported", reason: "unsupported-evidence" });
});

it("finds standard-library Members without attributing them to Installed Evidence", async () => {
  const outcome = await inspectExportMember({
    resolutionContext,
    specifier,
    exportName: "Container",
    memberPath: ["items", "length"],
  });
  expect(outcome).toMatchObject({ status: "unsupported", reason: "unsupported-evidence" });
  expect(outcome).not.toHaveProperty("result");
});

it("discovers inherited standard-library names instead of reporting only package-owned members", async () => {
  const outcome = await inspectExportMembers({
    resolutionContext,
    specifier,
    exportName: "Failure",
  });
  expect(outcome, JSON.stringify(outcome)).toMatchObject({
    status: "success",
    result: {
      totalMembers: 5,
      members: [
        { name: "cause", spaces: ["type"] },
        { name: "code", spaces: ["type"] },
        { name: "message", spaces: ["type"] },
        { name: "name", spaces: ["type"] },
        { name: "stack", spaces: ["type"] },
      ],
    },
  });
});

it("retains package declaration provenance when standard-library member resolution is enabled", async () => {
  const outcome = await inspectExportMember({
    resolutionContext,
    specifier,
    exportName: "Failure",
    memberPath: ["code"],
  });
  expect(outcome, JSON.stringify(outcome)).toMatchObject({
    status: "success",
    result: {
      declarations: [
        {
          kind: "property",
          text: "code: number;",
          provenance: { packageIdentity: { name: specifier } },
        },
      ],
    },
  });
});
