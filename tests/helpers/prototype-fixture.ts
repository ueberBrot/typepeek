/** Installs hostile inherited fields for parser tests; callers restore them in finally blocks. */
export const defineObjectPrototypeProperty = (
  key: PropertyKey,
  descriptor: PropertyDescriptor
): void => {
  // oxlint-disable-next-line eslint/no-extend-native -- These tests verify that inherited getters cannot influence untrusted-data parsing.
  Object.defineProperty(Object.prototype, key, descriptor);
};
