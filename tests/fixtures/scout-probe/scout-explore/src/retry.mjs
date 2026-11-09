// retry policy
export const MAX_TRIES = 3;

export function backoff(n) {
  return 100 * 2 ** n;
}

// total wait the caller may spend before giving up
export function retryBudget(tries) {
  let total = 0;
  for (let i = 0; i < tries; i++) total += backoff(i);
  return total;
}
