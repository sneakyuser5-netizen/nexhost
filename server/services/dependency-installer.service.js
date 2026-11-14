const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const TIMEOUT = 5 * 60 * 1000;

function installDependencies(directory) {
    const packageFile = path.join(directory, "package.json");

    if (!fs.existsSync(packageFile)) {
        return Promise.resolve({
            installed: false,
            reason: "No package.json found."
        });
    }

    const lockFile = path.join(directory, "package-lock.json");
    const useLock = fs.existsSync(lockFile);

    const args = useLock
        ? ["ci", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts"]
        : ["install", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts"];

    return new Promise((resolve, reject) => {
        let settled = false;
        let timer;
        let outputSize = 0;

        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);

            if (error) reject(error);
            else resolve(result);
        };

        const child = spawn("npm", args, {
            cwd: directory,
            shell: false,
            windowsHide: true,
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"]
        });

        const capture = chunk => {
            outputSize += chunk.length;
        };

        child.stdout.on("data", capture);
        child.stderr.on("data", capture);

        timer = setTimeout(() => {
            child.kill("SIGTERM");

            setTimeout(() => {
                if (child.exitCode === null) {
                    child.kill("SIGKILL");
                }
            }, 5000).unref();

            finish(new Error("Dependency installation timed out."));
        }, TIMEOUT);

        child.once("error", () => {
            finish(new Error("Could not start the npm dependency installer."));
        });

        child.once("close", (code, signal) => {
            if (code === 0) {
                finish(null, {
                    installed: true,
                    command: useLock ? "npm ci" : "npm install",
                    outputBytes: outputSize
                });
            } else {
                finish(new Error(
                    `Dependency installation failed (${signal || code}).`
                ));
            }
        });
    });
}

module.exports = { installDependencies };
