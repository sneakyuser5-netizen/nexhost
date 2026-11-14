const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const BOTS_DIR = path.resolve(__dirname, "../../storage/bots");
const MAX_READ_SIZE = 1024 * 1024;

const BLOCKED = new Set([
    ".git",
    "node_modules",
    "session",
    "sessions"
]);

function blocked(name) {
    return BLOCKED.has(name) || /^\.env($|\.)/i.test(name);
}

function validateName(name) {
    if (
        typeof name !== "string" ||
        !name ||
        name === "." ||
        name === ".." ||
        name.includes("/") ||
        name.includes("\\") ||
        name.includes("\0") ||
        blocked(name)
    ) {
        throw new Error("Invalid or restricted name.");
    }
}

async function getRoot(botId) {
    if (!/^[0-9a-f-]{36}$/i.test(botId || "")) {
        throw new Error("Invalid bot ID.");
    }

    const expected = path.join(BOTS_DIR, botId);
    const root = await fs.promises.realpath(expected);

    if (root !== expected) {
        throw new Error("Invalid bot directory.");
    }

    return root;
}

function resolvePath(root, relative = "") {
    if (
        typeof relative !== "string" ||
        relative.includes("\0") ||
        path.isAbsolute(relative)
    ) {
        throw new Error("Invalid file path.");
    }

    const parts = relative.replace(/\\/g, "/").split("/").filter(Boolean);

    if (parts.some(p => p === "." || p === ".." || blocked(p))) {
        throw new Error("Invalid or restricted path.");
    }

    const target = path.resolve(root, ...parts);
    const rel = path.relative(root, target);

    if (
        rel === ".." ||
        rel.startsWith(".." + path.sep) ||
        path.isAbsolute(rel)
    ) {
        throw new Error("Path outside bot directory.");
    }

    return { target, parts };
}

async function safePath(root, relative = "") {
    const { target, parts } = resolvePath(root, relative);
    let current = root;

    for (const part of parts) {
        current = path.join(current, part);
        const stat = await fs.promises.lstat(current);

        if (stat.isSymbolicLink()) {
            throw new Error("Symbolic links are not accessible.");
        }
    }

    return target;
}

async function newTarget(root, relative) {
    const { target } = resolvePath(root, relative);
    const parentRelative = path.dirname(relative) === "."
        ? ""
        : path.dirname(relative);

    const parent = await safePath(root, parentRelative);
    const parentStat = await fs.promises.stat(parent);

    if (!parentStat.isDirectory()) {
        throw new Error("Invalid parent directory.");
    }

    try {
        await fs.promises.lstat(target);
        throw new Error("A file or folder with that name already exists.");
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }

    return target;
}

async function existingTarget(botId, relative) {
    const root = await getRoot(botId);
    const target = await safePath(root, relative);
    return { root, target };
}

async function listFiles(botId, relative = "") {
    const { root, target } = await existingTarget(botId, relative);
    const stat = await fs.promises.stat(target);

    if (!stat.isDirectory()) {
        throw new Error("Not a directory.");
    }

    const entries = await fs.promises.readdir(target, {
        withFileTypes: true
    });

    const files = [];

    for (const entry of entries) {
        if (blocked(entry.name) || entry.isSymbolicLink()) continue;

        const full = path.join(target, entry.name);
        const info = await fs.promises.lstat(full);

        if (info.isSymbolicLink()) continue;
        if (!info.isFile() && !info.isDirectory()) continue;

        files.push({
            name: entry.name,
            type: info.isDirectory() ? "directory" : "file",
            size: info.isFile() ? info.size : null,
            modifiedAt: info.mtime.toISOString()
        });
    }

    files.sort((a, b) =>
        a.type !== b.type
            ? a.type === "directory" ? -1 : 1
            : a.name.localeCompare(b.name)
    );

    return {
        path: relative.replace(/\\/g, "/"),
        files
    };
}

