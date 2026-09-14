# Inspect package-boundary and declared platform modules

Typepeek inspects importable modules backed by Installed Evidence. It supports Package Modules resolved across an installed package boundary and Node Platform Modules with visible declarations from installed `@types/node`.

Package interfaces may be backed by declarations or package-exposed TypeScript source, but Typepeek never surfaces implementation bodies. TypeScript `paths` or `baseUrl` aliases into arbitrary project source and non-module global libraries remain outside this boundary. This limits inspection to importable package and platform interfaces.
