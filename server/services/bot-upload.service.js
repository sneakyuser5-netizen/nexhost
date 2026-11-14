const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const yauzl = require("yauzl");
const { pipeline } = require("node:stream/promises");

const BOTS_DIR = path.resolve(__dirname, "../../storage/bots");
const SNAPSHOTS_DIR = path.resolve(__dirname, "../../storage/snapshots");
const { installDependencies } = require("./dependency-installer.service");

const MAX_FILES = 500;
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const MAX_TOTAL_SIZE = 100 * 1024 * 1024;
const MAX_PATH_DEPTH = 15;
const MAX_COMPRESSION_RATIO = 100;

function extractZip(buffer, destination) {
    return new Promise((resolve, reject) => {
        yauzl.fromBuffer(buffer, {
            lazyEntries: true,
            validateEntrySizes: true
        }, (error, zipfile) => {
            if (error) return reject(error);

            let fileCount = 0;
            let totalSize = 0;
            let settled = false;

            const entries = new Map();

            function fail(err) {
                if (settled) return;
                settled = true;

                try {
                    zipfile.close();
                } catch {}

                reject(err);
            }

            function registerEntry(relativePath, isDirectory) {
                const key = relativePath.toLowerCase();

                if (entries.has(key)) {
                    throw new Error("Archive contains duplicate or conflicting paths.");
                }

                const segments = relativePath.split("/");

                if (segments.length > MAX_PATH_DEPTH) {
                    throw new Error("Archive directory depth exceeds the limit.");
                }

                for (let i = 1; i < segments.length; i++) {
                    const parent = segments.slice(0, i).join("/").toLowerCase();
                    const parentType = entries.get(parent);

                    if (parentType === "file") {
                        throw new Error("Archive contains a file/directory conflict.");
                    }
                }

                if (!isDirectory) {
                    const prefix = key + "/";

                    for (const existing of entries.keys()) {
                        if (existing.startsWith(prefix)) {
                            throw new Error("Archive contains a file/directory conflict.");
                        }
                    }
                }

                entries.set(key, isDirectory ? "directory" : "file");
            }

            zipfile.on("error", fail);

            zipfile.on("end", () => {
                if (settled) return;

                settled = true;

                resolve({
                    fileCount,
                    totalSize
                });
            });

            zipfile.on("entry", async (entry) => {
                if (settled) return;

                try {
                    fileCount++;

                    if (fileCount > MAX_FILES) {
                        throw new Error("Archive contains too many entries.");
                    }

                    const name = entry.fileName;

                    if (
                        !name ||
                        name.includes("\\") ||
                        name.includes("\0") ||
                        name.startsWith("/") ||
                        /^[a-zA-Z]:/.test(name)
                    ) {
                        throw new Error("Unsafe archive path detected.");
                    }

                    const isDirectory = name.endsWith("/");
                    const segments = name.split("/").filter(Boolean);

                    if (
                        segments.length === 0 ||
                        segments.some(part =>
                            part === "." ||
                            part === ".."
                        )
                    ) {
                        throw new Error("Unsafe archive path detected.");
                    }

                    const relativePath = segments.join("/");

                    const target = path.resolve(destination, relativePath);
                    const relative = path.relative(destination, target);

                    if (
                        relative.startsWith("..") ||
                        path.isAbsolute(relative)
                    ) {
                        throw new Error("Archive path escapes bot directory.");
                    }

                    const unixMode =
                        (entry.externalFileAttributes >>> 16) & 0xFFFF;

                    const fileType = unixMode & 0o170000;

                    if (
                        fileType !== 0 &&
                        fileType !== 0o100000 &&
                        fileType !== 0o040000
                    ) {
                        throw new Error("Special files are not allowed.");
                    }

                    if (
                        fileType === 0o040000 &&
                        !isDirectory
                    ) {
                        throw new Error("Invalid directory entry.");
                    }

                    if (
                        isDirectory &&
                        entry.uncompressedSize !== 0
                    ) {
                        throw new Error("Invalid directory size.");
                    }

                    registerEntry(relativePath, isDirectory);

                    if (isDirectory) {
                        await fs.promises.mkdir(target, {
                            recursive: true
                        });

                        zipfile.readEntry();
                        return;
                    }

                    if (entry.isEncrypted()) {
                        throw new Error("Encrypted ZIP entries are not allowed.");
                    }

                    if (entry.uncompressedSize > MAX_FILE_SIZE) {
                        throw new Error("An archive file exceeds the size limit.");
                    }

                    totalSize += entry.uncompressedSize;

                    if (totalSize > MAX_TOTAL_SIZE) {
                        throw new Error("Extracted archive exceeds 100 MB.");
                    }

                    if (
                        entry.uncompressedSize > 0 &&
                        entry.compressedSize === 0
                    ) {
                        throw new Error("Invalid ZIP compression data.");
                    }

                    if (
                        entry.compressedSize > 0 &&
                        entry.uncompressedSize / entry.compressedSize >
                            MAX_COMPRESSION_RATIO
                    ) {
                        throw new Error("Archive compression ratio exceeds the limit.");
                    }

                    await fs.promises.mkdir(path.dirname(target), {
                        recursive: true
                    });

                    await new Promise((resolveStream, rejectStream) => {
                        zipfile.openReadStream(entry, async (streamError, stream) => {
                            if (streamError) {
                                return rejectStream(streamError);
                            }

                            try {
                                await pipeline(
                                    stream,
                                    fs.createWriteStream(target, {
                                        flags: "wx",
                                        mode: 0o600
                                    })
                                );

                                resolveStream();
                            } catch (streamError) {
                                rejectStream(streamError);
                            }
                        });
                    });

                    zipfile.readEntry();

                } catch (error) {
                    fail(error);
                }
            });

            zipfile.readEntry();
        });
    });
}

