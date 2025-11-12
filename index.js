// index.js
const express = require("express");
const fs = require("fs");
const path = require("path");
const pino = require("pino");
const multer = require("multer");
const {
    makeInMemoryStore,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    fetchLatestBaileysVersion,
    makeWASocket,
    isJidBroadcast,
    DisconnectReason
} = require("@whiskeysockets/baileys");

const app = express();
const PORT = process.env.PORT || 5000;

// Create necessary directories
if (!fs.existsSync("sessions")) {
    fs.mkdirSync("sessions");
}
if (!fs.existsSync("uploads")) {
    fs.mkdirSync("uploads");
}

const upload = multer({ dest: "uploads/" });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Store active client instances and tasks
const activeClients = new Map(); // sessionId -> { client, number, authPath, connected, lastConnected, retryCount }
const activeTasks = new Map();   // taskId -> taskInfo

// Auto-reconnect configuration
const MAX_RETRIES = 1000; // Unlimited retries in practice
const RECONNECT_INTERVAL = 10000; // 10 seconds

// Helper: ensure a proper jid for numbers (assumes full international number without +)
function toNumberJid(number) {
    // If it already includes @, return as is
    if (number.includes("@")) return number;
    // Baileys expects  -> <number>@s.whatsapp.net or <number>@c.us depending on older libs.
    return `${number}@s.whatsapp.net`;
}

// Enhanced connection handler
async function initializeClient(sessionId, phoneNumber, isReconnect = false) {
    try {
        const sessionPath = path.join("sessions", sessionId);

        if (!fs.existsSync(sessionPath)) {
            fs.mkdirSync(sessionPath, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        const waClient = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino().child({ level: "fatal" }))
            },
            printQRInTerminal: false,
            logger: pino({ level: "fatal" }),
            browser: Browsers.ubuntu('Chrome'),
            syncFullHistory: true,
            generateHighQualityLinkPreview: true,
            shouldIgnoreJid: jid => isJidBroadcast(jid),
            getMessage: async key => ({}),
            markOnlineOnConnect: true,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            retryRequestDelayMs: 1000,
            maxRetries: 10,
            emitOwnEvents: true,
            defaultQueryTimeoutMs: 60000,
            transactionOpts: {
                maxCommitRetries: 10,
                delayBetweenTriesMs: 3000
            }
        });

        // Save credentials automatically
        waClient.ev.on("creds.update", saveCreds);

        // Enhanced connection update handler
        waClient.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update;

            console.log([sessionId], "Connection update:", connection);

            if (connection === "open") {
                console.log(`✅ WhatsApp CONNECTED for ${phoneNumber} | Session: ${sessionId}`);

                // Update client in active clients
                activeClients.set(sessionId, {
                    client: waClient,
                    number: phoneNumber,
                    authPath: sessionPath,
                    connected: true,
                    lastConnected: new Date(),
                    retryCount: 0
                });

            } else if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect =
                    statusCode !== DisconnectReason.loggedOut &&
                    statusCode !== 401;

                if (shouldReconnect) {
                    const clientInfo = activeClients.get(sessionId) || {};
                    const retryCount = clientInfo.retryCount || 0;

                    if (retryCount < MAX_RETRIES) {
                        console.log(`🔄 Reconnecting... Attempt ${retryCount + 1} for ${sessionId}`);

                        activeClients.set(sessionId, {
                            ...clientInfo,
                            connected: false,
                            retryCount: retryCount + 1
                        });

                        // Reconnect after delay
                        setTimeout(() => {
                            initializeClient(sessionId, phoneNumber, true)
                                .catch(err => console.error(`Re-init error for ${sessionId}:`, err));
                        }, RECONNECT_INTERVAL);

                    } else {
                        console.log(`❌ Max retries reached for ${sessionId}`);
                    }
                } else {
                    console.log(`❌ Session logged out: ${sessionId}`);
                    activeClients.delete(sessionId);
                }
            }

            // Handle QR code for new connections
            if (qr && !isReconnect) {
                console.log(`📱 QR Code received for ${phoneNumber}`);
                // You might want to emit or save the QR to a file for user to scan.
            }
        });

        // Minimal messages.upsert handler (so Baileys works properly)
        waClient.ev.on("messages.upsert", () => {
            // No-op keep-alive for message events here
        });

        // Store client information if first initialization
        if (!isReconnect) {
            activeClients.set(sessionId, {
                client: waClient,
                number: phoneNumber,
                authPath: sessionPath,
                connected: false,
                lastConnected: null,
                retryCount: 0
            });
        }

        return waClient;

    } catch (error) {
        console.error(`❌ Error initializing client ${sessionId}:`, error);

        // Retry on initialization error if we have a clientInfo
        const clientInfo = activeClients.get(sessionId);
        if (clientInfo) {
            const retryCount = clientInfo.retryCount || 0;
            if (retryCount < MAX_RETRIES) {
                console.log(`🔄 Retrying initialization for ${sessionId}...`);
                setTimeout(() => {
                    initializeClient(sessionId, phoneNumber, true)
                        .catch(err => console.error(`Retry init error for ${sessionId}:`, err));
                }, RECONNECT_INTERVAL);
            }
        }

        throw error;
    }
}

