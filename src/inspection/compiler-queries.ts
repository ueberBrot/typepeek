import type { Node } from "tsrs/ast";
import type { Checker, Symbol as CompilerSymbol } from "tsrs/sync";

const QUERY_BATCH_SIZE = 128;

interface SymbolLookup {
  readonly symbol: CompilerSymbol | undefined;
}

const symbolCaches = new WeakMap<Checker, WeakMap<Node, SymbolLookup>>();

const symbolCache = (checker: Checker): WeakMap<Node, SymbolLookup> => {
  let cache = symbolCaches.get(checker);

  if (cache === undefined) {
    cache = new WeakMap();
    symbolCaches.set(checker, cache);
  }

  return cache;
};

/** Cache misses as well as symbols, with ownership confined to one checker. */
export const symbolAtLocation = (
  checker: Checker,
  node: Node
): CompilerSymbol | undefined => {
  const cache = symbolCache(checker);
  const cached = cache.get(node);

  if (cached !== undefined) {
    return cached.symbol;
  }

  const symbol = checker.getSymbolAtLocation(node);
  cache.set(node, { symbol });

  return symbol;
};

/** Bound each native response while retaining input order and duplicate locations. */
export const symbolsAtLocations = (
  checker: Checker,
  nodes: readonly Node[]
): readonly (CompilerSymbol | undefined)[] => {
  const cache = symbolCache(checker);

  for (let offset = 0; offset < nodes.length; offset += QUERY_BATCH_SIZE) {
    const missing = [
      ...new Set(
        nodes
          .slice(offset, offset + QUERY_BATCH_SIZE)
          .filter((node) => !cache.has(node))
      ),
    ];

    if (missing.length === 0) {
      continue;
    }

    const symbols = checker.getSymbolAtLocation(missing);

    if (symbols.length !== missing.length) {
      throw new Error(
        "The native compiler returned an incomplete symbol batch."
      );
    }

    for (const [index, node] of missing.entries()) {
      cache.set(node, { symbol: symbols[index] });
    }
  }

  return nodes.map((node) => cache.get(node)?.symbol);
};
