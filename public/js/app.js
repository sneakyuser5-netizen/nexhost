const API = "/api";
const TOKEN_KEY = "nexhost_token";

let token = localStorage.getItem(TOKEN_KEY);
let currentUser = null;
let bots = [];
let authMode = "login";
let pendingVerificationEmail = "";
let activeBotId = null;
let detailMode = "logs";
let logAutoRefresh = true;
let logRequestRunning = false;
let toastTimer;

const $ = selector => document.querySelector(selector);

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
    })[char]);
}

function notify(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3000);
}

async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});

    if (token) {
        headers.set("Authorization", `Bearer ${token}`);
    }

    if (options.body && !(options.body instanceof FormData)) {
        headers.set("Content-Type", "application/json");
    }

    const response = await fetch(`${API}${path}`, {
        ...options,
        headers
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.success === false) {
        if (response.status === 401) {
            logout(false);
        }

        throw new Error(data.message || `Request failed (${response.status})`);
    }

    return data;
}

function showAuth() {
    $("#auth-screen").classList.remove("hidden");
    $("#dashboard").classList.add("hidden");
}

async function showDashboard() {
    $("#auth-screen").classList.add("hidden");
    $("#dashboard").classList.remove("hidden");

    try {
        if (!currentUser || !currentUser.created_at) {
            const result = await api("/auth/me");
            currentUser = result.user;
        }

        $("#user-email").textContent = currentUser.email;
        const ownerNav = $("#owner-dashboard-nav");
        if (ownerNav) {
            ownerNav.classList.toggle("hidden", currentUser.role !== "admin");
        }

        $("#page-title").textContent = "Overview";

        renderAccount();
        loadBots();
    } catch (error) {
        console.error("[ACCOUNT]", error);
        logout(false);
    }
}

function renderAccount() {
    if (!currentUser) return;

    const formatDate = value => {
        if (!value) return "Not available";

        const date = new Date(
            value.includes("Z") || value.includes("+")
                ? value
                : value.replace(" ", "T") + "Z"
        );

        return Number.isNaN(date.getTime())
            ? value
            : date.toLocaleString();
    };

    $("#account-avatar").textContent =
        currentUser.email.charAt(0).toUpperCase();

    $("#account-email").textContent = currentUser.email;
    $("#account-email-detail").textContent = currentUser.email;
    $("#account-id").textContent = currentUser.id;
    $("#account-role").textContent = currentUser.role;
    $("#account-created").textContent =
        formatDate(currentUser.created_at);
    $("#account-updated").textContent =
        formatDate(currentUser.updated_at);
}

function showAuthPanel(panel) {
    const login = panel === "login";
    const forgot = panel === "forgot";
    const reset = panel === "reset";
    const verify = panel === "verify";

    document.querySelector(".auth-tabs").classList.toggle("hidden", !login);
    $("#auth-form").classList.toggle("hidden", !login);
    $("#forgot-password-link").classList.toggle("hidden", !login || authMode !== "login");
    $("#forgot-password-form").classList.toggle("hidden", !forgot);
    $("#reset-password-form").classList.toggle("hidden", !reset);
    $("#verify-email-form").classList.toggle("hidden", !verify);
}

function setAuthMode(mode) {
    authMode = mode;

    document.querySelectorAll(".auth-tab").forEach(button => {
        button.classList.toggle("active", button.dataset.auth === mode);
    });

    $("#auth-submit").textContent = mode === "login" ? "Login" : "Create Account";
    $("#auth-password").autocomplete = mode === "login"
        ? "current-password"
        : "new-password";
    $("#auth-error").textContent = "";

    showAuthPanel("login");
}

async function submitAuth(event) {
    event.preventDefault();

    const email = $("#auth-email").value.trim();
    const password = $("#auth-password").value;

    $("#auth-submit").disabled = true;
    $("#auth-error").textContent = "";

    try {
        const result = await api(`/auth/${authMode}`, {
            method: "POST",
            body: JSON.stringify({ email, password })
        });

        if (authMode === "register") {
            pendingVerificationEmail = result.email || email;

            $("#verify-email-description").textContent =
                "A confirmation code has been sent to " +
                pendingVerificationEmail + ". Enter it below.";

            $("#verification-code").value = "";
            $("#verify-email-error").textContent = "";
            $("#resend-verification-feedback").textContent = "";

            $("#auth-form").reset();
            showAuthPanel("verify");
            notify("Confirmation code sent to your email.");
            return;
        }

        token = result.token;
        currentUser = result.user;
        localStorage.setItem(TOKEN_KEY, token);

        $("#auth-form").reset();
        showDashboard();
        notify("Welcome back!");
    } catch (error) {
        $("#auth-error").textContent = error.message;

        if (
            error.message.includes("awaiting verification") ||
            error.message.includes("verify your email address")
        ) {
            pendingVerificationEmail = email;

            $("#verify-email-description").textContent =
                "Verify " + email + " using the confirmation code sent to your email. You can request another code below.";

            $("#verification-code").value = "";
            $("#verify-email-error").textContent = "";
            $("#resend-verification-feedback").textContent = "";

            showAuthPanel("verify");
        }
    } finally {
        $("#auth-submit").disabled = false;
    }
}