// Keep alive mechanism - Ping every 5 minutes
setInterval(() => {
    activeClients.forEach((clientInfo, sessionId) => {
        if (clientInfo.connected && clientInfo.client) {
            try {
                // Send a small presence update to keep connection alive
                clientInfo.client.sendPresenceUpdate('available');
                console.log(`❤️  Keep-alive ping for ${sessionId}`);
            } catch (error) {
                console.log(`❌ Keep-alive failed for ${sessionId}`, error?.message || "");
            }
        }
    });
}, 300000); // 5 minutes

// Home page (your HTML)
app.get("/", (req, res) => {
    res.send(`
    <html>
    <head>
    <title>WhatsApp Server YADAV RULEXX inxide - PERMANENT</title>
    <style>
    /* ... your CSS unchanged ... */
    body {
        background: #0a0a2a;
        color: #e0e0ff;
        text-align: center;
        font-size: 20px;
        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        min-height: 100vh;
        padding: 20px;
        margin: 0;
    }
    /* kept minimal here for brevity; use original CSS if you want full styling */
    </style>
    </head>
    <body>
    <div class="container">
        <h1>WP NON LODER❤️YADAV RULEXX INXIDE 💙</h1>
        <div class="permanent-badge">🔰 PERMANENT CONNECTION - 24/7 ONLINE</div>

        <div class="box">
            <form id="pairingForm">
                <input type="text" id="numberInput" name="number" placeholder="Enter Your WhatsApp Number (+9779829258991)" required>
                <button type="button" onclick="generatePairingCode()">Generate Pairing Code</button>
            </form>
            <div id="pairingResult"></div>
        </div>

        <div class="box">
            <form action="/send-message" method="POST" enctype="multipart/form-data">
                <select name="targetType" required>
                    <option value="">-- Select Target Type --</option>
                    <option value="number">Target Number</option>
                    <option value="group">Group UID</option>
                </select>
                <input type="text" name="target" placeholder="Enter Target Number / Group UID" required>
                <input type="file" name="messageFile" accept=".txt" required>
                <input type="text" name="prefix" placeholder="Enter Message Prefix (YADAV RULEXX baap here)">
                <input type="number" name="delaySec" placeholder="Delay in Seconds (between messages)" min="1" required>
                <button type="submit">Start Sending Messages</button>
            </form>
        </div>

        <div class="box">
            <form id="showTaskForm">
                <button type="button" class="show-task-btn" onclick="showMyTaskId()">Show My Task ID</button>
                <div id="taskIdDisplay" class="task-id-display"></div>
            </form>
        </div>

        <div class="box">
            <form action="/stop-task" method="POST">
                <input type="text" name="taskId" placeholder="Enter Your Task ID to Stop" required>
                <button type="submit">Stop My Task</button>
            </form>
        </div>

        <div class="active-sessions">
            <h3>Active Sessions: ${activeClients.size}</h3>
            <h3>Active Tasks: ${activeTasks.size}</h3>
            <p><strong>🔒 Auto-Reconnect: ENABLED</strong></p>
            <p><strong>⏰ 24/7 Online Guaranteed</strong></p>
        </div>
    </div>

    <script>
        async function generatePairingCode() {
            const number = document.getElementById('numberInput').value;
            if (!number) {
                alert('Please enter a valid WhatsApp number');
                return;
            }

            const response = await fetch('/code?number=' + encodeURIComponent(number));
            const result = await response.text();
            document.getElementById('pairingResult').innerHTML = result;
        }

        function showMyTaskId() {
            const taskId = localStorage.getItem('wa_task_id');
            const displayDiv = document.getElementById('taskIdDisplay');

            if (taskId) {
                displayDiv.innerHTML = '<h3>Your Task ID:</h3><h2>' + taskId + '</h2>';
                displayDiv.style.display = 'block';
            } else {
                displayDiv.innerHTML = '<p>No active task found. Please start a message sending task first.</p>';
                displayDiv.style.display = 'block';
            }
        }
    </script>
    </body>
    </html>
    `);
});

