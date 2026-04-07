import { useTheme } from 'pltly'

export type PlotColors = {
  plotBg: string
  paperBg: string
  gridColor: string
  textColor: string
  legendBg: string
}

export function usePlotColors(): PlotColors {
  const { theme } = useTheme()
  return {
    plotBg: 'transparent',
    paperBg: 'transparent',
    gridColor: theme.grid,
    textColor: theme.font,
    legendBg: theme.annBg,
  }
}
