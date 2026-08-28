# Inspect package-boundary and declared platform modules

Typepeek inspects importable modules backed by Installed Evidence. Initially, these are Package Modules resolved across an installed package boundary and Node Platform Modules whose declarations are visible through installed `@types/node`.

Package interfaces may be backed by declarations or package-exposed TypeScript source, but Typepeek never surfaces implementation bodies. TypeScript `paths` or `baseUrl` aliases into arbitrary project source and non-module global libraries remain outside this boundary. This scope prevents Typepeek from becoming a general project-symbol inspector.
