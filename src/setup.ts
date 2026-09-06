import { main } from "./cli/setup";
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
