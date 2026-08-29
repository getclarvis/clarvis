/** Open one validated HTTP(S) URL with the operating system's default browser. */
export async function openPublicUrl(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const argv =
    process.platform === "darwin"
      ? ["open", parsed.href]
      : process.platform === "win32"
        ? ["rundll32", "url.dll,FileProtocolHandler", parsed.href]
        : ["xdg-open", parsed.href];
  try {
    const child = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    return (await child.exited) === 0;
  } catch {
    return false;
  }
}
