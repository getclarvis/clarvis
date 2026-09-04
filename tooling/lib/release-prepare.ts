const RELEASE_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface ReleasePreparationSources {
  packageJson: string;
  installSh: string;
  installPowerShell: string;
  changelog: string;
}

export interface PreparedReleaseSources extends ReleasePreparationSources {
  previousVersion: string;
  version: string;
}

interface ParsedVersion {
  core: readonly [string, string, string];
  prerelease: readonly string[];
}

function parsedVersion(version: string): ParsedVersion {
  const match = RELEASE_VERSION_PATTERN.exec(version);
  if (match === null) throw new Error(`invalid release version: ${version}`);
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((identifier) => /^\d+$/.test(identifier) && /^0\d+/.test(identifier))) {
    throw new Error(`invalid release version: ${version}`);
  }
  return {
    core: [match[1], match[2], match[3]],
    prerelease,
  };
}

function compareNumericIdentifier(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return compareNumericIdentifier(left, right);
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Compares two exact SemVer release identifiers. */
export function compareReleaseVersions(left: string, right: string): number {
  const leftVersion = parsedVersion(left);
  const rightVersion = parsedVersion(right);
  for (let index = 0; index < leftVersion.core.length; index += 1) {
    const difference = compareNumericIdentifier(leftVersion.core[index], rightVersion.core[index]);
    if (difference !== 0) return difference;
  }
  if (leftVersion.prerelease.length === 0 || rightVersion.prerelease.length === 0) {
    if (leftVersion.prerelease.length === rightVersion.prerelease.length) return 0;
    return leftVersion.prerelease.length === 0 ? 1 : -1;
  }
  const identifiers = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < identifiers; index += 1) {
    const leftIdentifier = leftVersion.prerelease[index];
    const rightIdentifier = rightVersion.prerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === undefined ? -1 : 1;
    }
    const difference = compareIdentifier(leftIdentifier, rightIdentifier);
    if (difference !== 0) return difference;
  }
  return 0;
}

function replaceExactlyOnce(
  source: string,
  current: string,
  replacement: string,
  label: string,
): string {
  const first = source.indexOf(current);
  if (first < 0 || source.indexOf(current, first + current.length) >= 0) {
    throw new Error(`${label} must contain the current release identity exactly once`);
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + current.length)}`;
}

function promoteChangelog(changelog: string, version: string, date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`invalid release date: ${date}`);
  if (changelog.includes(`## [${version}]`)) {
    throw new Error(`CHANGELOG.md already contains release ${version}`);
  }
  const marker = "## [Unreleased]";
  const start = changelog.indexOf(marker);
  if (start < 0) throw new Error("CHANGELOG.md has no Unreleased section");
  const bodyStart = start + marker.length;
  const nextRelease = changelog.indexOf("\n## [", bodyStart);
  if (nextRelease < 0) throw new Error("CHANGELOG.md has no prior release section");
  const body = changelog.slice(bodyStart, nextRelease).trim();
  if (body.length === 0) throw new Error("CHANGELOG.md Unreleased section is empty");
  return `${changelog.slice(0, bodyStart)}\n\n## [${version}] - ${date}\n\n${body}\n${changelog.slice(nextRelease)}`;
}

/** Prepares the root product identity, both installer defaults, and the changelog atomically in memory. */
export function prepareReleaseSources(
  sources: ReleasePreparationSources,
  version: string,
  date: string,
): PreparedReleaseSources {
  parsedVersion(version);
  const product = JSON.parse(sources.packageJson) as { version?: unknown };
  if (typeof product.version !== "string" || !RELEASE_VERSION_PATTERN.test(product.version)) {
    throw new Error("package.json has no exact SemVer product version");
  }
  const previousVersion = product.version;
  if (compareReleaseVersions(version, previousVersion) <= 0) {
    throw new Error(`release version ${version} must be newer than ${previousVersion}`);
  }
  product.version = version;
  return {
    packageJson: `${JSON.stringify(product, null, 2)}\n`,
    installSh: replaceExactlyOnce(
      sources.installSh,
      `CLARVIS_VERSION:-${previousVersion}`,
      `CLARVIS_VERSION:-${version}`,
      "install.sh",
    ),
    installPowerShell: replaceExactlyOnce(
      sources.installPowerShell,
      `else { "${previousVersion}" }`,
      `else { "${version}" }`,
      "install.ps1",
    ),
    changelog: promoteChangelog(sources.changelog, version, date),
    previousVersion,
    version,
  };
}
