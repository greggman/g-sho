// sql.js ships no types; this is the part we use (anki/apkg.ts has the
// matching SqlJs interface).
declare module 'sql.js' {
  interface Database {
    run(sql: string, params?: unknown[]): void;
    exec(sql: string): {columns: string[]; values: unknown[][]}[];
    export(): Uint8Array;
    close(): void;
  }
  interface SqlJsStatic {
    Database: new (data?: Uint8Array) => Database;
  }
  export default function initSqlJs(config?: {
    locateFile?: (file: string) => string;
  }): Promise<SqlJsStatic>;
}
