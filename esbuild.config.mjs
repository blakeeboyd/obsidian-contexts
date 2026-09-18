import esbuild from "esbuild";
import process from "process";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
});

/**
 * Copy the built plugin into a vault, if EPISODIC_VAULT names one.
 * Opt-in by env var rather than a hardcoded path, so a clone on another
 * machine builds without needing this vault to exist. (Same pattern as
 * Foliate; a stale vault copy is invisible from inside Obsidian.)
 */
async function deploy() {
  const vault = process.env.EPISODIC_VAULT;
  if (!vault) return;
  const dest = `${vault}/.obsidian/plugins/episodic`;
  const { copyFile, mkdir } = await import("node:fs/promises");
  await mkdir(dest, { recursive: true });
  // data.json is user settings, and log/ is the irreplaceable record: never copied over.
  for (const f of ["main.js", "styles.css", "manifest.json"]) {
    await copyFile(f, `${dest}/${f}`);
  }
  console.log(`deployed to ${dest}`);
}

if (prod) {
  await context.rebuild();
  await deploy();
  process.exit(0);
} else {
  await context.watch();
  await deploy();
}
