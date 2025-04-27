import * as duckdb from '@duckdb/duckdb-wasm';

// Import wasm files
import duckdb_wasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvp_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import duckdb_wasm_eh from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import eh_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';

const isServer = typeof window === 'undefined';

// --- DuckDB Setup ---
const MANUAL_BUNDLES: duckdb.DuckDBBundles = {
    mvp: { mainModule: duckdb_wasm, mainWorker: mvp_worker },
    eh: { mainModule: duckdb_wasm_eh, mainWorker: eh_worker },
};

/**
 * Initializes the DuckDB instance and connection.
 * @returns A promise resolving to an object containing the db instance and connection, or nulls if on server.
 */
export const initializeDb = async (): Promise<{ db: duckdb.AsyncDuckDB | null; connection: duckdb.AsyncDuckDBConnection | null }> => {
    if (isServer) return { db: null, connection: null }; // Don't initialize on server

    console.log("Initializing DuckDB...");
    try {
        const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
        const worker = new Worker(bundle.mainWorker!);
        const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
        const db = new duckdb.AsyncDuckDB(logger, worker);
        await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
        await db.open({ query: { castTimestampToDate: true } }); // Enable automatic casting
        const connection = await db.connect();
        console.log("DuckDB Initialized.");
        return { db, connection };
    } catch (error: any) {
        console.error("DuckDB Initialization Failed:", error);
        throw error; // Re-throw the error to be handled by the caller
    }
};

/**
 * Cleans up the DuckDB instance and connection.
 * @param db The DuckDB instance.
 * @param connection The DuckDB connection.
 */
export const cleanupDb = async (db: duckdb.AsyncDuckDB | null, connection: duckdb.AsyncDuckDBConnection | null): Promise<void> => {
    console.log("Cleaning up DuckDB...");
    try {
        if (connection) {
            await connection.close();
        }
    } catch (e) {
        console.error("Error closing connection:", e);
    }
    try {
        if (db) {
            await db.terminate();
        }
    } catch (e) {
        console.error("Error terminating DB:", e);
    }
    console.log("DuckDB cleanup finished.");
};