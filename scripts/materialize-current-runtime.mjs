import { materializeRuntimeNodeModules } from "./materialize-runtime-node-modules.mjs";
await materializeRuntimeNodeModules(process.argv[2] ?? ".runtime/dsh");
console.log("materialized");