async function uploadBotArchive(bot, buffer, deployment) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
        throw new Error("Invalid ZIP archive.");
    }

    if (
        buffer[0] !== 0x50 ||
        buffer[1] !== 0x4B
    ) {
        throw new Error("Uploaded file is not a valid ZIP archive.");
    }

    await fs.promises.mkdir(BOTS_DIR, {
        recursive: true
    });

    const staging = path.join(
        BOTS_DIR,
        `.staging-${crypto.randomUUID()}`
    );

    const target = path.join(BOTS_DIR, bot.id);

    const backup = path.join(
        BOTS_DIR,
        `.backup-${crypto.randomUUID()}`
    );

    await fs.promises.mkdir(staging);

    let backupCreated = false;

    try {
        const result = await extractZip(buffer, staging);

        const entryPath = path.resolve(staging, bot.entry_file);
        const entryRelative = path.relative(staging, entryPath);

        if (
            entryRelative.startsWith("..") ||
            path.isAbsolute(entryRelative)
        ) {
            throw new Error("Invalid bot entry file path.");
        }

        const entryStat = await fs.promises.stat(entryPath).catch(() => null);

        if (!entryStat || !entryStat.isFile()) {
            throw new Error(
                `Entry file "${bot.entry_file}" was not found in the ZIP archive.`
            );
        }

        if (
            !deployment ||
            !/^[0-9a-f-]{36}$/i.test(deployment.id || "") ||
            !/^[0-9a-f]{64}$/.test(deployment.archiveHash || "")
        ) {
            throw new Error("Invalid deployment snapshot metadata.");
        }

        const archiveHash = crypto
            .createHash("sha256")
            .update(buffer)
            .digest("hex");

        if (archiveHash !== deployment.archiveHash) {
            throw new Error("Archive hash does not match deployment record.");
        }

        if (!/^[0-9a-f-]{36}$/i.test(bot.id || "")) {
            throw new Error("Invalid bot ID for snapshot storage.");
        }

        const dependencyResult = await installDependencies(staging);

        const snapshotDirectory = path.join(SNAPSHOTS_DIR, bot.id);

        await fs.promises.mkdir(snapshotDirectory, {
            recursive: true,
            mode: 0o700
        });

        const snapshotPath = path.join(
            snapshotDirectory,
            deployment.id + ".zip"
        );

        await fs.promises.writeFile(snapshotPath, buffer, {
            flag: "wx",
            mode: 0o600
        });

        if (fs.existsSync(target)) {
            await fs.promises.rename(target, backup);
            backupCreated = true;
        }

        try {
            await fs.promises.rename(staging, target);
        } catch (error) {
            if (backupCreated) {
                await fs.promises.rename(backup, target);
                backupCreated = false;
            }

            throw error;
        }

        if (backupCreated) {
            await fs.promises.rm(backup, {
                recursive: true,
                force: true
            });
        }

        return {
            files: result.fileCount,
            extractedBytes: result.totalSize,
            directory: target,
            snapshotId: deployment.id,
            archiveHash,
            dependencies: dependencyResult
        };

    } catch (error) {
        await fs.promises.rm(staging, {
            recursive: true,
            force: true
        }).catch(() => {});

        if (backupCreated && !fs.existsSync(target)) {
            await fs.promises.rename(backup, target).catch(() => {});
        }

        throw error;
    }
}