async function submitVerifyEmail(event) {
    event.preventDefault();

    const code = $("#verification-code").value.trim();
    const button = $("#verify-email-submit");
    const message = $("#verify-email-error");

    message.textContent = "";

    if (!pendingVerificationEmail) {
        message.textContent = "Please return to registration and enter your email again.";
        return;
    }

    if (!/^\d{8}$/.test(code)) {
        message.textContent = "Enter the complete 8-digit confirmation code.";
        return;
    }

    button.disabled = true;

    try {
        const result = await api("/auth/verify-email", {
            method: "POST",
            body: JSON.stringify({
                email: pendingVerificationEmail,
                code
            })
        });

        $("#verify-email-form").reset();

        const verifiedEmail = pendingVerificationEmail;
        pendingVerificationEmail = "";

        setAuthMode("login");
        $("#auth-email").value = verifiedEmail;
        $("#auth-error").textContent =
            result.message || "Email verified. You can now log in.";

        notify("Email verified successfully.");
    } catch (error) {
        message.textContent = error.message;
    } finally {
        button.disabled = false;
    }
}

async function resendVerificationCode() {
    const button = $("#resend-verification-code");
    const feedback = $("#resend-verification-feedback");

    feedback.textContent = "";

    if (!pendingVerificationEmail) {
        feedback.textContent = "Please return to registration and enter your email again.";
        return;
    }

    button.disabled = true;

    try {
        const result = await api("/auth/resend-verification", {
            method: "POST",
            body: JSON.stringify({
                email: pendingVerificationEmail
            })
        });

        feedback.textContent = result.message;
    } catch (error) {
        feedback.textContent = error.message;
    } finally {
        button.disabled = false;
    }
}

async function submitForgotPassword(event) {
    event.preventDefault();

    const email = $("#forgot-email").value.trim();
    const button = $("#forgot-submit");
    const message = $("#forgot-error");

    button.disabled = true;
    message.textContent = "";

    try {
        const result = await api("/auth/forgot-password", {
            method: "POST",
            body: JSON.stringify({ email })
        });

        message.textContent = result.message ||
            "If an account exists, a password reset link will be sent.";
    } catch (error) {
        message.textContent = error.message;
    } finally {
        button.disabled = false;
    }
}

async function submitResetPassword(event) {
    event.preventDefault();

    const password = $("#reset-password").value;
    const confirmation = $("#reset-password-confirm").value;
    const message = $("#reset-error");
    const button = $("#reset-submit");
    const resetToken = new URLSearchParams(window.location.search).get("token");

    message.textContent = "";

    if (!resetToken) {
        message.textContent = "This reset link is missing its token. Request a new link.";
        return;
    }

    if (password !== confirmation) {
        message.textContent = "The passwords do not match.";
        return;
    }

    button.disabled = true;

    try {
        const result = await api("/auth/reset-password", {
            method: "POST",
            body: JSON.stringify({ token: resetToken, newPassword: password })
        });

        $("#reset-password-form").reset();
        history.replaceState({}, document.title, window.location.pathname);
        setAuthMode("login");
        showAuthPanel("login");
        $("#auth-error").textContent = result.message || "Password reset successful. You can now log in.";
    } catch (error) {
        message.textContent = error.message;
    } finally {
        button.disabled = false;
    }
}

async function submitChangePassword(event) {
    event.preventDefault();

    const currentPassword = $("#current-password").value;
    const newPassword = $("#new-password").value;
    const confirmation = $("#confirm-new-password").value;
    const message = $("#change-password-message");
    const button = $("#change-password-submit");

    message.textContent = "";

    if (newPassword !== confirmation) {
        message.textContent = "The new passwords do not match.";
        return;
    }

    if (newPassword === currentPassword) {
        message.textContent = "Choose a password different from your current password.";
        return;
    }

    button.disabled = true;

    try {
        const result = await api("/auth/change-password", {
            method: "POST",
            body: JSON.stringify({ currentPassword, newPassword })
        });

        if (result.token) {
            token = result.token;
            localStorage.setItem(TOKEN_KEY, token);
        }

        $("#change-password-form").reset();

        const account = await api("/auth/me");
        currentUser = account.user;
        renderAccount();

        message.textContent = "Password changed successfully. Other sessions have been signed out.";
    } catch (error) {
        message.textContent = error.message;
    } finally {
        button.disabled = false;
    }
}

async function logout(sendRequest = true) {
    if (sendRequest && token) {
        try {
            await api("/auth/logout", { method: "POST" });
        } catch {}
    }

    token = null;
    currentUser = null;
    localStorage.removeItem(TOKEN_KEY);
    bots = [];
    showAuth();
}

const DEFAULT_SETTINGS = {
    theme: "dark",
    resources: true
};

const SETTINGS_STORAGE_KEY = "nexhost_dashboard_settings";

let savedSettings = { ...DEFAULT_SETTINGS };
let currentSettings = { ...DEFAULT_SETTINGS };

function loadSavedSettings() {
    try {
        const stored = localStorage.getItem(SETTINGS_STORAGE_KEY);

        if (stored) {
            const parsed = JSON.parse(stored);

            savedSettings = {
                theme: parsed.theme === "light" ? "light" : "dark",
                resources: parsed.resources !== false
            };
        }
    } catch (error) {
        console.error("[SETTINGS] Could not load preferences:", error);
        savedSettings = { ...DEFAULT_SETTINGS };
    }

    currentSettings = { ...savedSettings };
    applySettings();
}

function applySettings() {
    document.documentElement.dataset.theme = currentSettings.theme;
    document.documentElement.style.colorScheme = currentSettings.theme;

    const resourceGrid = $("#resource-grid");

    if (resourceGrid) {
        resourceGrid.hidden = !currentSettings.resources;

        const heading = resourceGrid.previousElementSibling;

        if (heading) {
            heading.hidden = !currentSettings.resources;
        }
    }
}

function renderSettings() {
    $("#theme-select").value = currentSettings.theme;
    $("#resource-toggle").checked = currentSettings.resources;
}

