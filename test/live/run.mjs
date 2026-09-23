import { spawn } from "node:child_process";
import { resolve } from "node:path";
if (process.env.FUSION_LIVE_TESTS !== "1") {
  process.stderr.write("Live tests require FUSION_LIVE_TESTS=1 and npm run test:live.\n");
  process.exitCode = 2;
} else {
  const provider = process.env.FUSION_LIVE_PROVIDER ?? "muse";
  if (!["muse", "claude"].includes(provider)) throw new Error("FUSION_LIVE_PROVIDER must be muse or claude.");
  const file = resolve(process.cwd(), `dist/test/live/${provider}.live.test.js`);
  const child = spawn(process.execPath, ["--test", file], { shell: false, stdio: "inherit", env: process.env });
  child.once("error", () => { process.exitCode = 2; });
  child.once("exit", code => { process.exitCode = code ?? 2; });
}
