import "./bun-runtime.mjs";

const tsxImport = import.meta.resolve("tsx");
const compatibilityImport = new URL("./bun-runtime.mjs", import.meta.url).href;
const requiredOptions = [`--import=${tsxImport}`, `--import=${compatibilityImport}`];
const currentOptions = process.env.NODE_OPTIONS?.trim() ?? "";

process.env.NODE_OPTIONS = [currentOptions, ...requiredOptions]
  .filter(Boolean)
  .filter((value, index, values) => values.indexOf(value) === index)
  .join(" ");