function showSettingsFeedback(message, type = "") {
    const feedback = $("#settings-feedback");

    if (!feedback) return;

    feedback.textContent = message;
    feedback.className = `settings-feedback ${type}`;
}

function saveSettings() {
    try {
        localStorage.setItem(
            SETTINGS_STORAGE_KEY,
            JSON.stringify(currentSettings)
        );

        savedSettings = { ...currentSettings };

        showSettingsFeedback(
            "Your preferences have been saved.",
            "success"
        );
    } catch (error) {
        console.error("[SETTINGS] Save failed:", error);
        showSettingsFeedback(
            "Could not save your preferences.",
            "error"
        );
    }
}

function resetSettings() {
    currentSettings = { ...DEFAULT_SETTINGS };

    applySettings();
    renderSettings();

    showSettingsFeedback(
        "Default settings restored. Click Save Changes to keep them."
    );
}

function switchView(view) {
    document.querySelectorAll(".view").forEach(section => {
        section.classList.add("hidden");
    });

    $(`#view-${view}`).classList.remove("hidden");

    document.querySelectorAll(".nav-item").forEach(button => {
        button.classList.toggle("active", button.dataset.view === view);
    });

    const titles = {
        overview: "Overview",
        bots: "My Bots",
        deployments: "Deployments",
        account: "Account",
        settings: "Settings",
        help: "Help & Support",
        owner: "Owner Dashboard"
    };

    $("#page-title").textContent = titles[view] || "Overview";

    if (view === "deployments") loadAllDeployments();
    if (view === "help") loadSupportTickets();
    if (view === "owner") loadOwnerDashboard();

    if (view === "settings") {
        renderSettings();
        showSettingsFeedback("");
    }
}


/* NEXHOST SUPPORT TICKETS */

let activeSupportTicketId = null;

function supportStatusBadge(status) {
    const labels = {
        open: "Open",
        in_progress: "In Progress",
        resolved: "Resolved",
        closed: "Closed"
    };

    return `<span class="support-status ${escapeHTML(status)}">${escapeHTML(labels[status] || status)}</span>`;
}

async function loadSupportTickets() {
    const container = $("#support-ticket-list");
    if (!container) return;

    container.innerHTML = '<p class="muted">Loading tickets...</p>';

    try {
        const result = await api("/support");
        const tickets = result.tickets || [];

        if (!tickets.length) {
            container.innerHTML = '<p class="muted">You have not submitted any tickets yet.</p>';
            return;
        }

        container.innerHTML = tickets.map(ticket => `
            <button type="button" class="support-ticket-item"
                data-action="support-open"
                data-id="${escapeHTML(ticket.id)}">
                <span>
                    <strong>${escapeHTML(ticket.subject)}</strong>
                    <small>${escapeHTML(ticket.category)} · ${escapeHTML(ticket.priority)}</small>
                </span>
                ${supportStatusBadge(ticket.status)}
            </button>
        `).join("");
    } catch (error) {
        container.innerHTML = `<p class="error-text">${escapeHTML(error.message)}</p>`;
    }
}

async function openSupportTicket(id) {
    activeSupportTicketId = id;

    const conversation = $("#support-conversation");
    conversation.classList.remove("hidden");
    $("#support-messages").innerHTML = '<p class="muted">Loading conversation...</p>';

    try {
        const result = await api(`/support/${encodeURIComponent(id)}`);
        const ticket = result.ticket;
        if (!ticket) throw new Error("Ticket information was not returned.");

        $("#support-conversation-title").textContent = ticket.subject;
        $("#support-ticket-details").innerHTML = `
            <div class="support-ticket-meta">
                ${supportStatusBadge(ticket.status)}
                <span>${escapeHTML(ticket.category)}</span>
                <span>Priority: ${escapeHTML(ticket.priority)}</span>
            </div>
        `;

        const messages = ticket.messages || result.messages || [];

        $("#support-messages").innerHTML = messages.length
            ? messages.map(message => `
                <article class="support-message">
                    <div class="support-message-heading">
                        <strong>${escapeHTML(message.sender_email || message.sender_role || "User")}</strong>
                        <small>${escapeHTML(message.created_at || "")}</small>
                    </div>
                    <p>${escapeHTML(message.message)}</p>
                </article>
            `).join("")
            : '<p class="muted">No messages yet.</p>';

        const isAdmin = currentUser && currentUser.role === "admin";
        $("#support-admin-controls").classList.toggle("hidden", !isAdmin);
        $("#support-status-select").value = ticket.status;

        const replyForm = $("#support-reply-form");
        const replyButton = replyForm.querySelector("button[type='submit']");
        replyButton.disabled = ticket.status === "closed";
        $("#support-reply").disabled = ticket.status === "closed";

        conversation.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
        $("#support-messages").innerHTML =
            `<p class="error-text">${escapeHTML(error.message)}</p>`;
    }
}

function closeSupportConversation() {
    activeSupportTicketId = null;
    $("#support-conversation").classList.add("hidden");
    $("#support-reply-form").reset();
}

async function submitSupportTicket(event) {
    event.preventDefault();

    const feedback = $("#support-form-feedback");
    const button = event.currentTarget.querySelector("button[type='submit']");
    button.disabled = true;
    feedback.textContent = "Submitting ticket...";

    try {
        const result = await api("/support", {
            method: "POST",
            body: JSON.stringify({
                subject: $("#support-subject").value.trim(),
                category: $("#support-category").value,
                priority: $("#support-priority").value,
                message: $("#support-message").value.trim()
            })
        });

        event.currentTarget.reset();
        feedback.textContent = result.message || "Support ticket submitted successfully.";
        await loadSupportTickets();

        if (result.ticket && result.ticket.id) {
            await openSupportTicket(result.ticket.id);
        } else if (result.ticketId || result.id) {
            await openSupportTicket(result.ticketId || result.id);
        }

        notify("Support ticket submitted.");
    } catch (error) {
        feedback.textContent = error.message;
    } finally {
        button.disabled = false;
    }
}

