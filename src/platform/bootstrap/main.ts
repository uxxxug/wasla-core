/**
 * The entry point, and nothing else.
 *
 * Same shape as `replay/main.ts`, and for the same reason: importing the parser
 * in a test must not provision a credential, and the "am I the entry point"
 * question is never asked because a file whose only job is to run cannot get it
 * wrong.
 */
import { CliUsageError, main } from "./cli.js";

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(error instanceof CliUsageError ? error.exitCode : 1);
  });