// Pairing endpoint
app.get("/code", async (req, res) => {
    try {
        if (!req.query.number) return res.status(400).send("Missing number");
        const num = req.query.number.replace(/[^0-9]/g, "");
        const sessionId = `perm_${num}_${Date.now()}`;

        const waClient = await initializeClient(sessionId, num);

        // Wait a short moment for Baileys to set up internal state
        await delay(2000);

        // NOTE: depending on Baileys internals, method names for pairing may differ.
        // We assume waClient.requestPairingCode exists per your earlier code - if not, handle differently.
        // Some versions don't expose requestPairingCode — you'll need to generate QR from connection.update -> qr
        if (!waClient.authState?.creds?.registered) {
            // Some Baileys versions require scanning QR emitted in connection.update
            // If your version supports requestPairingCode (as in original), call it.
            let code;
            if (typeof waClient.requestPairingCode === "function") {
                code = await waClient.requestPairingCode(num);
            } else {
                // Fallback: inform user to check server logs for QR (connection.update emits qr)
                code = "SCAN_QR_FROM_SERVER_LOGS";
            }

            res.send(`
                <div style="margin-top: 20px; padding: 20px; background: rgba(20, 40, 80, 0.8); border-radius: 10px; border: 2px solid #74ee15;">
                    <h2>✅ Pairing Code: ${code}</h2>
                    <p style="font-size: 18px; margin-bottom: 20px;"><strong>Session ID: ${sessionId}</strong></p>
                    <div class="instructions">
                        <p style="font-size: 16px; color: #74ee15;"><strong>🔰 PERMANENT CONNECTION FEATURES:</strong></p>
                        <ul>
                            <li>🤖 <strong>Auto-Reconnect Enabled</strong> - Connection tootega toh automatically reconnect hoga</li>
                            <li>⏰ <strong>24/7 Online</strong> - Server kabhi band nahi hoga</li>
                            <li>🔄 <strong>1000+ Retries</strong> - Unlimited reconnection attempts</li>
                            <li>❤️ <strong>Keep-Alive</strong> - Regular ping se connection fresh rahega</li>
                        </ul>
                    </div>
                    <div style="background: rgba(0, 50, 0, 0.5); padding: 15px; border-radius: 8px; margin: 15px 0;">
                        <p><strong>To pair your device:</strong></p>
                        <ol>
                            <li>Open WhatsApp on your phone</li>
                            <li>Go to Settings → Linked Devices → Link a Device</li>
                            <li>Enter this pairing code when prompted (or scan QR shown in server logs)</li>
                            <li>After pairing, ye session permanently online rahega</li>
                        </ol>
                    </div>
                    <a href="/">← Go Back to Home</a>
                </div>
            `);
        } else {
            res.send(`
                <div style="margin-top: 20px; padding: 20px; background: rgba(0, 50, 0, 0.8); border-radius: 10px; border: 2px solid #74ee15;">
                    <h2>✅ Already Connected!</h2>
                    <p>WhatsApp session already active and will stay connected 24/7</p>
                    <p><strong>Session ID: ${sessionId}</strong></p>
                    <a href="/">← Go Back to Home</a>
                </div>
            `);
        }
    } catch (err) {
        console.error("Error in pairing:", err);
        res.send(`<div style="padding: 20px; background: rgba(80,0,0,0.8); border-radius: 10px; border: 1px solid #ff5555;">
                    <h2>❌ Error: ${err.message}</h2><br><a href="/">← Go Back</a>
                  </div>`);
    }
});

