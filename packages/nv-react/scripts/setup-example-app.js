import { execSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const exampleRoot = join(repoRoot, "example-app");
const packageJsonPath = join(repoRoot, "package.json");
const examplePackageJsonPath = join(exampleRoot, "package.json");

const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const version = pkg.version;
const tarballName = `nv-react-${version}.tgz`;

execSync("bun run build:package && npm pack", {
  cwd: repoRoot,
  stdio: "inherit",
});

const tarballPath = join(repoRoot, tarballName);
if (!existsSync(tarballPath)) {
  const maybeTarball = readdirSync(repoRoot).find(
    (name) => name.startsWith("nv-react-") && name.endsWith(".tgz"),
  );
  if (!maybeTarball) {
    throw new Error("npm pack did not produce a tarball");
  }
  copyFileSync(join(repoRoot, maybeTarball), tarballPath);
}

const examplePkg = JSON.parse(readFileSync(examplePackageJsonPath, "utf8"));
examplePkg.dependencies = examplePkg.dependencies ?? {};
examplePkg.dependencies["nv-react"] = `file:../${tarballName}`;
writeFileSync(
  examplePackageJsonPath,
  `${JSON.stringify(examplePkg, null, 2)}\n`,
);

console.log(`Updated example-app to use ${tarballName}`);
