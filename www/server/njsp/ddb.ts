import { CrashDDB as CrashDDB0 } from "@/server/ddb";
import { Crash } from "@/src/njsp/crash";
import { urls } from "@/src/urls";

export class CrashDDB extends CrashDDB0<Crash> {}

export const spDdb = new CrashDDB(urls.njsp.crashes)
