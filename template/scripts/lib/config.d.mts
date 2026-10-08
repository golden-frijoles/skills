// Types for lib/config.mjs, the one config core (golden-frijoles-plugin D10). Shipped in @golden-frijoles/kit as
// `@golden-frijoles/kit/config` so the TypeScript `frijoles` CLI imports the same rules instead of re-implementing them.

export declare const CONFIG_FILENAME: 'golden-frijoles.config.json';
export declare const SECTIONS: readonly string[];
export declare const LEGACY: Readonly<Record<string, string>>;
export declare const NEEDS_SETTING: 'GF-NEEDS-SETTING';
export declare const EXIT_NEEDS_SETTING: 7;

export declare class ConfigError extends Error {}

export interface IoOptions {
  root?: string;
  read?: (path: string, encoding: 'utf8') => string;
  exists?: (path: string) => boolean;
}

export interface Section {
  raw: Record<string, unknown> | null;
  /** True when either file has the section, even when its value is `null` in the legacy file. */
  present: boolean;
  sources: string[];
  duplicates: string[];
}

/** The project root: GF_PROJECT_ROOT, else (installed) the nearest ancestor of `cwd` with Roadmap/ or .git, else `cwd`. */
export declare function projectRoot(opts?: { env?: Record<string, string | undefined>; cwd?: string }): string;
export declare function readConfigFile(opts?: IoOptions): Record<string, unknown> | null;
export declare function readSection(
  name: string,
  opts?: IoOptions & {
    legacyPath?: string;
    onLegacyError?: (path: string, error: Error) => never;
    legacyRead?: IoOptions['read'];
    legacyExists?: IoOptions['exists'];
  }
): Section;
export declare function loadConfig(opts?: IoOptions): {
  sections: Record<string, Record<string, unknown>>;
  sources: Record<string, string[]>;
  duplicates: string[];
  /** Top-level keys of golden-frijoles.config.json that are not a known section (ignored on read). */
  unknown: string[];
};
export declare function getKey(key: string, opts?: IoOptions): unknown;
export declare function setKey(
  key: string,
  value: unknown,
  opts?: IoOptions & { write?: (path: string, obj: unknown) => void }
): Record<string, unknown>;
export declare function migrate(
  opts?: IoOptions & { write?: (path: string, obj: unknown) => void; dryRun?: boolean }
): { config: Record<string, unknown>; folded: string[]; skipped: string[] };
/** What `loadConfig`/`getKey` print in place of a secret-looking value. */
export declare const REDACTED: string;
export declare function redactSecrets<T>(key: string, value: T): T;
export declare function looksLikeSecret(key: string, value: unknown): boolean;
export declare function needsSettingLine(entry: { key: string; question: string; default: unknown }): string;
export declare function needSetting(
  key: string,
  opts?: IoOptions & { blocking?: boolean; write?: (s: string) => void; exit?: (code: number) => void }
): unknown;

export interface RegistryEntry {
  key: string;
  module: 'Plan' | 'Build' | 'Ship' | 'Measure' | 'Spend' | 'Operate';
  askWhen: string;
  default: unknown;
  question: string;
  required?: boolean;
  choices?: readonly unknown[];
  store?: 'env';
}

export declare const REGISTRY: readonly RegistryEntry[];
export declare const MODULES: readonly ['Plan', 'Build', 'Ship', 'Measure', 'Spend', 'Operate'];
