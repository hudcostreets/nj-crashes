
export type Unit = 's' | 'm' | 'h'
export type ScaledTime = {
    start: number,
    unit: Unit
}

export type Encoded = {
    rows: any[][],
    cols: string[],
    dicts: { [col: string]: any[] | ScaledTime },
}

export function decode<T>(obj: Encoded): T[] {
  const { rows, cols, dicts } = obj
  return rows.map(row => {
    const obj: any = {}
    row.forEach((val, colIdx) => {
      const col = cols[colIdx]
      if (col in dicts) {
        const dict = dicts[col]
        if (dict instanceof Array) {
          obj[col] = dict[val]
          // return dict[val]
        } else {
          const { start, unit } = dict
          const time = start + val
          obj[col] = new Date(time * (unit === 's' ? 1000 : unit === 'm' ? 60000 : 3600000))
        }
      } else {
        obj[col] = val
      }
    })
    return obj as T
  })
}
