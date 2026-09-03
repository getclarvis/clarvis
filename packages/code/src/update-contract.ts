/** The public repository that owns Clarvis release artifacts. */
export const RELEASE_REPOSITORY = "getclarvis/clarvis-releases";

/** The bounded public API query used to discover stable releases and prereleases together. */
export const RELEASES_API_URL =
  "https://api.github.com/repos/getclarvis/clarvis-releases/releases?per_page=30";

/** The largest archive the updater will accept from release metadata. */
export const MAX_RELEASE_ASSET_BYTES = 512 * 1024 * 1024;

/** One natively built portable distribution. */
export type ReleaseTarget =
  "linux-x64" | "linux-arm64" | "darwin-x64" | "darwin-arm64" | "windows-x64" | "windows-arm64";

/** Name the bundled runtime after the product so operating-system process viewers identify Clarvis. */
export function releaseRuntimeExecutableName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "clarvis.exe" : "clarvis";
}

/** A validated GitHub release asset carrying a server-computed SHA-256 digest. */
export interface ReleaseAsset {
  name: string;
  size: number;
  digest: string;
  state: "uploaded";
  browserDownloadUrl: string;
}

/** The release fields used by the update policy after the API response is bounded and decoded. */
export interface ReleaseRecord {
  tagName: string;
  draft: boolean;
  prerelease: boolean;
  publishedAt: string;
  assets: readonly ReleaseAsset[];
}

/** The exact release and target-specific archive selected for installation. */
export interface UpdateSelection {
  version: string;
  tagName: string;
  asset: ReleaseAsset;
}

interface ProductVersion {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly (number | string)[];
}

const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Parse the exact SemVer subset accepted for published Clarvis releases. */
export function parseProductVersion(value: string): ProductVersion | undefined {
  const match = VERSION_PATTERN.exec(value);
  if (match === null) return undefined;
  const prerelease: (number | string)[] = [];
  for (const identifier of match[4]?.split(".") ?? []) {
    if (/^\d+$/.test(identifier)) {
      if (identifier.length > 1 && identifier.startsWith("0")) return undefined;
      prerelease.push(Number(identifier));
    } else {
      prerelease.push(identifier);
    }
  }
  return {
    raw: value,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

/** Compare two valid product versions according to SemVer precedence. */
export function compareProductVersions(left: string, right: string): number {
  const a = parseProductVersion(left);
  const b = parseProductVersion(right);
  if (a === undefined || b === undefined) {
    throw new Error(
      `invalid Clarvis version comparison: ${JSON.stringify(left)}, ${JSON.stringify(right)}`,
    );
  }
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }
  const count = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < count; index++) {
    const av = a.prerelease[index];
    const bv = b.prerelease[index];
    if (av === undefined || bv === undefined) return av === undefined ? -1 : 1;
    if (av === bv) continue;
    if (typeof av === "number" && typeof bv === "string") return -1;
    if (typeof av === "string" && typeof bv === "number") return 1;
    return av < bv ? -1 : 1;
  }
  return 0;
}

/** Resolve the current native runtime to a release target, refusing unsupported pairs. */
export function releaseTarget(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): ReleaseTarget | undefined {
  if (architecture !== "x64" && architecture !== "arm64") return undefined;
  if (platform === "linux" || platform === "darwin") return `${platform}-${architecture}`;
  if (platform === "win32") return `windows-${architecture}`;
  return undefined;
}

/** Name the exact archive published for one product version and native target. */
export function releaseAssetName(version: string, target: ReleaseTarget): string {
  return `clarvis-v${version}-${target}.tar.gz`;
}

function expectedDownloadUrl(tagName: string, assetName: string): string {
  return `https://github.com/${RELEASE_REPOSITORY}/releases/download/${tagName}/${assetName}`;
}

function releaseVersion(record: ReleaseRecord): string | undefined {
  if (!record.tagName.startsWith("v")) return undefined;
  const version = record.tagName.slice(1);
  const parsed = parseProductVersion(version);
  if (parsed === undefined || record.tagName !== `v${parsed.raw}`) return undefined;
  if (record.prerelease !== parsed.prerelease.length > 0) return undefined;
  return version;
}

function eligibleAsset(
  record: ReleaseRecord,
  version: string,
  target: ReleaseTarget,
): ReleaseAsset | undefined {
  const name = releaseAssetName(version, target);
  const matches = record.assets.filter((asset) => asset.name === name);
  if (matches.length !== 1) return undefined;
  const asset = matches[0]!;
  if (asset.state !== "uploaded") return undefined;
  if (
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.size > MAX_RELEASE_ASSET_BYTES
  ) {
    return undefined;
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(asset.digest)) return undefined;
  if (asset.browserDownloadUrl !== expectedDownloadUrl(record.tagName, name)) return undefined;
  return asset;
}

/** Select the highest integrity-bearing update permitted by the installed release channel. */
export function selectUpdateRelease(
  currentVersion: string,
  target: ReleaseTarget,
  releases: readonly ReleaseRecord[],
): UpdateSelection | undefined {
  const current = parseProductVersion(currentVersion);
  if (current === undefined)
    throw new Error(`current Clarvis version is invalid: ${currentVersion}`);
  const selections: UpdateSelection[] = [];
  for (const record of releases) {
    if (record.draft || record.publishedAt.length === 0) continue;
    const version = releaseVersion(record);
    if (version === undefined || compareProductVersions(version, currentVersion) <= 0) continue;
    if (current.prerelease.length === 0 && record.prerelease) continue;
    const asset = eligibleAsset(record, version, target);
    if (asset !== undefined) selections.push({ version, tagName: record.tagName, asset });
  }
  selections.sort((left, right) => compareProductVersions(right.version, left.version));
  return selections[0];
}
