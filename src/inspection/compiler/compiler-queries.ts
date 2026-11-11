import type { Node } from "tsrs/ast";
import type { Checker, Symbol as CompilerSymbol } from "tsrs/async";

const QUERY_BATCH_SIZE = 128;

const aliasCaches = new WeakMap<
  Checker,
  WeakMap<CompilerSymbol, CompilerSymbol>
>();

/** Alias targets remain stable only within their originating checker. */
export const aliasedSymbol = async (
  checker: Checker,
  symbol: CompilerSymbol
): Promise<CompilerSymbol> => {
  let cache = aliasCaches.get(checker);

  if (cache === undefined) {
    cache = new WeakMap();
    aliasCaches.set(checker, cache);
  }

  let target = cache.get(symbol);

  if (target === undefined) {
    target = await checker.getAliasedSymbol(symbol);
    cache.set(symbol, target);
  }

  return target;
};

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
export const symbolAtLocation = async (
  checker: Checker,
  node: Node
): Promise<CompilerSymbol | undefined> => {
  const cache = symbolCache(checker);
  const cached = cache.get(node);

  if (cached !== undefined) {
    return cached.symbol;
  }

  const symbol = await checker.getSymbolAtLocation(node);
  cache.set(node, { symbol });

  return symbol;
};

/** Bound each native response while retaining input order and duplicate locations. */
export const symbolsAtLocations = async (
  checker: Checker,
  nodes: readonly Node[]
): Promise<readonly (CompilerSymbol | undefined)[]> => {
  const cache = symbolCache(checker);

  /* oxlint-disable eslint/no-await-in-loop -- Each batch populates the cache used to select misses in the next batch. */
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

    const symbols = await checker.getSymbolAtLocation(missing);

    if (symbols.length !== missing.length) {
      throw new Error(
        "The native compiler returned an incomplete symbol batch."
      );
    }

    for (const [index, node] of missing.entries()) {
      cache.set(node, { symbol: symbols[index] });
    }
  }
  /* oxlint-enable eslint/no-await-in-loop */

  return nodes.map((node) => cache.get(node)?.symbol);
};
