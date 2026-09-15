const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const config = JSON.parse(fs.readFileSync(path.join(root, "docs/client-layout.json"), "utf8"));
const args = process.argv.slice(2);
if (args.some(arg => !["--check", "--write"].includes(arg)) || args.length > 1) {
  throw new Error("Usage: node scripts/sync-client-layout.cjs [--check|--write]");
}
const write = args[0] === "--write";

function files(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return files(full).map(file => path.join(entry.name, file));
    if (entry.isFile()) return [entry.name];
    throw new Error("Unsupported file type: " + full);
  }).sort();
}

const differences = [];
let count = 0;
for (const mapping of config.mirrors) {
  const source = path.join(root, mapping.source);
  const target = path.join(root, mapping.mirror);
  if (!fs.existsSync(source)) throw new Error("Missing source: " + mapping.source);
  const sourceFiles = files(source);
  const expected = new Set(sourceFiles);
  for (const file of sourceFiles) {
    const from = path.join(source, file);
    const to = path.join(target, file);
    const matches = fs.existsSync(to) && fs.readFileSync(from).equals(fs.readFileSync(to));
    if (!matches && write) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    } else if (!matches) {
      differences.push(path.relative(root, to));
    }
    count++;
  }
  for (const file of files(target)) {
    if (!expected.has(file)) differences.push("Unmapped mirror file (kept): " + path.join(mapping.mirror, file));
  }
}
if (differences.length) {
  console.error(differences.join("\n"));
  console.error("Client layout differs. Review the mappings and run with --write to copy source updates. No files are deleted.");
  process.exitCode = 1;
} else {
  console.log("Client layout " + (write ? "synchronized" : "verified") + ": " + count + " files.");
}
