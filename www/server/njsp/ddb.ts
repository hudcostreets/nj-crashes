import { CrashDDB } from "@/server/ddb";
import { NjspCrashesPqt } from "@/server/paths";
import { Crash } from "@/src/njsp/crash";

export const spCrashesDdb = new CrashDDB<Crash>(NjspCrashesPqt)