async function submitSupportReply(event) {
    event.preventDefault();
    if (!activeSupportTicketId) return;

    const button = event.currentTarget.querySelector("button[type='submit']");
    const message = $("#support-reply").value.trim();
    if (!message) return;

    button.disabled = true;

    try {
        await api(`/support/${encodeURIComponent(activeSupportTicketId)}/replies`, {
            method: "POST",
            body: JSON.stringify({ message })
        });

        $("#support-reply").value = "";
        await openSupportTicket(activeSupportTicketId);
        await loadSupportTickets();
        notify("Reply sent successfully.");
    } catch (error) {
        notify(error.message);
    } finally {
        button.disabled = false;
    }
}

async function updateSupportTicketStatus() {
    if (!activeSupportTicketId) return;

    try {
        await api(`/support/${encodeURIComponent(activeSupportTicketId)}/status`, {
            method: "PATCH",
            body: JSON.stringify({
                status: $("#support-status-select").value
            })
        });

        await openSupportTicket(activeSupportTicketId);
        await loadSupportTickets();
        notify("Ticket status updated.");
    } catch (error) {
        notify(error.message);
    }
}

function statusBadge(status) {
    return `<span class="status ${escapeHTML(status)}">${escapeHTML(status)}</span>`;
}

function botCard(bot) {
    const id = escapeHTML(bot.id);
    const name = escapeHTML(bot.name);
    const status = escapeHTML(bot.status);

    return `
        <article class="bot-card">
            <div class="bot-card-top">
                <span class="bot-meta">NODE.JS APPLICATION</span>
                ${statusBadge(status)}
            </div>
            <h3>${name}</h3>
            <div class="bot-meta">Entry: ${escapeHTML(bot.entry_file)}</div>
            <div class="bot-meta">Created: ${escapeHTML(bot.created_at)}</div>

            <div class="bot-actions">
                <button class="small-btn" data-action="start" data-id="${id}">Start</button>
                <button class="small-btn" data-action="stop" data-id="${id}">Stop</button>
                <button class="small-btn" data-action="restart" data-id="${id}">Restart</button>
                <button class="small-btn" data-action="details" data-id="${id}">Console</button>
                <button class="small-btn" data-action="deployments" data-id="${id}">History</button>
                <button class="small-btn" data-action="upload" data-id="${id}">Upload ZIP</button>
                <button class="small-btn danger" data-action="delete" data-id="${id}">Delete</button>
            </div>

            <input class="upload-input" type="file" accept=".zip"
                data-upload-id="${id}">
        </article>
    `;
}

function renderBots() {
    const running = bots.filter(bot => bot.status === "running").length;
    const stopped = bots.filter(bot => bot.status === "stopped").length;

    $("#total-bots").textContent = bots.length;
    $("#running-bots").textContent = running;
    $("#stopped-bots").textContent = stopped;

    const cards = bots.length
        ? bots.map(botCard).join("")
        : `<div class="empty-state">No bots yet. Create your first bot to get started.</div>`;

    $("#bot-list").innerHTML = cards;
    $("#recent-bots").innerHTML = bots.length
        ? bots.slice(0, 3).map(botCard).join("")
        : cards;
}

async function loadBots() {
    try {
        const result = await api("/bots");
        bots = result.bots || [];
        renderBots();
        await loadResources();
    } catch (error) {
        notify(error.message);
    }
}


