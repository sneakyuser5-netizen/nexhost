const multer = require("multer");

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 20 * 1024 * 1024,
        files: 1
    }
});

function uploadBotFile(req, res, next) {
    upload.single("file")(req, res, (error) => {
        if (error) {
            return res.status(400).json({
                success: false,
                message: error instanceof multer.MulterError
                    ? error.message
                    : "File upload failed."
            });
        }

        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: "Please attach a ZIP file using the file field."
            });
        }

        next();
    });
}

module.exports = uploadBotFile;
