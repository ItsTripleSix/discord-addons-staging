const fs = require("node:fs");
const vm = require("node:vm");

const wrapperPath = process.argv[2] || "plugins/purge-tools/index.js";
const base122Path = process.argv[3] || "/tmp/purge-tools-base122.js";
const base121Path = process.argv[4] || "/tmp/purge-tools-base121.js";
const base120Path = process.argv[5] || "/tmp/purge-tools-base120.js";
const base117Path = process.argv[6] || "/tmp/purge-tools-base117.js";

const read = p => fs.readFileSync(p, "utf8");
const context = {
  vendetta: { metro: { common: {} }, patcher: {}, plugin: { storage: {} } },
  console,
};

function expose(source, fnName, label) {
  const marker = "  return {\n    onLoad() {";
  const first = source.indexOf(marker);
  if (first < 0 || source.indexOf(marker, first + marker.length) >= 0) {
    throw new Error(`Could not instrument ${label}`);
  }
  const instrumented = source.slice(0, first)
    + `  return {\n    __debugPatch: ${fnName},\n    onLoad() {`
    + source.slice(first + marker.length);
  const plugin = vm.runInNewContext(instrumented, context, { filename: `${label}-instrumented.js` });
  if (typeof plugin?.__debugPatch !== "function") throw new Error(`${label} patch function was not exposed`);
  return plugin.__debugPatch;
}

function parse(source, label) {
  const wrapped = `vendetta=>{return ${source}}\n//# sourceURL=${label}.js`;
  try {
    new vm.Script(wrapped, { filename: `${label}-wrapper.js` });
  } catch (error) {
    console.error(`\n${label} parse FAILED`);
    console.error(error?.stack || error);
    const text = String(error?.stack || error);
    const match = text.match(new RegExp(`${label}-wrapper\\.js:(\\d+)(?::(\\d+))?`));
    if (match) {
      const line = Number(match[1]);
      const lines = wrapped.split("\n");
      const lo = Math.max(1, line - 10), hi = Math.min(lines.length, line + 10);
      console.error(`\n${label} around line ${line}:`);
      for (let n = lo; n <= hi; n++) console.error(`${String(n).padStart(5)} | ${lines[n - 1]}`);
    }
    process.exit(1);
  }
  console.log(`${label} syntax PASS (${source.length} bytes)`);
}

function reportUnicode(source, label) {
  const re = /\\+u[^\s'"`;,)}\]]*/g;
  const hits = [];
  let match;
  while ((match = re.exec(source)) && hits.length < 50) {
    const before = source.slice(Math.max(0, match.index - 50), match.index);
    const after = source.slice(match.index, Math.min(source.length, match.index + 90));
    hits.push((before + after).replace(/\n/g, "\\n"));
  }
  if (hits.length) {
    console.log(`\n${label}: ${hits.length} backslash-u candidates`);
    hits.forEach((hit, i) => console.log(`${i + 1}: ${hit}`));
  }
}

const outer = read(wrapperPath);
parse(outer, "stage0-current-wrapper");

const patch126 = expose(outer, "patch", "stage0-current-wrapper");
const stage1 = patch126(read(base122Path));
fs.writeFileSync("/tmp/purge-tools-stage1.js", stage1);
parse(stage1, "stage1-v122-wrapper-after-v126");
reportUnicode(stage1, "stage1");

const patch122 = expose(stage1, "patch", "stage1-v122-wrapper-after-v126");
const stage2 = patch122(read(base121Path));
fs.writeFileSync("/tmp/purge-tools-stage2.js", stage2);
parse(stage2, "stage2-v121-wrapper-after-v122");
reportUnicode(stage2, "stage2");

const patch121 = expose(stage2, "patch", "stage2-v121-wrapper-after-v122");
const stage3 = patch121(read(base120Path));
fs.writeFileSync("/tmp/purge-tools-stage3.js", stage3);
parse(stage3, "stage3-v120-wrapper-after-v121");
reportUnicode(stage3, "stage3");

const patch120 = expose(stage3, "patchBaseSource", "stage3-v120-wrapper-after-v121");
const stage4 = patch120(read(base117Path));
fs.writeFileSync("/tmp/purge-tools-stage4.js", stage4);
parse(stage4, "stage4-v117-wrapper-after-v120");
reportUnicode(stage4, "stage4");

console.log("Purge Tools full generated-source chain PASS");