function formatUptime(seconds) {
    if (seconds == null) return "--";

    const value = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const secs = value % 60;

    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${secs}s`;
    return `${secs}s`;
}

function resourceCard(bot, resource) {
    const cpu = resource.cpuPercent;
    const memory = resource.memoryMB;
    const running = resource.running;

    const cpuText = cpu == null ? "Sampling..." : `${cpu.toFixed(2)}%`;
    const memoryText = memory == null ? "--" : `${memory.toFixed(2)} MB`;

    const cpuWidth = cpu == null
        ? 0
        : Math.min(100, Math.max(0, cpu));

    return `
        <article class="resource-card">
            <div class="bot-card-top">
                <span class="bot-meta">NODE.JS PROCESS</span>
                ${statusBadge(resource.status)}
            </div>

            <h3>${escapeHTML(bot.name)}</h3>

            <div class="resource-metric">
                <div class="resource-metric-header">
                    <span>CPU Usage</span>
                    <strong>${escapeHTML(cpuText)}</strong>
                </div>
                <div class="resource-bar">
                    <div class="resource-bar-fill"
                         style="width:${cpuWidth}%"></div>
                </div>
            </div>

            <div class="resource-metric">
                <div class="resource-metric-header">
                    <span>Memory (RSS)</span>
                    <strong>${escapeHTML(memoryText)}</strong>
                </div>
            </div>

            <div class="resource-details">
                <div class="resource-detail">
                    <span>Process ID</span>
                    <strong>${running ? escapeHTML(resource.pid) : "--"}</strong>
                </div>
                <div class="resource-detail">
                    <span>Uptime</span>
                    <strong>${running ? formatUptime(resource.uptimeSeconds) : "--"}</strong>
                </div>
            </div>
        </article>
    `;
}

let resourceRequestRunning = false;

async function loadResources() {
    const target = $("#resource-grid");

    if (
        !target ||
        !currentSettings.resources ||
        resourceRequestRunning
    ) return;

    if (!bots.length) {
        target.innerHTML = `
            <div class="empty-state">No bots available for monitoring.</div>
        `;
        return;
    }

    resourceRequestRunning = true;

    try {
        const results = await Promise.all(
            bots.map(async bot => {
                try {
                    const result = await api(
                        `/bots/${encodeURIComponent(bot.id)}/resources`
                    );

                    return resourceCard(bot, result.resources);
                } catch (error) {
                    return `
                        <article class="resource-card">
                            <h3>${escapeHTML(bot.name)}</h3>
                            <p class="error-text">
                                ${escapeHTML(error.message)}
                            </p>
                        </article>
                    `;
                }
            })
        );

        target.innerHTML = results.join("");
    } finally {
        resourceRequestRunning = false;
    }
}

async function createBot(event) {
    event.preventDefault();

    const name = $("#bot-name").value.trim();
    const entryFile = $("#bot-entry").value.trim();

    try {
        await api("/bots", {
            method: "POST",
            body: JSON.stringify({ name, entryFile, runtime: "node" })
        });

        $("#create-bot-form").reset();
        $("#bot-modal").classList.add("hidden");
        notify("Bot created successfully.");
        await loadBots();
        switchView("bots");
    } catch (error) {
        notify(error.message);
    }
}

async function processAction(id, action) {
    try {
        const result = await api(`/bots/${encodeURIComponent(id)}/${action}`, {
            method: "POST"
        });

        notify(result.message || `Bot ${action} request completed.`);
        await loadBots();
    } catch (error) {
        notify(error.message);
    }
}

async function deleteBot(id) {
    if (!confirm("Delete this bot and its deployment history?")) return;

    try {
        await api(`/bots/${encodeURIComponent(id)}`, {
            method: "DELETE"
        });

        notify("Bot deleted.");
        await loadBots();
    } catch (error) {
        notify(error.message);
    }
}

async function uploadBot(id, file) {
    if (!file) return;

    if (!file.name.toLowerCase().endsWith(".zip")) {
        notify("Please select a ZIP file.");
        return;
    }

    const form = new FormData();
    form.append("file", file);

    try {
        const result = await api(`/bots/${encodeURIComponent(id)}/upload`, {
            method: "POST",
            body: form
        });

        notify(`Uploaded deployment version ${result.deployment.version}.`);
        await loadBots();
    } catch (error) {
        notify(error.message);
    }
}

async function rollbackBot(botId, deploymentId) {
    if (!confirm("Restore this deployment? The current bot files will be replaced.")) return;

    try {
        const result = await api(
            `/bots/${encodeURIComponent(botId)}/rollback/${encodeURIComponent(deploymentId)}`,
            { method: "POST" }
        );

        notify(result.message || "Deployment restored successfully.");
        await loadBots();
        await loadDetails();
        await loadAllDeployments();
    } catch (error) {
        notify(error.message);
    }
}

async function openDetails(id, mode = "logs") {
    activeBotId = id;
    detailMode = mode;

    const bot = bots.find(item => item.id === id);
    $("#details-title").textContent = bot ? bot.name : "Bot details";
    $("#details-modal").classList.remove("hidden");

    document.querySelectorAll(".detail-tab").forEach(button => {
        button.classList.toggle("active", button.dataset.detail === mode);
    });

    await loadDetails();
}

function renderLogLines(logText) {
    return String(logText || "")
        .split(/\r?\n/)
        .map(line => {
            const safeLine = escapeHTML(line);
            let className = "";

            if (/\b(error|fatal|exception|uncaught)\b/i.test(line)) {
                className = "log-error";
            } else if (/\b(warn|warning)\b/i.test(line)) {
                className = "log-warning";
            }

            return `<span class="${className}">${safeLine}</span>`;
        })
        .join("\n");
}

async function loadBotLogs() {
    if (logRequestRunning || !activeBotId) return;

    const target = $("#details-content");
    const output = target.querySelector(".log-output");
    const botId = activeBotId;

    if (!output) return;

    logRequestRunning = true;

    try {
        const result = await api(
            `/bots/${encodeURIComponent(botId)}/logs`
        );

        if (activeBotId !== botId || detailMode !== "logs") return;

        const currentOutput = $("#details-content").querySelector(".log-output");
        if (!currentOutput) return;

        currentOutput.innerHTML = renderLogLines(
            result.logs || "No logs available."
        );
        currentOutput.scrollTop = currentOutput.scrollHeight;

        const status = $("#log-refresh-status");
        if (status) {
            status.textContent = logAutoRefresh
                ? "Auto-refresh: ON"
                : "Auto-refresh: PAUSED";
        }
    } catch (error) {
        if (activeBotId === botId) {
            const status = $("#log-refresh-status");
            if (status) status.textContent = error.message;
        }
    } finally {
        logRequestRunning = false;
    }
}



async function deleteBotEnvironmentVariable(name) {
    if (!confirm(`Delete environment variable ${name}?`)) return;

    try {
        await api(
            `/bots/${encodeURIComponent(activeBotId)}/config/environment/${encodeURIComponent(name)}`,
            { method: "DELETE" }
        );

        notify("Environment variable deleted.");
        await loadDetails();
    } catch (error) {
        notify(error.message);
    }
}

async function loadBotConfig() {
    const target = $("#details-content");
    const botId = activeBotId;

    const result = await api(
        `/bots/${encodeURIComponent(botId)}/config`
    );

    if (activeBotId !== botId || detailMode !== "config") return;

    const config = result.config || result;
    const args = Array.isArray(config.startupArgs)
        ? config.startupArgs
        : [];

    const names = config.environmentVariableNames || [];

    target.innerHTML = `
        <section class="settings-section">
            <h3>Startup Arguments</h3>
            <p class="muted">
                One argument per line. These are passed to your bot,
                not to the Node.js runtime.
            </p>
            <form id="startup-config-form">
                <textarea id="startup-args" rows="5"
                    maxlength="9000"
                    placeholder="--mode&#10;production">${escapeHTML(args.join("\n"))}</textarea>
                <button class="primary-btn" type="submit">
                    Save Startup Arguments
                </button>
            </form>
        </section>

        <section class="settings-section">
            <h3>Environment Variables</h3>
            <p class="muted">
                Values are encrypted when stored and are never displayed again.
            </p>
            <form id="environment-config-form">
                <label for="environment-name">Variable Name</label>
                <input id="environment-name" required
                    maxlength="128" pattern="[A-Za-z_][A-Za-z0-9_]*"
                    placeholder="API_KEY" autocomplete="off">

                <label for="environment-value">Variable Value</label>
                <input id="environment-value" type="password"
                    required maxlength="8192"
                    autocomplete="new-password"
                    placeholder="Enter variable value">

                <button class="primary-btn" type="submit">
                    Save Variable
                </button>
            </form>

            <h3>Saved Variables</h3>
            <div class="environment-list">
                ${names.length ? names.map(name => `
                    <div class="deployment-row">
                        <strong>${escapeHTML(name)}</strong>
                        <button class="small-btn danger"
                            data-action="env-delete"
                            data-name="${escapeHTML(name)}">
                            Delete
                        </button>
                    </div>
                `).join("") : `<p class="muted">No variables configured.</p>`}
            </div>
        </section>
    `;
}

async function loadDetails() {
    const target = $("#details-content");
    target.innerHTML = `<p class="muted">Loading...</p>`;

    try {
        if (detailMode === "logs") {
            target.innerHTML = `
                <div class="log-toolbar">
                    <div class="log-controls">
                        <button class="small-btn" data-log-action="pause">
                            Pause
                        </button>
                        <button class="small-btn" data-log-action="refresh">
                            Refresh
                        </button>
                        <button class="small-btn" data-log-action="clear">
                            Clear view
                        </button>
                    </div>
                    <span id="log-refresh-status">Auto-refresh: ON</span>
                </div>
                <pre class="log-output" aria-live="polite"></pre>
            `;

            await loadBotLogs();
        } else if (detailMode === "deployments") {
            const result = await api(
                `/bots/${encodeURIComponent(activeBotId)}/deployments`
            );

            target.innerHTML = result.deployments.length
                ? result.deployments.map(deployment => `
                    <div class="deployment-row">
                        <div>
                            <strong>Version ${escapeHTML(deployment.version)}</strong>
                            <div class="bot-meta">${escapeHTML(deployment.created_at)}</div>
                        </div>
                        ${statusBadge(deployment.status)}
                        <button class="small-btn" data-action="rollback"
                            data-id="${escapeHTML(activeBotId)}"
                            data-deployment-id="${escapeHTML(deployment.id)}">
                            Rollback
                        </button>
                    </div>
                `).join("")
                : `<p class="muted">No deployments found.</p>`;
        } else if (detailMode === "config") {
            await loadBotConfig();
        }
    } catch (error) {
        target.textContent = error.message;
    }
}

async function loadAllDeployments() {
    const target = $("#deployment-list");
    target.innerHTML = `<p class="muted">Loading...</p>`;

    try {
        const results = await Promise.all(
            bots.map(async bot => {
                const result = await api(`/bots/${encodeURIComponent(bot.id)}/deployments`);
                return result.deployments.map(deployment => ({
                    ...deployment,
                    botName: bot.name,
                    botId: bot.id
                }));
            })
        );

        const deployments = results.flat().sort((a, b) =>
            String(b.created_at).localeCompare(String(a.created_at))
        );

        target.innerHTML = deployments.length
            ? deployments.map(item => `
                <div class="deployment-row">
                    <div>
                        <strong>${escapeHTML(item.botName)} — Version ${escapeHTML(item.version)}</strong>
                        <div class="bot-meta">${escapeHTML(item.created_at)}</div>
                    </div>
                    ${statusBadge(item.status)}
                    <button class="small-btn" data-action="rollback"
                        data-id="${escapeHTML(item.botId)}"
                        data-deployment-id="${escapeHTML(item.id)}">
                        Rollback
                    </button>
                </div>
            `).join("")
            : `<p class="muted">No deployments yet.</p>`;
    } catch (error) {
        target.textContent = error.message;
    }
}

async function checkSession() {
    if (!token) {
        showAuth();
        return;
    }

    try {
        const result = await api("/auth/me");
        currentUser = result.user;
        showDashboard();
    } catch {
        logout(false);
    }
}

function closeMobileNav() {
    const dashboard = $("#dashboard");
    const overlay = $("#mobile-nav-overlay");
    const menuButton = $("#mobile-menu-toggle");

    dashboard.classList.remove("mobile-nav-open");

    if (overlay) overlay.classList.add("hidden");

    if (menuButton) {
        menuButton.setAttribute("aria-expanded", "false");
        menuButton.setAttribute("aria-label", "Open navigation");
    }
}

function toggleMobileNav() {
    const dashboard = $("#dashboard");
    const overlay = $("#mobile-nav-overlay");
    const menuButton = $("#mobile-menu-toggle");

    const isOpen = dashboard.classList.toggle("mobile-nav-open");

    if (overlay) overlay.classList.toggle("hidden", !isOpen);

    if (menuButton) {
        menuButton.setAttribute("aria-expanded", String(isOpen));
        menuButton.setAttribute(
            "aria-label",
            isOpen ? "Close navigation" : "Open navigation"
        );
    }
}

document.addEventListener("click", event => {
    const authTab = event.target.closest("[data-auth]");
    if (authTab) setAuthMode(authTab.dataset.auth);

    const nav = event.target.closest("[data-view]");
    if (nav) switchView(nav.dataset.view);
    if (nav) closeMobileNav();

    const close = event.target.closest("[data-close]");
    if (close) $(`#${close.dataset.close}`).classList.add("hidden");

    const detailTab = event.target.closest("[data-detail]");
    if (detailTab) {
        detailMode = detailTab.dataset.detail;
        document.querySelectorAll(".detail-tab").forEach(button => {
            button.classList.toggle("active", button.dataset.detail === detailMode);
        });
        loadDetails();
    }

    const logAction = event.target.closest("[data-log-action]");
    if (logAction) {
        const action = logAction.dataset.logAction;

        if (action === "pause") {
            logAutoRefresh = !logAutoRefresh;
            logAction.textContent = logAutoRefresh ? "Pause" : "Resume";

            const status = $("#log-refresh-status");
            if (status) {
                status.textContent = logAutoRefresh
                    ? "Auto-refresh: ON"
                    : "Auto-refresh: PAUSED";
            }

            if (logAutoRefresh) loadBotLogs();
        } else if (action === "refresh") {
            loadBotLogs();
        } else if (action === "clear") {
            const output = $("#details-content").querySelector(".log-output");
            if (output) output.textContent = "";

            const status = $("#log-refresh-status");
            if (status) status.textContent = "Display cleared; server logs unchanged.";
        }
    }

    const action = event.target.closest("[data-action]");
    if (action) {
        const { id } = action.dataset;

        if (action.dataset.action === "env-delete") {
            deleteBotEnvironmentVariable(action.dataset.name);
        } else if (["start", "stop", "restart"].includes(action.dataset.action)) {
            processAction(id, action.dataset.action);
        } else if (action.dataset.action === "rollback") {
            rollbackBot(id, action.dataset.deploymentId);
        } else if (action.dataset.action === "delete") {
            deleteBot(id);
        } else if (action.dataset.action === "details") {
            openDetails(id, "logs");
        } else if (action.dataset.action === "deployments") {
            openDetails(id, "deployments");
        } else if (action.dataset.action === "upload") {
            document.querySelector(`[data-upload-id="${CSS.escape(id)}"]`).click();
        } else if (action.dataset.action === "support-open") {
            openSupportTicket(id);
        } else if (action.dataset.action === "support-back") {
            closeSupportConversation();
        } else if (action.dataset.action === "support-status") {
            updateSupportTicketStatus();
        }
    }
});


