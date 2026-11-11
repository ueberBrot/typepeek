import type { Node } from "tsrs/ast";
import { visitEachChild } from "tsrs/ast";

import { mapAsync } from "#typepeek/shared/async-collection";

export const forEachChildAsync = async (
  node: Node,
  visit: (child: Node) => Promise<void>
): Promise<void> => {
  const children: Node[] = [];
  node.forEachChild((child) => {
    children.push(child);
  });

  await mapAsync(children, async (child) => {
    await visit(child);
  });
};

export const visitEachChildAsync = async <Value extends Node>(
  node: Value,
  visit: (child: Node) => Promise<Node>
): Promise<Value> => {
  const children: Node[] = [];
  visitEachChild(node, (child) => {
    children.push(child);

    return child;
  });
  const replacements = new Map<Node, Node>();

  await mapAsync(children, async (child) => {
    replacements.set(child, await visit(child));
  });

  return visitEachChild(node, (child) => replacements.get(child) ?? child);
};
