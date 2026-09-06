import { main } from "./cli/launcher";

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
