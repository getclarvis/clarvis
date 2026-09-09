import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";
import { promisify } from "node:util";
import { DIR_MODE, FILE_MODE } from "@clarvis/paths";
import { kernelError } from "../core/errors.ts";

const executeFile = promisify(execFile);
const usesWindowsAcl = process.platform === "win32";
const windowsPolicy = `
$ErrorActionPreference = 'Stop'
$path = $env:CLARVIS_HOST_PRIVATE_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $path
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { exit 2 }
if ($env:CLARVIS_HOST_PRIVATE_CREATE -eq '1') {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $path -AclObject $acl
  $acl = Get-Acl -LiteralPath $path
}
$rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
if ($rules.Count -eq 0) { exit 3 }
foreach ($rule in $rules) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -ne $sid.Value) { exit 4 }
}
`;

async function assertWindowsPrivate(path: string, created = false): Promise<void> {
  try {
    await executeFile(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(windowsPolicy, "utf16le").toString("base64"),
      ],
      {
        timeout: 10_000,
        maxBuffer: 8192,
        windowsHide: true,
        env: {
          ...process.env,
          CLARVIS_HOST_PRIVATE_PATH: path,
          CLARVIS_HOST_PRIVATE_CREATE: created ? "1" : "0",
        },
      },
    );
  } catch {
    throw kernelError("unauthorized", "local host state requires a private account-owned ACL");
  }
}

/** Existing private state is verified, never chmod-repaired after credentials may have been exposed. */
export async function assertPrivateHostDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== resolve(path))
    throw kernelError("unauthorized", "local host state requires a canonical directory");
  if (usesWindowsAcl) {
    await assertWindowsPrivate(path);
    return;
  }
  if (info.uid !== process.getuid?.() || (info.mode & 0o777) !== DIR_MODE)
    throw kernelError("unauthorized", "local host directory must be private and account-owned");
  const rootOwner = (await lstat(parse(resolve(path)).root)).uid;
  for (let parent = dirname(path); ;) {
    const ancestor = await lstat(parent);
    const trustedOwner = ancestor.uid === rootOwner || ancestor.uid === process.getuid?.();
    const sticky = (ancestor.mode & 0o1000) !== 0;
    if (
      !ancestor.isDirectory() ||
      ancestor.isSymbolicLink() ||
      !trustedOwner ||
      ((ancestor.mode & 0o022) !== 0 && !sticky)
    )
      throw kernelError("unauthorized", "local host state has an unsafe parent directory");
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
}

/** Create the private directory before publishing any credential, then verify its real ownership. */
export async function preparePrivateHostDirectory(path: string): Promise<void> {
  const created = await mkdir(path, { recursive: true, mode: DIR_MODE });
  if (usesWindowsAcl && created !== undefined) await assertWindowsPrivate(path, true);
  await assertPrivateHostDirectory(path);
}

/** Bounded descriptor reads refuse links, special files, changing files and permissive credentials. */
export async function readPrivateHostJson(path: string, maxBytes: number): Promise<unknown> {
  await assertPrivateHostDirectory(dirname(path));
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (handle === null) return null;
  try {
    const info = await handle.stat();
    const named = await lstat(path);
    if (
      !info.isFile() ||
      named.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.ino !== named.ino ||
      info.dev !== named.dev ||
      info.size > maxBytes
    )
      throw kernelError("invalid_request", "local host file is unsafe or exceeds its byte limit");
    if (usesWindowsAcl) await assertWindowsPrivate(path);
    else if (info.uid !== process.getuid?.() || (info.mode & 0o777) !== FILE_MODE)
      throw kernelError("unauthorized", "local host file must be private and account-owned");
    const data = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < data.length) {
      const read = await handle.read(data, offset, data.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (offset !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs)
      throw kernelError("conflict", "local host file changed while being read");
    try {
      return JSON.parse(data.subarray(0, offset).toString("utf8")) as unknown;
    } catch {
      throw kernelError("invalid_request", "local host file is not valid JSON");
    }
  } finally {
    await handle.close();
  }
}
