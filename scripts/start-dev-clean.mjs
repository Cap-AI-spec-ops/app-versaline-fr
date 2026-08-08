import { execSync, spawn } from "node:child_process";
import { resolve } from "node:path";

function killPort3000() {
  if (process.platform === "win32") {
    try {
      const output = execSync("netstat -ano -p tcp", { encoding: "utf8" });
      const pids = new Set();

      for (const line of output.split(/\r?\n/)) {
        if (!line.includes(":3000") || !line.includes("LISTENING")) {
          continue;
        }

        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];

        if (pid && /^\d+$/.test(pid)) {
          pids.add(pid);
        }
      }

      for (const pid of pids) {
        try {
          execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
          console.log(`Killed process ${pid} on port 3000.`);
        } catch {
          // Best-effort cleanup only.
        }
      }
    } catch {
      // Best-effort cleanup only.
    }

    return;
  }

  try {
    const unixPids = execSync("lsof -ti tcp:3000", { encoding: "utf8" })
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);

    for (const pid of new Set(unixPids)) {
      try {
        execSync(`kill -9 ${pid}`, { stdio: "ignore" });
        console.log(`Killed process ${pid} on port 3000.`);
      } catch {
        // Best-effort cleanup only.
      }
    }
  } catch {
    // Best-effort cleanup only.
  }
}

killPort3000();

const nextArgs = process.argv.slice(2);
const nextBinPath = resolve("node_modules", "next", "dist", "bin", "next");
const child = spawn(process.execPath, [nextBinPath, "dev", ...nextArgs], {
  stdio: "inherit",
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
