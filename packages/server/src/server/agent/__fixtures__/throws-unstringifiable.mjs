// Throws a value whose stringification itself throws, to prove the loader
// boundary survives hostile non-Error throws.
throw {
  toString() {
    throw new Error("toString bomb");
  },
  get message() {
    throw new Error("message bomb");
  },
};