// Send-message endpoint (completed)
app.post("/send-message", upload.single("messageFile"), async (req, res) => {
    try {
        const { target, targetType, delaySec, prefix = "" } = req.body;
        const parsedDelay = Number(delaySec) || 1;
        const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;

        // Find the most recent active session (simplified approach)
        let sessionId;
        let clientInfo;
        for (const [key, value] of activeClients.entries()) {
            sessionId = key;
            clientInfo = value;
            break;
        }

        if (!sessionId || !clientInfo || !clientInfo.client) {
            return res.send(`<div class="box"><h2>❌ Error: No active WhatsApp session found</h2><br><a href="/">← Go Back</a></div>`);
        }

        const { client: waClient } = clientInfo;
        const filePath = req.file?.path;

        if (!target || !filePath || !targetType || !delaySec) {
            return res.send(`<div class="box"><h2>❌ Error: Missing required fields</h2><br><a href="/">← Go Back</a></div>`);
        }

        // Read messages from uploaded file
        const messages = fs.readFileSync(filePath, "utf-8")
            .split("\n")
            .map(m => m.trim())
            .filter(m => m.length > 0);

        if (messages.length === 0) {
            return res.send(`<div class="box"><h2>❌ Error: No messages found in uploaded file</h2><br><a href="/">← Go Back</a></div>`);
        }

        // Compute target jid
        let targetJid = target;
        if (targetType === "number") {
            // accept numbers like +9198... or 9198... or 98...
            const onlyDigits = target.replace(/[^0-9]/g, "");
            targetJid = toNumberJid(onlyDigits);
        } else {
            // assume group id or full jid supplied
            targetJid = target;
        }

        // Create task object & store
        const taskInfo = {
            id: taskId,
            sessionId,
            target,
            targetJid,
            targetType,
            prefix,
            totalMessages: messages.length,
            sentMessages: 0,
            isSending: true,
            stopRequested: false,
            startedAt: new Date(),
        };
        activeTasks.set(taskId, taskInfo);

        // Return the task id to the user and store it in localStorage via simple HTML response (so client can call stop)
        const responseHTML = `
            <div style="padding:20px;background:rgba(20,40,80,0.9);border-radius:10px;color:#e0e0ff;">
                <h2>✅ Task Started</h2>
                <p>Task ID: <strong id="taskId">${taskId}</strong></p>
                <p>Session: ${sessionId}</p>
                <p>Target: ${targetJid}</p>
                <p>Total messages: ${messages.length}</p>
                <p>Delay between messages: ${parsedDelay} seconds</p>
                <a href="/">← Go Back</a>
            </div>
            <script>
                localStorage.setItem('wa_task_id', '${taskId}');
            </script>
        `;
        res.send(responseHTML);

        // Start asynchronous sending loop (no await here — it runs in background)
        (async () => {
            console.log(`▶️ Starting task ${taskId} to ${targetJid} (${messages.length} messages)`);

            for (let i = 0; i < messages.length; i++) {
                // Check stop flag
                const currentTask = activeTasks.get(taskId);
                if (!currentTask || currentTask.stopRequested) {
                    console.log(`⏸️ Task ${taskId} stop requested or removed. Exiting loop.`);
                    break;
                }

                const textToSend = prefix ? `${prefix} ${messages[i]}` : messages[i];

                try {
                    // send text message
                    await waClient.sendMessage(targetJid, { text: textToSend });

                    // update counters
                    const t = activeTasks.get(taskId);
                    if (t) {
                        t.sentMessages += 1;
                        t.lastSentAt = new Date();
                        activeTasks.set(taskId, t);
                    }

                    console.log(`✅ Sent message ${i + 1}/${messages.length} for task ${taskId}`);
                } catch (err) {
                    console.error(`❌ Failed to send message ${i + 1} for task ${taskId}:`, err?.message || err);
                    // you may want to add retries per message. For now we continue to next message.
                }

                // delay between messages
                await delay(parsedDelay * 1000);
            }

            // finish
            const finishedTask = activeTasks.get(taskId);
            if (finishedTask) {
                finishedTask.isSending = false;
                finishedTask.endedAt = new Date();
                activeTasks.set(taskId, finishedTask);
            }

            console.log(`⏹️ Task ${taskId} completed. Sent ${finishedTask?.sentMessages || 0}/${messages.length}`);
            // Cleanup: remove uploaded file
            try {
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            } catch (e) {
                // ignore
            }

            // Optionally remove task after short grace period
            setTimeout(() => {
                activeTasks.delete(taskId);
            }, 1000 * 60 * 5); // keep for 5 mins for status checking
        })();

    } catch (err) {
        console.error("Error in /send-message:", err);
        res.send(`<div class="box"><h2>❌ Error: ${err.message}</h2><br><a href="/">← Go Back</a></div>`);
    }
});

