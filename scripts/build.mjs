/**
 * Build the two entrypoints into self-contained executables.
 * Usage:
 *   bun run scripts/build.mjs          # build both (default)
 *   bun run scripts/build.mjs check    # build only fup-check
 *   bun run scripts/build.mjs reset    # build only fup-reset
 *
 * Output: dist/fup-check, dist/fup-reset — single-file binaries that
 * include `bun` runtime + bundled JS + node_modules deps. No node_modules
 * needed on a target server; the binary only needs the external `radclient`
 * executable and a reachable MySQL/MikroTik from the machine it runs on.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "dist");
mkdirSync(outDir, { recursive: true });

const targets = {
  check: { entry: "src/bin/fup-check.ts", out: resolve(outDir, "fup-check") },
  reset: { entry: "src/bin/fup-reset.ts", out: resolve(outDir, "fup-reset") },
};

const wanted = process.argv.slice(2);
const names = wanted.length === 0 ? Object.keys(targets) : wanted;

for (const name of names) {
  const { entry, out } = targets[name];
  if (!entry) {
    console.error(`Unknown target "${name}". Known: ${Object.keys(targets).join(", ")}`);
    process.exit(1);
  }
  console.log(`building ${name} -> ${out}`);
  const res = spawnSync(
    "bun",
    ["build", "--compile", "--minify", "--sourcemap", entry, "--outfile", out],
    { stdio: "inherit", cwd: root },
  );
  if (res.status !== 0) process.exit(res.status ?? 1);
}
console.log("build complete. binaries in dist/");
