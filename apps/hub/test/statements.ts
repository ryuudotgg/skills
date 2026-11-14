import { Database, type SQLQueryBindings } from "bun:sqlite";
import { spyOn } from "bun:test";

export type Recording = {
  readonly sql: string[];
  readonly rows: unknown[];
  readonly stop: () => void;
};

export function recordStatements(): Recording {
  const sql: string[] = [];
  const rows: unknown[] = [];
  const { query, prepare } = Database.prototype;

  const counted = <S extends object>(statement: S): S =>
    new Proxy(statement, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;

        const method: (...params: unknown[]) => unknown = value.bind(target);

        if (key === "get")
          return (...params: unknown[]) => {
            const read = method(...params);
            if (read !== null) rows.push(read);
            return read;
          };

        if (key === "all")
          return (...params: unknown[]) => {
            const read = method(...params) as unknown[];
            rows.push(...read);
            return read;
          };

        if (key === "iterate")
          return function* (...params: unknown[]) {
            for (const row of method(...params) as Iterable<unknown>) {
              rows.push(row);
              yield row;
            }
          };

        return method;
      },
    });

  type Bindings = SQLQueryBindings | SQLQueryBindings[];

  const spies = [
    spyOn(Database.prototype, "query").mockImplementation(function <R, P extends Bindings>(
      this: Database,
      text: string,
    ) {
      sql.push(text);
      return counted(query.call(this, text) as ReturnType<typeof query<R, P>>);
    }),
    spyOn(Database.prototype, "prepare").mockImplementation(function <R, P extends Bindings>(
      this: Database,
      text: string,
      params?: P,
    ) {
      sql.push(text);
      return counted(prepare.call(this, text, params) as ReturnType<typeof prepare<R, P>>);
    }),
  ];

  return {
    sql,
    rows,
    stop: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}
