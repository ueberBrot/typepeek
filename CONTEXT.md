# Typepeek

Typepeek describes the TypeScript-visible Public Interface of Inspectable Modules within a repository Resolution Context. Coding agents are the primary consumers; terminal users are secondary.

## Language

**Module Export**:
A TypeScript-visible export of an Inspectable Module selected from a Specifier within a Resolution Context. It may be backed by declarations or package-exposed TypeScript source.
_Avoid_: API, package export, project symbol

**Public Interface**:
The TypeScript-visible exported type surface of an Inspectable Module, including its Module Exports, reachable Supporting Types, overloads, aliases, and attached Package Documentation. It may be derived from declarations or exported TypeScript source, but implementation bodies and unrelated private or internal declarations are not part of the Public Interface.
_Avoid_: implementation, internals

**Supporting Type**:
A type referenced by a Module Export whose shape is needed to understand that export. It may be part of the Public Interface even when it is not independently importable.
_Avoid_: internal type, transitive export

**Package Documentation**:
Package-provided JSDoc attached to a Module Export. It is untrusted text and is distinct from the declaration that defines the Public Interface.
_Avoid_: comments, explanation

**Installed Evidence**:
The manifests, declarations, package-exposed TypeScript source, and attached Package Documentation already present in the repository's Supported Installation. Registry data, online documentation, and files downloaded during inspection are not Installed Evidence.
_Avoid_: local truth, cached documentation

**Static Inspection**:
Inspection that reads Installed Evidence without importing a package, executing dependency code, running package scripts, or evaluating project configuration code.
_Avoid_: safe execution, runtime inspection

**Interface Overview**:
A bounded index of the Module Exports at a selected entrypoint, used when the desired export is not yet known. At a package root it may also advertise Public Subpaths without recursively inspecting them.
_Avoid_: list, search results

**Public Subpath**:
A non-root package entrypoint explicitly exposed by the package manifest. A file path that merely exists inside the package is not a Public Subpath.
_Avoid_: internal path, deep import

**Public Subpath Pattern**:
A package-manifest wildcard that describes a family of potential Public Subpaths. It is not itself an exact Specifier; a matching exact Specifier identifies a Public Subpath only when the selected Resolution Variant exposes it.
_Avoid_: wildcard Specifier, Public Subpath

**Public Subpath Discovery**:
A lightweight Inspection Result containing the bounded exact Public Subpaths visible from a package root under one Resolution Variant. It reads manifest and resolution evidence without materializing a TypeScript program and does not recursively inspect the subpaths.
_Avoid_: Interface Overview, directory listing, deep-import scan

**Module Export Search**:
A bounded case-insensitive name search over the Module Exports of one Inspectable Module. It returns matching names and the complete candidate count without constructing an Interface Overview or traversing declarations and Supporting Types.
_Avoid_: Interface Overview filter, fuzzy search, documentation search

**Export Inspection**:
A focused description of one Module Export, including its relevant declarations, bounded Supporting Types, and Package Documentation.
_Avoid_: show, lookup

**Signature Inspection**:
A bounded focused Inspection Result containing every statically visible public call and construct signature for one Module Export in a Resolution Variant, together with Installed Evidence identity and an alias target name when applicable. It intentionally omits declaration spaces, Supporting Types, and Package Documentation; zero signatures authoritatively means the Module Export is neither publicly callable nor publicly constructable.
Each signature keeps the compiler rendering plus structured type parameters, an explicit `this` parameter, ordinary parameters, and return or predicate semantics.
_Avoid_: partial Export Inspection, fallback result

**Inspection Plan**:
A bounded ordered set of inspection queries for one Specifier, Resolution Context, and Access Style. It shares one Installed Evidence selection and compiler-work budget, and succeeds only when every query produces its complete Inspection Result in the same order. Any failure or aggregate budget exhaustion fails the whole plan without partial authority.
_Avoid_: session, batch of independent inspections, partial plan

**Inspection Result**:
A bounded, deterministic presentation of Installed Evidence for an Interface Overview, Module Export Search, Public Subpath Discovery, Export Inspection, Signature Inspection, or atomic Inspection Plan. It describes one Resolution Variant and contains no generated explanation, usage example, or behavioral claim.
_Avoid_: answer, summary

**Resolution Context**:
A location in the repository from which dependency visibility and module resolution are determined. How that location is selected is an interaction decision, not part of the term.
_Avoid_: repository, workspace root

**Access Style**:
The static source form—`import` or `require`—whose conditions participate in selecting a Resolution Variant.
_Avoid_: module mode, module format

**Resolution Variant**:
The single Public Interface selected for a Specifier by the Access Style and applicable conditions in a Resolution Context. Interfaces selected by alternative conditions are distinct variants and are not merged.
_Avoid_: branch, combined interface

**Specifier**:
The exact importable module identifier submitted for inspection, including any package scope, package-manager alias, Public Subpath, or platform prefix.
_Avoid_: package, file path

**Package Identity**:
The manifest name and, when declared, version of a package. It may differ from the package name in the Specifier when a package-manager alias is used; an unpublished workspace package may be unversioned, and Typepeek never invents a version.
_Avoid_: dependency name, package key

**Inspectable Module**:
An importable module with a Public Interface backed by Installed Evidence and visible within a Resolution Context. The initial forms are Package Module and Node Platform Module.
_Avoid_: package, project module

**Package Module**:
An Inspectable Module resolved through an installed package boundary, including a package root or Public Subpath. A path mapping into arbitrary project source is not a Package Module.
_Avoid_: dependency, package file

**Platform Module**:
An Inspectable Module provided by a known runtime rather than an installed package, with declarations supplied by an installed and context-visible Declaration Provider. Initially this means Node built-ins such as `node:fs` backed by `@types/node`.
_Avoid_: global type, standard library

**Declaration Provider**:
The package containing declarations TypeScript resolves for an Inspectable Module. For a Package Module it is the same package or a separate package such as `@types/express`; for a Platform Module it supplies the runtime's declarations, such as `@types/node`.
_Avoid_: types package, declaration source

**Supported Installation**:
A dependency tree materialized in `node_modules` by npm, pnpm, or Bun using a verified ordinary hoisted or isolated layout. Package-manager runtime resolution without `node_modules`, including auto-install and Plug'n'Play, is not a Supported Installation.
_Avoid_: supported package manager
