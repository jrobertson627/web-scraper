// Whether a raw store is the one a database's raw objects live in (#117).
//
// The database records the id of the raw store it was crawled with, and every
// recorded reference is resolved against whichever store the process is given. A
// worker on another machine, or pointed at an empty directory, would write bodies
// where the production worker never finds them (a cache hit or a 304 then stops
// the page), and reprocessing would skip what it cannot read. So a process that
// reads or writes raw objects checks first, and refuses on a mismatch.
//
// `claim` records the store's id when the database has none yet, which is what the
// first worker does. Reprocess, review and repair only check: a database that has
// never been crawled has no objects to disagree about.

export class RawStoreMismatchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RawStoreMismatchError';
    // The CLI's exit code name for a wrong configuration.
    this.exit = 'configurationRejected';
  }
}

export async function assertRawStoreMatchesDatabase({ persistence, rawStore, claim = false }) {
  if (typeof rawStore?.storeId !== 'function' || typeof persistence?.rawStoreId !== 'function') return null;
  const local = await rawStore.storeId();
  let recorded = await persistence.rawStoreId();
  if (recorded === null && claim) recorded = await persistence.claimRawStoreId(local);
  if (recorded !== null && recorded !== local) {
    throw new RawStoreMismatchError(
      'the raw store is not the one this database was crawled with. '
      + `The database records raw store ${recorded}, and the store at RAW_STORE_ROOT is ${local}. `
      + 'Point RAW_STORE_ROOT at the original store; a store copied to a new root keeps its identity with its .raw-store-id file. '
      + `If this is the same store restored without that file, write ${recorded} into RAW_STORE_ROOT/.raw-store-id`,
    );
  }
  return local;
}
