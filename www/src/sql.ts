import * as sql from '@rdub/react-sql.js-httpvfs/query'

export const DefaultMaxBytesToRead = 20 * 1024 * 1024

export function useSqlQuery<T = any>({ maxBytesToRead = DefaultMaxBytesToRead, ...props }: sql.Query) {
    return sql.useSqlQuery({ maxBytesToRead, ...props })
}
