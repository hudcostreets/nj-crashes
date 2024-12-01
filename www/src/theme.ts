import { Roboto } from 'next/font/google'
import { createTheme } from '@mui/material/styles'
import { red } from '@mui/material/colors'

export const roboto = Roboto({
  weight: ['300', '400', '500', '700'],
  subsets: ['latin'],
  display: 'swap',
})

// Create a theme instance.
const theme = createTheme({
  cssVariables: true,
  palette: {
    primary: {
      main: '#556cd6',
    },
    secondary: {
      main: '#19857b',
    },
    error: {
      main: red.A400,
    },
  },
  typography: {
    fontFamily: roboto.style.fontFamily,
  },
  components: {
    MuiTooltip: {
      defaultProps: {
        arrow: true,
        enterTouchDelay: 0,
        // enterTouchDelay: 100
        leaveTouchDelay: 3000,
        enterNextDelay: 0,
        slotProps: {
          popper: {
            modifiers: [
              {
                name: 'offset',
                options: {
                  offset: [0, -6], // your default offset
                },
              },
            ],
          },
        }
      },
      styleOverrides: {
        tooltip: {
          fontSize: '0.9em',  // less small than the default
          fontWeight: 'normal',
          textAlign: 'center',
          padding: "0.7em",
          backgroundColor: 'rgba(97, 97, 97, 1)',
        }
      }
    }
  }
})

export default theme
