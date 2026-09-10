// Reproduce the research with its own pinned dependencies and copied source, never personal config.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = mkdtempSync(join(tmpdir(), "wayfinder-cli-research-"));
const source = fileURLToPath(new URL("../../src", import.meta.url));
const research = fileURLToPath(new URL(".", import.meta.url));
async function command(argv: string[]) {
  const child = Bun.spawn(argv, { cwd: directory, stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error("Research command failed");
}
try {
  cpSync(source, join(directory, "src"), { recursive: true });
  cpSync(research, join(directory, "research", "cli-libraries"), { recursive: true });
  writeFileSync(join(directory, "package.json"), readFileSync(join(research, "dependencies.json")));
  writeFileSync(join(directory, "bun.lock"), readFileSync(join(research, "dependencies.lock")));
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2024",
        module: "Preserve",
        moduleResolution: "bundler",
        types: ["bun"],
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        verbatimModuleSyntax: true,
        skipLibCheck: true,
      },
      include: ["research/**/*.ts", "src/assets.d.ts"],
    }),
  );
  console.log(
    `CLI library research: Bun ${Bun.version}; temporary dependencies, source and stores.`,
  );
  await command([process.execPath, "install", "--frozen-lockfile"]);
  await command([process.execPath, "run", "tsc", "--noEmit"]);
  const entry = "research/cli-libraries/probe.ts";
  await command([process.execPath, "run", entry]);
  const executable = join(directory, process.platform === "win32" ? "probe.exe" : "probe");
  await command([process.execPath, "build", entry, "--compile", "--outfile", executable]);
  await command([executable]);
  console.log("PASS source execution, strict typecheck, standalone build and compiled execution.");
} finally {
  rmSync(directory, { recursive: true, force: true });
  console.log("Temporary research dependencies, copied source, executable and stores removed.");
}
