import { Database as Db } from 'better-sqlite3'

export type Params = Record<string, any>

export function asyncQuery<T>(db: Db, query: string, params: Params): Promise<T[]> {
    return new Promise((resolve, reject) => {
        try {
            const result = db.prepare(query).all(params) as T[]
            resolve(result);
        } catch (err) {
            reject(err);
        }
    });
}
