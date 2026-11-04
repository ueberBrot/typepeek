import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  inspectExportMember,
  inspectExportMembers,
} from "#typepeek/inspection";

let resolutionContext: string;
const specifier = "standard-library-members";

describe("member-standard-library", () => {
  beforeAll(async () => {
    resolutionContext = await mkdtemp(
      nodePath.join(tmpdir(), "typepeek-standard-library-members-")
    );

    const packageRoot = nodePath.join(
      resolutionContext,
      "node_modules",
      specifier
    );

    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      nodePath.join(resolutionContext, "package.json"),
      '{"type":"module"}'
    );
    await writeFile(
      nodePath.join(packageRoot, "package.json"),
      JSON.stringify({ name: specifier, type: "module", types: "index.d.ts" })
    );
    await writeFile(
      nodePath.join(packageRoot, "index.d.ts"),
      "export interface Container { items: string[]; } export interface Failure extends Error { code: number; }"
    );
  });

  afterAll(async () => {
    await rm(resolutionContext, { force: true, recursive: true });
  });

  it("fails explicitly when standard-library Members cannot yield a complete selectable index", async () => {
    const outcome = await inspectExportMembers({
      exportName: "Container",
      memberPath: ["items"],
      resolutionContext,
      specifier,
    });

    expect(outcome).toMatchObject({
      reason: "unsupported-evidence",
      status: "unsupported",
    });
    expect(outcome).not.toHaveProperty("result");

    const filtered = await inspectExportMembers({
      exportName: "Container",
      memberPath: ["items"],
      query: "length",
      resolutionContext,
      specifier,
    });

    expect(filtered).toMatchObject({
      reason: "unsupported-evidence",
      status: "unsupported",
    });
  });

  it("finds standard-library Members without attributing them to Installed Evidence", async () => {
    const outcome = await inspectExportMember({
      exportName: "Container",
      memberPath: ["items", "length"],
      resolutionContext,
      specifier,
    });

    expect(outcome).toMatchObject({
      reason: "unsupported-evidence",
      status: "unsupported",
    });
    expect(outcome).not.toHaveProperty("result");
  });

  it("discovers inherited standard-library names instead of reporting only package-owned members", async () => {
    const outcome = await inspectExportMembers({
      exportName: "Failure",
      resolutionContext,
      specifier,
    });

    expect(outcome).toMatchObject({
      result: {
        members: [
          { name: "cause", spaces: ["type"] },
          { name: "code", spaces: ["type"] },
          { name: "message", spaces: ["type"] },
          { name: "name", spaces: ["type"] },
          { name: "stack", spaces: ["type"] },
        ],
        totalMembers: 5,
      },
      status: "success",
    });
  });

  it("retains package declaration provenance when standard-library member resolution is enabled", async () => {
    const outcome = await inspectExportMember({
      exportName: "Failure",
      memberPath: ["code"],
      resolutionContext,
      specifier,
    });

    expect(outcome).toMatchObject({
      result: {
        declarations: [
          {
            kind: "property",
            provenance: { packageIdentity: { name: specifier } },
            text: "code: number;",
          },
        ],
      },
      status: "success",
    });
  });
});