async function readFile(botId, relative) {
    if (!relative) throw new Error("File path required.");

    const { target } = await existingTarget(botId, relative);
    const stat = await fs.promises.stat(target);

    if (!stat.isFile()) throw new Error("Not a file.");
    if (stat.size > MAX_READ_SIZE) {
        throw new Error("File exceeds the 1 MB editor limit.");
    }

    const buffer = await fs.promises.readFile(target);

    if (buffer.includes(0)) throw new Error("Binary file cannot be edited.");

    let content;

    try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
        throw new Error("File is not valid UTF-8 text.");
    }

    return {
        path: relative,
        content,
        size: stat.size
    };
}

async function writeFile(botId, relative, content, createOnly = false) {
    if (typeof content !== "string") {
        throw new Error("Invalid file content.");
    }

    if (Buffer.byteLength(content, "utf8") > MAX_READ_SIZE) {
        throw new Error("File exceeds the 1 MB editor limit.");
    }

    const root = await getRoot(botId);

    if (createOnly) {
        const target = await newTarget(root, relative);
        await fs.promises.writeFile(target, content, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600
        });
        return;
    }

    const target = await safePath(root, relative);
    const stat = await fs.promises.lstat(target);

    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("Not a regular file.");
    }

    const temporary = path.join(
        path.dirname(target),
        `.nexhost-${crypto.randomUUID()}.tmp`
    );

    try {
        await fs.promises.writeFile(temporary, content, {
            encoding: "utf8",
            mode: stat.mode
        });
        await fs.promises.rename(temporary, target);
    } catch (error) {
        await fs.promises.rm(temporary, { force: true }).catch(() => {});
        throw error;
    }
}

async function createFolder(botId, relative) {
    if (!relative) throw new Error("Folder path required.");

    const root = await getRoot(botId);
    const target = await newTarget(root, relative);

    await fs.promises.mkdir(target, { mode: 0o700 });
}

async function uploadFile(botId, directory, name, buffer) {
    validateName(name);

    if (!Buffer.isBuffer(buffer)) {
        throw new Error("Invalid upload.");
    }

    const root = await getRoot(botId);
    const folder = await safePath(root, directory || "");
    const stat = await fs.promises.stat(folder);

    if (!stat.isDirectory()) {
        throw new Error("Not a directory.");
    }

    const relative = path.posix.join(directory || "", name);
    const target = await newTarget(root, relative);

    const handle = await fs.promises.open(target, "wx", 0o600);
    try {
        await handle.writeFile(buffer);
    } finally {
        await handle.close();
    }
}

async function downloadFile(botId, relative) {
    const { target } = await existingTarget(botId, relative);
    const stat = await fs.promises.stat(target);

    if (!stat.isFile()) throw new Error("Not a file.");

    return {
        name: path.basename(target),
        buffer: await fs.promises.readFile(target)
    };
}

async function renameFile(botId, relative, newName) {
    if (!relative) throw new Error("Path required.");

    validateName(newName);

    const root = await getRoot(botId);
    const source = await safePath(root, relative);
    const parent = path.dirname(relative) === "."
        ? ""
        : path.dirname(relative);

    const destinationRelative = path.posix.join(parent, newName);
    const destination = await newTarget(root, destinationRelative);

    if (source === root || source === destination) {
        throw new Error("Invalid rename operation.");
    }

    await fs.promises.rename(source, destination);
}

async function deleteFile(botId, relative) {
    if (!relative) throw new Error("Cannot delete bot root.");

    const { root, target } = await existingTarget(botId, relative);

    if (target === root) throw new Error("Cannot delete bot root.");

    const stat = await fs.promises.lstat(target);

    if (stat.isSymbolicLink()) {
        throw new Error("Symbolic links are not accessible.");
    }

    await fs.promises.rm(target, {
        recursive: stat.isDirectory(),
        force: false
    });
}

module.exports = {
    listFiles,
    readFile,
    writeFile,
    createFolder,
    uploadFile,
    downloadFile,
    renameFile,
    deleteFile
};
