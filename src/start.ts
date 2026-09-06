import { main } from "./cli/start";

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
