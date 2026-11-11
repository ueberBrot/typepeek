import { Predicate } from "effect";

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-object-parameters -- The result budget counts heterogeneous trusted fragments without changing their domain contracts. */
import {
  MAX_RESULT_CONSTRUCTION_BYTES,
  MAX_RESULT_CONSTRUCTION_NODES,
} from "#typepeek/inspection/model/budget-policy";
import { InspectionLimitError } from "#typepeek/inspection/model/errors";

interface FragmentSize {
  readonly bytes: number;
  readonly nodes: number;
}

const countResultNodes = function countResultNodes(value: unknown): number {
  if (!Predicate.isObjectOrArray(value)) {
    return 1;
  }

  return (
    1 +
    Object.values(value).reduce<number>(
      (count, child) => count + countResultNodes(child),
      0
    )
  );
};

const measuredFragmentSize = function measuredFragmentSize(
  value: object
): FragmentSize {
  return {
    bytes: Buffer.byteLength(JSON.stringify(value)),
    nodes: countResultNodes(value),
  };
};

export class ResultConstructionBudget {
  readonly #fragmentSizes = new WeakMap<object, FragmentSize>();
  #bytes = 0;
  #nodes = 0;
  leaf<Value extends object>(value: Value): Value {
    return this.#retain(value, []);
  }
  container<Value extends object>(
    value: Value,
    children: readonly object[]
  ): Value {
    return this.#retain(value, children);
  }
  #retain<Value extends object>(
    value: Value,
    children: readonly object[]
  ): Value {
    const size = measuredFragmentSize(value);

    const childSize = { bytes: 0, nodes: 0 };

    for (const child of children) {
      const retained = this.#fragmentSizes.get(child);

      if (retained === undefined) {
        throw new Error(
          "Inspection Result construction received an unretained child fragment."
        );
      }

      childSize.bytes += retained.bytes;
      childSize.nodes += retained.nodes;
    }

    this.#bytes += size.bytes - childSize.bytes;
    this.#nodes += size.nodes - childSize.nodes;

    if (
      this.#bytes > MAX_RESULT_CONSTRUCTION_BYTES ||
      this.#nodes > MAX_RESULT_CONSTRUCTION_NODES
    ) {
      throw new InspectionLimitError(
        "result-construction",
        "Inspection exceeded its output limit."
      );
    }

    this.#fragmentSizes.set(value, size);

    return value;
  }
}
