const multer = require("multer");

const MAX_UPLOAD_SIZE = 20 * 1024 * 1024;
const MAX_CONCURRENT_UPLOADS = 3;

let activeUploads = 0;

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_UPLOAD_SIZE,
        files: 1,
        fields: 0,
        parts: 1,
        fieldNameSize: 50,
        headerPairs: 100
    },
    fileFilter(req, file, callback) {
        const extension = file.originalname
            .toLowerCase()
            .split(".")
            .pop();

        if (extension !== "zip") {
            return callback(
                new Error("Only ZIP archives are allowed.")
            );
        }

        callback(null, true);
    }
});

function uploadBotFile(req, res, next) {
    if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
        return res.status(429).json({
            success: false,
            message: "Too many uploads are currently being processed."
        });
    }

    activeUploads++;

    let released = false;

    function releaseUpload() {
        if (released) return;

        released = true;
        activeUploads = Math.max(0, activeUploads - 1);
    }

    res.once("finish", releaseUpload);
    res.once("close", releaseUpload);

    upload.single("file")(req, res, (error) => {
        if (error) {
            releaseUpload();

            return res.status(400).json({
                success: false,
                message: error instanceof multer.MulterError
                    ? error.message
                    : error.message || "File upload failed."
            });
        }

        if (!req.file) {
            releaseUpload();

            return res.status(400).json({
                success: false,
                message: "Please attach a ZIP file using the file field."
            });
        }

        next();
    });
}

module.exports = uploadBotFile;
