const fs = require("node:fs");
const vm = require("node:vm");

const wrapperPath = process.argv[2] || "plugins/purge-tools/index.js";
const base122Path = process.argv[3] || "/tmp/purge-tools-base122.js";
const base121Path = process.argv[4] || "/tmp/purge-tools-base121.js";
const base120Path = process.argv[5] || "/tmp/purge-tools-base120.js";
const base117Path = process.argv[6] || "/tmp/purge-tools-base117.js";
const stableCorePath = process.argv[7] || "/tmp/purge-tools-stable-core.js";

const read = p => fs.readFileSync(p, "utf8");
const context = {
  vendetta: { metro: { common: {} }, patcher: {}, plugin: { storage: {} } },
  console,
};

function expose(source, fnName, label) {
  const re = /(\n\s*return\s*\{\s*\n\s*)(onLoad\s*\(\s*\)\s*\{)/g;
  const matches = [...source.matchAll(re)];
  if (matches.length !== 1) throw new Error(`Could not instrument ${label}; candidates=${matches.length}`);
  const match = matches[0];
  const i = match.index;
  const replacement = `${match[1]}__debugPatch: ${fnName},\n    ${match[2]}`;
  const instrumented = source.slice(0, i) + replacement + source.slice(i + match[0].length);
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

function fixFriendlyBridgeEscaping(source) {
  const before = '  }\\\\n\\\\n  function portSource(source) {';
  const after = '  }\\n\\n  function portSource(source) {';
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Expected exactly one friendly bridge escape defect; first=${first}`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

const outer = read(wrapperPath);
parse(outer, "stage0-current-wrapper");

const patch126 = expose(outer, "patch", "stage0-current-wrapper");
const stage1 = patch126(read(base122Path));
fs.writeFileSync("/tmp/purge-tools-stage1.js", stage1);
parse(stage1, "stage1-v122-wrapper-after-v126");

const patch122 = expose(stage1, "patch", "stage1-v122-wrapper-after-v126");
const stage2 = patch122(read(base121Path));
fs.writeFileSync("/tmp/purge-tools-stage2.js", stage2);
parse(stage2, "stage2-v121-wrapper-after-v122");

const patch121 = expose(stage2, "patch", "stage2-v121-wrapper-after-v122");
let stage3 = patch121(read(base120Path));
fs.writeFileSync("/tmp/purge-tools-stage3-before-fix.js", stage3);
parse(stage3, "stage3-v120-wrapper-after-v121-before-fix");
stage3 = fixFriendlyBridgeEscaping(stage3);
fs.writeFileSync("/tmp/purge-tools-stage3.js", stage3);
parse(stage3, "stage3-v120-wrapper-after-v121-fixed");

const patch120 = expose(stage3, "patchBaseSource", "stage3-v120-wrapper-after-v121-fixed");
const stage4 = patch120(read(base117Path));
fs.writeFileSync("/tmp/purge-tools-stage4.js", stage4);
parse(stage4, "stage4-v117-wrapper-after-v120");

const port117 = expose(stage4, "portSource", "stage4-v117-wrapper-after-v120");
let stage5 = port117(read(stableCorePath));
stage5 = stage5.replace('const PLUGIN_VERSION = "1.2.6-shiggy";', 'const PLUGIN_VERSION = "1.2.7-shiggy";');
if (!stage5.includes('const PLUGIN_VERSION = "1.2.7-shiggy";')) throw new Error("Could not stamp v1.2.7 final version");
fs.writeFileSync("/tmp/purge-tools-v127-flat.js", stage5);
parse(stage5, "stage5-v127-flat-final");

console.log("Purge Tools complete chain + flattened v1.2.7 PASS");
