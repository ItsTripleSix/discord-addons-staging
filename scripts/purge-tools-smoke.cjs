const fs = require("node:fs");
const vm = require("node:vm");

const wrapperPath = process.argv[2] || "plugins/purge-tools/index.js";
const basePath = process.argv[3] || "/tmp/purge-tools-base122.js";
const wrapper = fs.readFileSync(wrapperPath, "utf8");
const base = fs.readFileSync(basePath, "utf8");

const marker = "  return {\n    onLoad() {";
const first = wrapper.indexOf(marker);
if (first < 0 || wrapper.indexOf(marker, first + marker.length) >= 0) {
  throw new Error("Could not instrument Purge Tools wrapper");
}
const instrumented = wrapper.slice(0, first)
  + "  return {\n    __debugPatch: patch,\n    onLoad() {"
  + wrapper.slice(first + marker.length);

const context = {
  vendetta: { metro: { common: {} }, patcher: {}, plugin: { storage: {} } },
  console,
};
const plugin = vm.runInNewContext(instrumented, context, { filename: "purge-tools-outer.js" });
if (typeof plugin?.__debugPatch !== "function") throw new Error("Patch function was not exposed");

const generated = plugin.__debugPatch(base);
fs.writeFileSync("/tmp/purge-tools-generated.js", generated);

try {
  new vm.Script(`vendetta=>{return ${generated}}\n//# sourceURL=purge-tools-generated.js`, { filename: "purge-tools-generated-wrapper.js" });
} catch (error) {
  console.error(error?.stack || error);
  const text = String(error?.stack || error);
  const match = text.match(/purge-tools-generated-wrapper\.js:(\d+)(?::(\d+))?/);
  if (match) {
    const line = Number(match[1]);
    const lines = (`vendetta=>{return ${generated}}`).split("\n");
    const lo = Math.max(1, line - 8), hi = Math.min(lines.length, line + 8);
    console.error(`\nGenerated source around line ${line}:`);
    for (let n = lo; n <= hi; n++) console.error(`${String(n).padStart(5)} | ${lines[n - 1]}`);
  }
  process.exit(1);
}

console.log(`Purge Tools generated-source syntax PASS (${generated.length} bytes)`);
