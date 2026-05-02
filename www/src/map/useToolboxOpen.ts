import useSessionStorageState from "use-session-storage-state"

/** Shared persisted "toolbox open" state for the map embed and the
 *  full-screen `/map` page. */
export function useToolboxOpen(defaultOpen: boolean) {
    return useSessionStorageState<boolean>("hccs.crashmap.toolboxOpen", { defaultValue: defaultOpen })
}
