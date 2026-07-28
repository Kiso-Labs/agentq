import { chmod, mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("dist", { recursive: true });

await build({
  entryPoints: ["src/cli.tsx"],
  outfile: "dist/agentq",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24.15",
  packages: "external",
  minify: false,
  sourcemap: "linked",
  define: {
    AGENTQ_VERSION: JSON.stringify(process.env.npm_package_version ?? "0.1.0"),
  },
});

await chmod("dist/agentq", 0o755);
