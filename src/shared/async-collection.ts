import { Effect, Option } from "effect";
import {
  filter as filterEffect,
  forEach as forEachEffect,
} from "effect/Effect";

import { runAdapterEffect } from "#typepeek/shared/effect-adapter";

export const mapAsync = async <Value, Result>(
  values: Iterable<Value>,
  project: (value: Awaited<Value>, index: number) => Promise<Result>
): Promise<Result[]> =>
  await runAdapterEffect(
    forEachEffect(values, (value, index) =>
      Effect.promise(async () => await project(await value, index))
    )
  );

export const someAsync = async <Value>(
  values: readonly Value[],
  predicate: (value: Value, index: number) => Promise<boolean>
): Promise<boolean> =>
  Option.isSome(
    await runAdapterEffect(
      Effect.findFirst(values, (value, index) =>
        Effect.promise(async () => await predicate(value, index))
      )
    )
  );

export const everyAsync = async <Value>(
  values: readonly Value[],
  predicate: (value: Value, index: number) => Promise<boolean>
): Promise<boolean> =>
  Option.isNone(
    await runAdapterEffect(
      Effect.findFirst(values, (value, index) =>
        Effect.promise(async () => !(await predicate(value, index)))
      )
    )
  );

export const findAsync = async <Value>(
  values: readonly Value[],
  predicate: (value: Value, index: number) => Promise<boolean>
): Promise<Value | undefined> =>
  Option.getOrUndefined(
    await runAdapterEffect(
      Effect.findFirst(values, (value, index) =>
        Effect.promise(async () => await predicate(value, index))
      )
    )
  );

export const filterAsync = async <Value>(
  values: readonly Value[],
  predicate: (value: Value, index: number) => Promise<boolean>
): Promise<Value[]> =>
  await runAdapterEffect(
    filterEffect(values, (value: Value, index: number) =>
      Effect.promise(async () => await predicate(value, index))
    )
  );
