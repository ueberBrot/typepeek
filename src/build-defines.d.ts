import type { StandardGlobalCatalog } from "#typepeek/inspection/standard-global-catalog";

declare global {
  var __TYPEPEEK_VERSION__: string | undefined;
  var __TYPEPEEK_COMPILER_VERSION__: string | undefined;
  var __TYPEPEEK_STANDARD_GLOBALS__: StandardGlobalCatalog | undefined;
}
