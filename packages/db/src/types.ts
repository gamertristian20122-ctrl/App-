// The Db interface every driver implements. Repositories take a Db (or a transaction handle,
// which is also a Db) as their first argument.

export type Row = Record<string, unknown>

export type DbDriver = 'postgres' | 'pglite'

export interface Db {
  readonly driver: DbDriver
  /** Runs one statement with $1..$n parameters and returns every row. */
  query<T = Row>(sql: string, params?: readonly unknown[]): Promise<T[]>
  /** Like query, but returns the first row or null. */
  one<T = Row>(sql: string, params?: readonly unknown[]): Promise<T | null>
  /** Runs a script of one or more statements without parameters (migrations, setup). */
  exec(sql: string): Promise<void>
  /**
   * Runs fn in a transaction (a savepoint when already inside one). Commits when fn resolves,
   * rolls back when it throws. Inside fn, use only the handle passed to fn.
   */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>
  /** Closes the pool / database. Calling it on a transaction handle throws. */
  close(): Promise<void>
}
