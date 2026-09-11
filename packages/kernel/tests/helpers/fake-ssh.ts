import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const separator = argv.indexOf("--");
if (
  separator < 0 ||
  !argv.slice(0, separator).includes("-a") ||
  !argv.slice(0, separator).includes("-x") ||
  argv[separator - 2] !== "-o" ||
  argv[separator - 1] !== "ClearAllForwardings=yes" ||
  argv[separator + 1] !== "test@example.invalid"
) {
  process.stderr.write("invalid fake SSH arguments\n");
  process.exit(64);
}
const command = argv.slice(separator + 2);
if (command.length === 0) process.exit(64);
process.stderr.write("fake-ssh-ok\n");
const remoteHome = process.env.CLARVIS_FAKE_REMOTE_HOME;
const environment = { ...process.env };
delete environment.CLARVIS_FAKE_REMOTE_HOME;
if (remoteHome !== undefined) environment.CLARVIS_HOME = remoteHome;
const child = spawn(command[0]!, command.slice(1), { env: environment, stdio: "inherit" });
child.once("error", () => process.exit(70));
child.once("exit", (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  else process.exit(code ?? 70);
});
