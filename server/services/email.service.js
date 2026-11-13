const nodemailer = require("nodemailer");

function getEmailConfig() {
    const {
        SMTP_HOST,
        SMTP_PORT,
        SMTP_USER,
        SMTP_PASS,
        SMTP_FROM,
        NEXHOST_PUBLIC_URL
    } = process.env;

    const port = Number(SMTP_PORT);

    if (
        !SMTP_HOST ||
        !SMTP_USER ||
        !SMTP_PASS ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535 ||
        !NEXHOST_PUBLIC_URL
    ) {
        throw new Error("SMTP or public URL configuration is incomplete.");
    }

    let publicUrl;

    try {
        publicUrl = new URL(NEXHOST_PUBLIC_URL);
    } catch {
        throw new Error("Invalid NEXHOST_PUBLIC_URL configuration.");
    }

    if (
        !["http:", "https:"].includes(publicUrl.protocol) ||
        publicUrl.username ||
        publicUrl.password ||
        publicUrl.search ||
        publicUrl.hash
    ) {
        throw new Error("Invalid public application URL.");
    }

    return {
        host: SMTP_HOST,
        port,
        secure: port === 465,
        auth: {
            user: SMTP_USER,
            pass: SMTP_PASS
        },
        from: SMTP_FROM || SMTP_USER,
        publicUrl: publicUrl.origin
    };
}

async function sendPasswordResetEmail(email, token) {
    const config = getEmailConfig();

    const transporter = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: config.auth,
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 20000
    });

    const resetUrl = new URL("/reset-password", config.publicUrl);
    resetUrl.searchParams.set("token", token);

    await transporter.sendMail({
        from: config.from,
        to: email,
        subject: "NEXHOST Password Reset",
        text: [
            "We received a request to reset your NEXHOST password.",
            "",
            "Use the link below to choose a new password:",
            resetUrl.toString(),
            "",
            "This link expires in 30 minutes and can only be used once.",
            "",
            "If you did not request this reset, you can ignore this email."
        ].join("\n"),
        html: `
            <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:24px;color:#222">
                <h2>NEXHOST Password Reset</h2>
                <p>We received a request to reset your NEXHOST password.</p>
                <p>Click the button below to choose a new password.</p>
                <p style="margin:30px 0">
                    <a href="${resetUrl.toString()}"
                       style="background:#2563eb;color:white;padding:13px 22px;text-decoration:none;border-radius:7px;display:inline-block">
                        Reset Password
                    </a>
                </p>
                <p>This link expires in <strong>30 minutes</strong> and can only be used once.</p>
                <p>If you did not request this reset, you can safely ignore this email.</p>
                <hr>
                <p style="font-size:12px;color:#777">NEXHOST Account Security</p>
            </div>
        `
    });

    return true;
}

module.exports = {
    sendPasswordResetEmail
};
