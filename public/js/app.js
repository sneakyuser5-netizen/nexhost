const API = "/api";
const TOKEN_KEY = "nexhost_token";

let token = localStorage.getItem(TOKEN_KEY);
let currentUser = null;
let bots = [];
let authMode = "login";
let activeBotId = null;
let detailMode = "logs";
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

function showDashboard() {
    $("#auth-screen").classList.add("hidden");
    $("#dashboard").classList.remove("hidden");
    $("#user-email").textContent = currentUser.email;
    $("#page-title").textContent = "Overview";
    loadBots();
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

        token = result.token;
        currentUser = result.user;
        localStorage.setItem(TOKEN_KEY, token);

        $("#auth-form").reset();
        showDashboard();
        notify(authMode === "login" ? "Welcome back!" : "Account created!");
    } catch (error) {
        $("#auth-error").textContent = error.message;
    } finally {
        $("#auth-submit").disabled = false;
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
        deployments: "Deployments"
    };

    $("#page-title").textContent = titles[view] || "Overview";

    if (view === "deployments") loadAllDeployments();
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

    if (!target || resourceRequestRunning) return;

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

async function loadDetails() {
    const target = $("#details-content");
    target.innerHTML = `<p class="muted">Loading...</p>`;

    try {
        if (detailMode === "logs") {
            const result = await api(`/bots/${encodeURIComponent(activeBotId)}/logs`);
            target.innerHTML = `<pre class="log-output">${escapeHTML(result.logs || "No logs available.")}</pre>`;
        } else {
            const result = await api(`/bots/${encodeURIComponent(activeBotId)}/deployments`);
            target.innerHTML = result.deployments.length
                ? result.deployments.map(deployment => `
                    <div class="deployment-row">
                        <div>
                            <strong>Version ${escapeHTML(deployment.version)}</strong>
                            <div class="bot-meta">${escapeHTML(deployment.created_at)}</div>
                        </div>
                        ${statusBadge(deployment.status)}
                    </div>
                `).join("")
                : `<p class="muted">No deployments found.</p>`;
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
                    botName: bot.name
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

document.addEventListener("click", event => {
    const authTab = event.target.closest("[data-auth]");
    if (authTab) setAuthMode(authTab.dataset.auth);

    const nav = event.target.closest("[data-view]");
    if (nav) switchView(nav.dataset.view);

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

    const action = event.target.closest("[data-action]");
    if (action) {
        const { id } = action.dataset;

        if (["start", "stop", "restart"].includes(action.dataset.action)) {
            processAction(id, action.dataset.action);
        } else if (action.dataset.action === "delete") {
            deleteBot(id);
        } else if (action.dataset.action === "details") {
            openDetails(id, "logs");
        } else if (action.dataset.action === "deployments") {
            openDetails(id, "deployments");
        } else if (action.dataset.action === "upload") {
            document.querySelector(`[data-upload-id="${CSS.escape(id)}"]`).click();
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
$("#create-bot-form").addEventListener("submit", createBot);
$("#new-bot-btn").addEventListener("click", () => {
    $("#bot-modal").classList.remove("hidden");
});
$("#logout-btn").addEventListener("click", () => logout(true));

checkSession();

setInterval(() => {
    if (token && !$("#dashboard").classList.contains("hidden")) {
        loadBots();

        if (!$("#details-modal").classList.contains("hidden") && detailMode === "logs") {
            loadDetails();
        }
    }
}, 10000);


setInterval(() => {
    if (token && !$("#dashboard").classList.contains("hidden")) {
        loadResources();
    }
}, 3000);
