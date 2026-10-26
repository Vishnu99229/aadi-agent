/** Test seams swap the real Telegram, Gmail and LLM clients for fakes. They
 *  only work against the in-memory test database, so production can never
 *  install one. */
export function assertTestSeam(name: string): void {
  if (process.env.AADI_DB_PATH !== ":memory:") {
    throw new Error(`${name} is only available in tests (AADI_DB_PATH=:memory:).`);
  }
}
