// cache layer
const store = new Map();

export function get(k) {
  return store.get(k);
}

export function put(k, v) {
  store.set(k, v);
}
