// Types for `surface.mjs`, so the project's TypeScript tests can import it under `tsc --noEmit` (`allowJs` is
// false) — the same reason as `config.d.mts` beside it.

export type SurfaceKind =
  | 'head'
  | 'answer'
  | 'summary'
  | 'tiles'
  | 'toolbar'
  | 'list'
  | 'empty'
  | 'card'
  | 'steps'
  | 'field'
  | 'tabs'
  | 'note'

export type SurfaceFact = 'action' | 'count' | 'columns'

export type SurfaceBlock = {
  kind: SurfaceKind
  /** The words that matter, as written. `null` when the line has none. */
  words: string | null
  /** The FILE line number of the block's line. */
  line: number
  action?: string
  count?: number
  /** Trimmed, as written; a trailing bar is an unlabelled column (`""`). */
  columns?: string[]
}

export type Surface = {
  state: string
  route: string
  /** The FILE line number where the block's body starts. */
  line: number
  blocks: SurfaceBlock[]
}

export const SURFACE_KINDS: Readonly<Record<SurfaceKind, readonly SurfaceFact[]>>
export const SURFACE_FACTS: readonly SurfaceFact[]

export class SurfaceError extends Error {
  file: string
  line: number
  reason: string
  constructor(file: string, line: number, reason: string)
}

export function parseSurface(text: string, file?: string, firstLine?: number): Surface
export function parseSurfaces(markdown: string, file?: string): Surface[]
export function validateMap(map: unknown): string[]
