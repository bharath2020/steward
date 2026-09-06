import { main } from "./cli/answer";

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
