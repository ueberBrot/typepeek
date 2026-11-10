import { Predicate } from "effect";

const WELL_KNOWN_SYMBOL_MEMBER_NAMES = new Set(
  Object.getOwnPropertyNames(Symbol).filter((name) =>
    Predicate.isSymbol(Object.getOwnPropertyDescriptor(Symbol, name)?.value)
  )
);

/** Identifies runtime-standard Symbol members without depending on ambient declaration loading. */
export const isWellKnownSymbolMemberName = function isWellKnownSymbolMemberName(
  name: string
): boolean {
  return WELL_KNOWN_SYMBOL_MEMBER_NAMES.has(name);
};