async function restoreBotArchive(bot, buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
        throw new Error("Invalid snapshot archive.");
    }

    if (buffer[0] !== 0x50 || buffer[1] !== 0x4B) {
        throw new Error("Snapshot is not a valid ZIP archive.");
    }

    if (!bot || !/^[0-9a-f-]{36}$/i.test(bot.id || "")) {
        throw new Error("Invalid bot ID.");
    }

    await fs.promises.mkdir(BOTS_DIR, { recursive: true });

    const target = path.join(BOTS_DIR, bot.id);
    const staging = path.join(
        BOTS_DIR,
        ".restore-staging-" + crypto.randomUUID()
    );
    const backup = path.join(
        BOTS_DIR,
        ".restore-backup-" + crypto.randomUUID()
    );

    await fs.promises.mkdir(staging);

    let backupCreated = false;

    try {
        const result = await extractZip(buffer, staging);

        const entryPath = path.resolve(staging, bot.entry_file);
        const entryRelative = path.relative(staging, entryPath);

        if (
            entryRelative.startsWith("..") ||
            path.isAbsolute(entryRelative)
        ) {
            throw new Error("Invalid bot entry file path.");
        }

        const entryStat = await fs.promises
            .stat(entryPath)
            .catch(() => null);

        if (!entryStat || !entryStat.isFile()) {
            throw new Error(
                `Entry file "${bot.entry_file}" was not found in the snapshot.`
            );
        }

        const dependencyResult = await installDependencies(staging);

        if (fs.existsSync(target)) {
            await fs.promises.rename(target, backup);
            backupCreated = true;
        }

        try {
            await fs.promises.rename(staging, target);
        } catch (error) {
            if (backupCreated) {
                await fs.promises.rename(backup, target);
                backupCreated = false;
            }

            throw error;
        }

        if (backupCreated) {
            await fs.promises.rm(backup, {
                recursive: true,
                force: true
            });
            backupCreated = false;
        }

        return {
            files: result.fileCount,
            extractedBytes: result.totalSize,
            directory: target,
            dependencies: dependencyResult
        };

    } catch (error) {
        await fs.promises.rm(staging, {
            recursive: true,
            force: true
        }).catch(() => {});

        if (backupCreated && !fs.existsSync(target)) {
            await fs.promises.rename(backup, target).catch(() => {});
        }

        throw error;
    }
}

module.exports = {
    uploadBotArchive,
    restoreBotArchive
};
