import { Either } from "fp-ts/Either"

export type Result<T> = Either<Error, T> | null

