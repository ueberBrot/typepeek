# Typepeek

Typepeek describes the TypeScript-visible Public Interface of Inspectable Modules within a repository Resolution Context. Coding agents are the primary consumers; terminal users are secondary.

## Language

### Evidence and interface

**Installed Evidence**:
The manifests, declarations, package-exposed TypeScript source, and attached Package Documentation already present in the repository's Supported Installation. Registry data, online documentation, and files downloaded during inspection are not Installed Evidence.
_Avoid_: local truth, cached documentation

**Static Inspection**:
Inspection that reads Installed Evidence without importing a package, executing dependency code, running package scripts, or evaluating project configuration code.
_Avoid_: safe execution, runtime inspection

**Public Interface**:
The TypeScript-visible exported type surface of an Inspectable Module, including its Module Exports, reachable Supporting Types, overloads, aliases, and attached Package Documentation. Implementation bodies and unrelated private or internal declarations lie outside the Public Interface.
_Avoid_: implementation, internals

**Module Export**:
A TypeScript-visible export of an Inspectable Module selected from a Specifier within a Resolution Context. It may be backed by declarations or package-exposed TypeScript source.
_Avoid_: API, package export, project symbol

**Supporting Type**:
A type referenced by a Module Export whose shape is needed to understand that export. It may belong to the Public Interface without being independently importable.
_Avoid_: internal type, transitive export

**Package Documentation**:
Package-provided JSDoc attached to a Module Export. It is untrusted text, distinct from the declaration that defines the Public Interface.
_Avoid_: comments, explanation

### Resolution and modules

**Resolution Context**:
A repository location from which Typepeek determines dependency visibility and module resolution. How a caller selects that location is an interaction decision, not part of the term.
_Avoid_: repository, workspace root

**Specifier**:
The exact importable module identifier submitted for inspection, including any package scope, package-manager alias, Public Subpath, or platform prefix.
_Avoid_: package, file path

**Access Style**:
The static source form—`import` or `require`—whose conditions participate in selecting a Resolution Variant.
_Avoid_: module mode, module format

**Resolution Variant**:
The single Public Interface selected for a Specifier by the Access Style and applicable conditions in a Resolution Context. Interfaces selected by alternative conditions are distinct variants and are never merged.
_Avoid_: branch, combined interface

**Package Identity**:
The manifest name and, when declared, version of a package. Its name may differ from the package name in the Specifier when a package-manager alias is used; unpublished workspace packages may be unversioned, and Typepeek never invents a version.
_Avoid_: dependency name, package key

**Inspectable Module**:
An importable module with a Public Interface backed by Installed Evidence and visible within a Resolution Context. The initial forms are Package Module and Node Platform Module.
_Avoid_: package, project module

**Package Module**:
An Inspectable Module resolved through an installed package boundary, including a package root or Public Subpath. A path mapping into arbitrary project source is not a Package Module.
_Avoid_: dependency, package file

**Public Subpath**:
A non-root package entrypoint explicitly exposed by the package manifest. A file path that merely exists inside the package is not a Public Subpath.
_Avoid_: internal path, deep import

**Public Subpath Pattern**:
A package-manifest wildcard that describes a family of potential Public Subpaths. It is not itself an exact Specifier; a matching exact Specifier identifies a Public Subpath only when the selected Resolution Variant exposes it.
_Avoid_: wildcard Specifier, Public Subpath

**Platform Module**:
An Inspectable Module provided by a known runtime rather than an installed package, with declarations supplied by an installed, context-visible Declaration Provider. Initially, this means Node built-ins such as `node:fs` backed by `@types/node`.
_Avoid_: global type, standard library

**Declaration Provider**:
The package containing declarations that TypeScript resolves for an Inspectable Module. It may be the Package Module itself, a separate package such as `@types/express`, or a runtime declaration package such as `@types/node`.
_Avoid_: types package, declaration source

**Supported Installation**:
A dependency tree materialized in `node_modules` by npm, pnpm, or Bun using a verified ordinary hoisted or isolated layout. Package-manager resolution without `node_modules`, including auto-install and Plug'n'Play, is not a Supported Installation.
_Avoid_: supported package manager

