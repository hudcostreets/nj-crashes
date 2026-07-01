import { titleCase } from "@rdub/base/str"

export type MC2MN = { [mc: number]: string }
export type County = { cn: string, mc2mn: MC2MN }
export type CC2MC2MN = { [cc: number]: County }

export const normalize = (s: string) => s.toLowerCase().replaceAll(' ', '-')

export const denormalize = (s: string) => titleCase(s.replaceAll('-', ' '))

/** Canonical key for matching a municipality name across data sources.
 *
 *  NJDOT abbreviates municipality suffixes ("Hopewell Boro", "Hopewell
 *  Twp") while the map/GIS data (`muni-maps.json`, muni GeoJSON) spells
 *  them out ("Hopewell Borough", "Hopewell Township"). The two disagree
 *  for the same town, so the exact-string reverse lookups that turn a URL
 *  slug back into an `mc` silently fail — e.g. picking "Hopewell Borough"
 *  never resolves its code and the map won't focus. Pennington only works
 *  because it happens to be spelled identically in both sources.
 *
 *  Fold both spellings to one key by *expanding* the abbreviations
 *  (Boro→Borough, Twp→Township), never stripping the suffix — stripping
 *  would collapse "Hopewell Borough" and "Hopewell Township" onto the same
 *  key and collide two distinct municipalities. Lowercased and
 *  whitespace-collapsed so it's safe to key on either the abbreviated or
 *  the full form. */
export const muniKey = (s: string): string =>
    s.toLowerCase()
        .replace(/\btwp\.?(?=\s|$)/g, 'township')
        .replace(/\bboro\.?(?=\s|$)/g, 'borough')
        .replace(/\s+/g, ' ')
        .trim()
