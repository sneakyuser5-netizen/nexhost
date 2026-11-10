function createRuntime() {
    const driver = (process.env.BOT_RUNTIME_DRIVER || "local").toLowerCase();

    if (driver === "local") {
        return require("./local.runtime");
    }

    if (driver === "docker") {
        return require("./docker.runtime");
    }

    throw new Error(`Unsupported bot runtime driver: ${driver}`);
}

module.exports = createRuntime();
