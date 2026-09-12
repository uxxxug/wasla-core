/**
 * The entry point, and nothing else.
 *
 * Separate from `cli.ts` so that importing the parser in a test cannot start a
 * replay, and so that the "am I the entry point" question is never asked: it
 * used to be answered from `process.argv[1]`, which the TypeScript runner
 * replaces with its own path, so the command ran nothing and exited 0. A file
 * whose only job is to run is not able to make that mistake.
 */
import { CliUsageError, main } from "./cli.js";

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(error instanceof CliUsageError ? error.exitCode : 1);
  });
