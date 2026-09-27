/** `use-kbd`'s `useAction` / `useActions`, with each handler invocation
 *  recorded in the feedback action log (`feedback/actionLog.ts`). Hotkeys
 *  call handlers directly (bypassing the omnibar's `executeAction`), so
 *  wrapping handlers is the one place that sees both paths. Import these
 *  instead of the `use-kbd` originals. */
import { useAction as useKbdAction, useActions as useKbdActions, type ActionConfig } from "use-kbd"
import { logAction } from "@/src/feedback/actionLog"

type Handler = ActionConfig["handler"]

function logged(id: string, config: ActionConfig): Handler {
    const { handler, label } = config
    return (...args: Parameters<Handler>) => {
        logAction("action", label && label !== id ? `${id} (${label})` : id)
        return handler(...args)
    }
}

export function useAction(id: string, config: ActionConfig): void {
    useKbdAction(id, { ...config, handler: logged(id, config) })
}

export function useActions(actions: Record<string, ActionConfig>): void {
    useKbdActions(Object.fromEntries(
        Object.entries(actions).map(([id, config]) => [id, { ...config, handler: logged(id, config) }]),
    ))
}
