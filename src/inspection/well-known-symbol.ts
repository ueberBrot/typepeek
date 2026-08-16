const WELL_KNOWN_SYMBOL_MEMBER_NAMES = new Set(
  Object.getOwnPropertyNames(Symbol).filter(
    (name) => typeof Object.getOwnPropertyDescriptor(Symbol, name)?.value === "symbol",
  ),
);

/** Identifies runtime-standard Symbol members without depending on ambient declaration loading. */
export function isWellKnownSymbolMemberName(name: string): boolean {
  return WELL_KNOWN_SYMBOL_MEMBER_NAMES.has(name);
}
