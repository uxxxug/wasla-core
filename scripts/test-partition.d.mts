/**
 * Types for `test-partition.mjs`.
 *
 * The module itself is plain ESM because `scripts/` runs under bare node with no
 * build step, and the gate that reads it has to work before anything is
 * compiled. Declaring its shape here rather than letting it be `any` is the
 * point: `tests/test-partition.test.ts` asserts things about this partition, and
 * an assertion against `any` would still compile after the module's shape
 * changed underneath it.
 */

export declare const TESTS_DIRECTORY: string;
export declare const CLUSTER_FILE_PATTERN: RegExp;
export declare const PASS_ENVIRONMENT_VARIABLE: string;
export declare const PASSES: readonly ["suite", "cluster"];

export declare const allTestFiles: (root?: string) => string[];
export declare const isClusterFile: (path: string) => boolean;
export declare const clusterFiles: (root?: string) => string[];
export declare const suiteFiles: (root?: string) => string[];
export declare const requestedPass: (
  environment?: Record<string, string | undefined>,
) => "suite" | "cluster";