document.addEventListener("submit", async event => {
    if (event.target.id === "startup-config-form") {
        event.preventDefault();

        const startupArgs = $("#startup-args").value
            .split(/\r?\n/)
            .filter(arg => arg.length > 0);

        try {
            await api(`/bots/${encodeURIComponent(activeBotId)}/config/startup`, {
                method: "PUT",
                body: JSON.stringify({ startupArgs })
            });

            notify("Startup arguments saved.");
            await loadDetails();
        } catch (error) {
            notify(error.message);
        }
    }

    if (event.target.id === "environment-config-form") {
        event.preventDefault();

        const name = $("#environment-name").value.trim();
        const value = $("#environment-value").value;

        try {
            await api(`/bots/${encodeURIComponent(activeBotId)}/config/environment`, {
                method: "PUT",
                body: JSON.stringify({
                    variables: { [name]: value }
                })
            });

            notify("Environment variable saved.");
            await loadDetails();
        } catch (error) {
            notify(error.message);
        }
    }
});

document.addEventListener("change", event => {
    if (event.target.matches("[data-upload-id]")) {
        uploadBot(event.target.dataset.uploadId, event.target.files[0]);
        event.target.value = "";
    }
});

$("#auth-form").addEventListener("submit", submitAuth);
$("#verify-email-form").addEventListener("submit", submitVerifyEmail);
$("#resend-verification-code").addEventListener("click", resendVerificationCode);
$("#forgot-password-form").addEventListener("submit", submitForgotPassword);
$("#reset-password-form").addEventListener("submit", submitResetPassword);
$("#change-password-form").addEventListener("submit", submitChangePassword);

