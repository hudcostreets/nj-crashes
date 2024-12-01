import { createTheme } from '@mui/material/styles'
import { defaultProps, styleOverrides } from "@rdub/icons/Tooltip"

const theme = createTheme({
  components: {
    MuiTooltip: {
      defaultProps: {
        ...defaultProps,
        arrow: true,
        leaveTouchDelay: 3000,
        enterNextDelay: 0,
      },
      styleOverrides,
    }
  }
})

export default theme
