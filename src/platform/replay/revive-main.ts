/**
 * The entry point, and nothing else.
 *
 * Separate from `revive-cli.ts` so that importing the parser in a test cannot
 * start a revival, mirroring `main.ts`. A file whose only job is to run cannot
 * make the mistake the replay entry point made once: guarding on
 * `process.argv[1]`, which the TypeScript runner replaces with its own path, so
 * the command ran nothing and exited 0.
 */
import { CliUsageError } from "./cli.js";
import { main } from "./revive-cli.js";

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(error instanceof CliUsageError ? error.exitCode : 1);
  });