$("#forgot-password-link").addEventListener("click", () => {
    $("#forgot-email").value = $("#auth-email").value.trim();
    $("#forgot-error").textContent = "";
    showAuthPanel("forgot");
});

document.querySelectorAll("[data-auth-back]").forEach(button => {
    button.addEventListener("click", () => {
        setAuthMode("login");
    });
});

$("#create-bot-form").addEventListener("submit", createBot);
$("#support-ticket-form").addEventListener("submit", submitSupportTicket);
$("#support-reply-form").addEventListener("submit", submitSupportReply);
$("#refresh-support-tickets").addEventListener("click", loadSupportTickets);

$("#new-bot-btn").addEventListener("click", () => {
    $("#bot-modal").classList.remove("hidden");
});
$("#logout-btn").addEventListener("click", () => logout(true));

$("#mobile-menu-toggle").addEventListener("click", toggleMobileNav);

$("#mobile-nav-overlay").addEventListener("click", closeMobileNav);


$("#theme-select").addEventListener("change", event => {
    currentSettings.theme =
        event.target.value === "light" ? "light" : "dark";

    applySettings();
    showSettingsFeedback("Theme preview changed. Save to keep it.");
});

$("#resource-toggle").addEventListener("change", event => {
    currentSettings.resources = event.target.checked;

    applySettings();
    showSettingsFeedback(
        "Display preference changed. Save to keep it."
    );
});

