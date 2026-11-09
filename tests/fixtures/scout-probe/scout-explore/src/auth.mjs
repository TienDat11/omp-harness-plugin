// auth helpers
export function token(user) {
  return "t-" + user;
}

export function verify(t) {
  return t.startsWith("t-");
}
