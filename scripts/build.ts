import { chmod, mkdir } from "node:fs/promises";

await mkdir("dist", { recursive: true });

const result = await Bun.build({
  entrypoints: ["src/cli.tsx"],
  outdir: "dist",
  naming: "agentq",
  target: "bun",
  packages: "external",
  minify: false,
  sourcemap: "linked",
  define: {
    AGENTQ_VERSION: JSON.stringify(process.env.npm_package_version ?? "0.1.0"),
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

await chmod("dist/agentq", 0o755);