$("#save-settings").addEventListener("click", saveSettings);
$("#reset-settings").addEventListener("click", resetSettings);


loadSavedSettings();

if (new URLSearchParams(window.location.search).has("token")) {
    showAuth();
    showAuthPanel("reset");
} else {
    checkSession();
}

setInterval(() => {
    if (token && !$("#dashboard").classList.contains("hidden")) {
        loadBots();

    }
}, 10000);


setInterval(() => {
    if (token && !$("#dashboard").classList.contains("hidden")) {
        loadResources();

        if (
            logAutoRefresh &&
            !$("#details-modal").classList.contains("hidden") &&
            detailMode === "logs"
        ) {
            loadBotLogs();
        }
    }
}, 3000);



/* NEXHOST PRIVATE OWNER DASHBOARD */

async function loadOwnerDashboard() {
    if (!currentUser || currentUser.role !== "admin") {
        switchView("overview");
        return;
    }

    const customerList = $("#owner-customers-list");
    const ticketList = $("#owner-tickets-list");

    customerList.innerHTML = '<tr><td colspan="3">Loading customers...</td></tr>';
    ticketList.innerHTML = '<tr><td colspan="6">Loading tickets...</td></tr>';

    try {
        const result = await api("/support/owner/dashboard");
        const stats = result.statistics || {};

        $("#owner-total").textContent = stats.total_tickets || 0;
        $("#owner-open").textContent = stats.open_tickets || 0;
        $("#owner-progress").textContent = stats.in_progress_tickets || 0;
        $("#owner-resolved").textContent = stats.resolved_tickets || 0;
        $("#owner-closed").textContent = stats.closed_tickets || 0;
        $("#owner-customers").textContent = stats.total_customers || 0;

        const dateText = value => {
            if (!value) return "Unavailable";
            const date = new Date(value.replace(" ", "T") + "Z");
            return Number.isNaN(date.getTime())
                ? escapeHTML(value)
                : escapeHTML(date.toLocaleDateString());
        };

        if (!result.customers || !result.customers.length) {
            customerList.innerHTML =
                '<tr><td colspan="3">No customers registered yet.</td></tr>';
        } else {
            customerList.innerHTML = result.customers.map(customer => `
                <tr>
                    <td>${escapeHTML(customer.email)}</td>
                    <td>${dateText(customer.created_at)}</td>
                    <td>${Number(customer.ticket_count) || 0}</td>
                </tr>
            `).join("");
        }

        if (!result.recentTickets || !result.recentTickets.length) {
            ticketList.innerHTML =
                '<tr><td colspan="6">No support tickets yet.</td></tr>';
        } else {
            ticketList.innerHTML = result.recentTickets.map(ticket => `
                <tr>
                    <td>${escapeHTML(ticket.user_email)}</td>
                    <td>${escapeHTML(ticket.subject)}</td>
                    <td>${escapeHTML(ticket.priority)}</td>
                    <td>${supportStatusBadge(ticket.status)}</td>
                    <td>${Number(ticket.message_count) || 0}</td>
                    <td>
                        <button class="secondary-btn owner-open-btn"
                            data-owner-ticket="${escapeHTML(ticket.id)}">
                            Open
                        </button>
                    </td>
                </tr>
            `).join("");
        }

    } catch (error) {
        console.error("[OWNER DASHBOARD]", error);

        customerList.innerHTML =
            '<tr><td colspan="3">Unable to load customers.</td></tr>';

        ticketList.innerHTML =
            '<tr><td colspan="6">Unable to load tickets. Refresh to retry.</td></tr>';
    }
}

document.addEventListener("click", event => {
    const refresh = event.target.closest("[data-owner-refresh]");

    if (refresh) {
        loadOwnerDashboard();
        return;
    }

    const ticketButton = event.target.closest("[data-owner-ticket]");

    if (ticketButton) {
        const ticketId = ticketButton.dataset.ownerTicket;

        switchView("help");
        openSupportTicket(ticketId);
    }
});

/* MOBILE NAVIGATION CONTROLLER */
(() => {
    const menuButton = document.getElementById("mobile-menu-toggle");
    const sidebar = document.getElementById("main-sidebar");
    const backdrop = document.getElementById("sidebar-backdrop");

    if (!menuButton || !sidebar || !backdrop) return;

    function openMobileNav() {
        if (window.innerWidth > 800) return;

        sidebar.classList.add("is-open");
        backdrop.classList.add("is-visible");
        document.body.classList.add("nav-open");

        menuButton.setAttribute("aria-expanded", "true");
        menuButton.setAttribute("aria-label", "Close navigation");
    }

    function closeMobileNav() {
        sidebar.classList.remove("is-open");
        backdrop.classList.remove("is-visible");
        document.body.classList.remove("nav-open");

        menuButton.setAttribute("aria-expanded", "false");
        menuButton.setAttribute("aria-label", "Open navigation");
    }

    menuButton.addEventListener("click", () => {
        if (sidebar.classList.contains("is-open")) {
            closeMobileNav();
        } else {
            openMobileNav();
        }
    });

    backdrop.addEventListener("click", closeMobileNav);

    sidebar.querySelectorAll(".nav-item").forEach(button => {
        button.addEventListener("click", closeMobileNav);
    });

    document.addEventListener("keydown", event => {
        if (event.key === "Escape") closeMobileNav();
    });

    window.addEventListener("resize", () => {
        if (window.innerWidth > 800) closeMobileNav();
    });
})();