### Inspections

**Inspection Result**:
A bounded, deterministic presentation of Installed Evidence produced by a supported inspection. An atomic result describes one Resolution Variant, while a comparison preserves two; no result contains a generated explanation, usage example, or behavioral claim.
_Avoid_: answer, summary

**Interface Overview**:
A bounded index of the Module Exports at a selected entrypoint. At a package root, it may also advertise Public Subpaths without inspecting them.
_Avoid_: list, search results

**Public Interface Comparison**:
A bounded directional delta between two complete Interface Overview indexes. It preserves each side's Specifier, Package or Declaration Provider identity, and Resolution Variant, and reports added or removed Module Export names and Public Subpaths without implying that retained names have unchanged declarations or signatures.
_Avoid_: merged interface, semantic version check, declaration diff

**Public Subpath Discovery**:
A lightweight Inspection Result containing the bounded exact Public Subpaths visible from a package root under one Resolution Variant. It does not inspect those subpaths.
_Avoid_: Interface Overview, directory listing, deep-import scan

**Module Export Search**:
A bounded, case-insensitive name search over the Module Exports of one Inspectable Module. It contains matching names and the complete candidate count.
_Avoid_: Interface Overview filter, fuzzy search, documentation search

**Export Inspection**:
A focused Inspection Result for one Module Export containing its relevant declarations, bounded Supporting Types, and Package Documentation.
_Avoid_: show, lookup

**Signature Inspection**:
A bounded Inspection Result containing every statically visible public call and construct signature for one Module Export in a Resolution Variant. Zero signatures means the Module Export is neither publicly callable nor publicly constructable.
_Avoid_: partial Export Inspection, fallback result

**Declaration Inspection**:
A bounded Inspection Result containing the complete declaration spaces of one Module Export in a Resolution Variant. It excludes signatures, Supporting Types, and Package Documentation rather than returning a partial Export Inspection.
_Avoid_: stripped Export Inspection, declaration preview

**Member Inspection**:
A bounded Inspection Result containing the complete public declarations for one exact Member path beneath a Module Export. It excludes unrelated Members, Supporting Types, signatures, and Package Documentation.
_Avoid_: member search, object traversal, runtime property lookup

**Inspection Plan**:
A bounded, ordered set of inspection queries for one Specifier, Resolution Context, and Access Style. It shares one Installed Evidence selection and aggregate budget, returning ordered complete Inspection Results only if every query succeeds; otherwise, the whole plan fails without partial authority.
_Avoid_: session, batch of independent inspections, partial plan

### Protocol and failures

**Inspection Protocol**:
The transport-neutral request and response envelope through which adapters invoke Inspection Core. Each response identifies its protocol revision and contains one complete Inspection Outcome; adapters may render or transport it but never reinterpret Inspection Core.
_Avoid_: CLI JSON, MCP protocol, wire format

**Inspection Capability**:
A deterministic declaration of the Inspection Protocol revision, intents, Failure Reasons, and Budget Dimensions supported by this Typepeek build, independent of Installed Evidence.
_Avoid_: feature flag, runtime detection

**Failure Reason**:
The stable machine-readable cause attached to a failed inspection, more specific than its broad failure status. Human-readable failure messages are explanatory and are not identifiers.
_Avoid_: error message, exit code

**Budget Dimension**:
The named resource or work boundary that a `limit-exceeded` Inspection Outcome exhausted, such as Module Export count, result bytes, or analysis deadline.
_Avoid_: timeout message, performance metric

### Cache

**Installed Evidence Proof**:
A bounded internal receipt of the Installed Evidence consumed by one completed inspection, used to determine whether an Inspection Cache Entry remains reusable. It never substitutes for Installed Evidence or crosses the public Inspection Core interface.
_Avoid_: lockfile, cache key, Inspection Result

**Inspection Cache Entry**:
An optional, integrity-protected copy of one validated, complete, successful Inspection Outcome whose Installed Evidence Proof must remain valid before reuse. It never becomes Installed Evidence or a source of inspection authority.
_Avoid_: Installed Evidence, source of truth, partial result
