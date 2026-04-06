import 'plotly.js'

// Augment plotly.js Legend type with fork-specific attributes
declare module 'plotly.js' {
    interface Legend {
        /** Gap (px) between legend items in x and y directions. Default: 5. */
        itemgap: number
        /** Gap (px) between legend symbol and item text. Default: itemgap * 2. */
        textgap: number
    }
}
