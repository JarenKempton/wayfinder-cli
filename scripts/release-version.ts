const tag = process.argv[2];
const match =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)$/.exec(tag ?? "");

if (!match) {
  throw new Error(
    "release tag must be a strict SemVer prerelease such as v0.1.0-rc.1 (no build metadata)",
  );
}

for (const identifier of (match[4] ?? "").split(".")) {
  if (/^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0")) {
    throw new Error(`numeric prerelease identifier has a leading zero: ${identifier}`);
  }
}

process.stdout.write(`${tag?.slice(1)}\n`);