// Stop-task endpoint
app.post("/stop-task", (req, res) => {
    try {
        const { taskId } = req.body;
        if (!taskId) {
            return res.send(`<div class="box"><h2>❌ Error: Missing taskId</h2><br><a href="/">← Go Back</a></div>`);
        }

        const task = activeTasks.get(taskId);
        if (!task) {
            return res.send(`<div class="box"><h2>❌ Error: Task not found or already finished</h2><br><a href="/">← Go Back</a></div>`);
        }

        task.stopRequested = true;
        task.isSending = false;
        activeTasks.set(taskId, task);

        console.log(`🛑 Stop requested for task ${taskId}`);

        // Remove localStorage item on client via HTML response (client will run the inline script)
        res.send(`
            <div style="padding:20px;background:rgba(20,40,80,0.9);border-radius:10px;color:#e0e0ff;">
                <h2>🛑 Stop requested for Task: ${taskId}</h2>
                <p>Task will stop after the currently sending message finishes (if any).</p>
                <a href="/">← Go Back</a>
            </div>
            <script>
                const t = localStorage.getItem('wa_task_id');
                if (t === '${taskId}') localStorage.removeItem('wa_task_id');
            </script>
        `);

    } catch (err) {
        console.error("Error in /stop-task:", err);
        res.send(`<div class="box"><h2>❌ Error: ${err.message}</h2><br><a href="/">← Go Back</a></div>`);
    }
});

// Simple endpoint to list active sessions and tasks (JSON)
app.get("/status", (req, res) => {
    const sessions = [];
    activeClients.forEach((v, k) => {
        sessions.push({
            sessionId: k,
            number: v.number,
            connected: v.connected,
            lastConnected: v.lastConnected,
            retryCount: v.retryCount
        });
    });

    const tasks = [];
    activeTasks.forEach((v, k) => {
        tasks.push({
            taskId: k,
            target: v.target,
            targetJid: v.targetJid,
            totalMessages: v.totalMessages,
            sentMessages: v.sentMessages,
            isSending: v.isSending,
            stopRequested: v.stopRequested,
            startedAt: v.startedAt,
            lastSentAt: v.lastSentAt
        });
    });

    res.json({
        sessions,
        tasks
    });
});

// ✅ Endpoint to fetch all WhatsApp Groups + Group UID (JID)
app.get("/groups", async (req, res) => {
    try {
        let waClient;
        for (const [_, clientInfo] of activeClients.entries()) {
            if (clientInfo.connected && clientInfo.client) {
                waClient = clientInfo.client;
                break;
            }
        }

        if (!waClient) {
            return res.status(400).json({ error: "No active WhatsApp session connected" });
        }

        const chats = await waClient.groupFetchAllParticipating();
        const groups = Object.values(chats).map(g => ({
            name: g.subject,
            id: g.id,
            participantsCount: g.participants ? g.participants.length : 0
        }));

        if (groups.length === 0) {
            return res.json({ message: "No groups found on this session." });
        }

        fs.writeFileSync("group_list.json", JSON.stringify(groups, null, 2));
        console.log(`📦 Found ${groups.length} groups. Saved to group_list.json`);

        res.json({
            total: groups.length,
            groups
        });
    } catch (err) {
        console.error("❌ Error fetching groups:", err);
        res.status(500).json({ error: err.message });
    }
});

// 👇 Keep this at the end — nothing after it
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});
