import MuiTooltip, { TooltipProps } from "@mui/material/Tooltip";

export function Tooltip(
    {
        enterTouchDelay = 0,
        leaveTouchDelay = 3000,
        enterNextDelay = 0,
        offset = 14,
        arrow = true,
        ...props
    }: TooltipProps & { offset?: number }
) {
    return <MuiTooltip
        arrow={arrow}
        slotProps={{
            popper: {
                modifiers: [
                    {
                        name: 'offset',
                        options: {
                            offset: [0, -offset],
                        },
                    },
                ],
            },
        }}
        enterTouchDelay={enterTouchDelay}
        leaveTouchDelay={leaveTouchDelay}
        enterNextDelay={enterNextDelay}
        {...props}
    />
}
