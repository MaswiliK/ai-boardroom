// frontend/app.js
// ==================== CONFIGURATION ====================
const AGENT_ID = "25377ee6-17a7-4f62-9953-7b583a8b2760"; // Replace with your agent ID
const API_BASE = '/api/voice';
const WS_BASE = location.protocol === 'https:' ? 'wss://' : 'ws://' + location.host;

// VAD tuning
const VAD_ENERGY_THRESHOLD = 0.01;   // RMS threshold to consider as speech
const VAD_SPEECH_HOLD_MS   = 400;    // keep "speaking" state this long after energy drops

// Latency dashboard — rolling window size
const LATENCY_WINDOW = 10;

// ==================== STATE ====================
const appState = {
    status: 'idle',           // idle, connecting, live, listening, thinking, speaking, error
    retryCount: 0,
    maxRetries: 3,
    socket: null,
    sessionId: null,
    callId: null,
    serverUrl: null,
    participantToken: null,
    sdkClient: null,
    connectionTimeout: null,
    retryTimer: null,
    watchdogTimer: null,

    // Audio
    audioContext: null,
    analyser: null,
    micStream: null,
    animationFrame: null,
    currentAudioSource: null,  // Enhancement 3: track playing source for interruption

    // Enhancement 1 — Streaming transcript
    partialMsgEl: null,        // live DOM element being updated with partial tokens

    // Enhancement 2 — VAD
    vadActive: false,          // true when speech currently detected

    // Enhancement 4 — Sticky session reconnect
    isReconnect: false,

    // Enhancement 5 — Latency dashboard
    lastLatency: null,
    networkLatencyHistory: [],     // rolling RTT samples (ping/pong)
    processingLatencyHistory: [],  // rolling processing latency from backend
    pingInterval: null,
    pingTimestamp: null,
};

// DOM shortcuts
const dom = {
    loadingOverlay:        document.getElementById('loadingOverlay'),
    retryAlert:            document.getElementById('retryAlert'),
    retryMessage:          document.getElementById('retryMessage'),
    retryCountdown:        document.getElementById('retryCountdown'),
    reconnectBtn:          document.getElementById('reconnectBtn'),
    connectionBadge:       document.getElementById('connectionBadge'),
    orb:                   document.getElementById('orb'),
    orbLabel:              document.getElementById('orbLabel'),
    startCallBtn:          document.getElementById('startCallBtn'),
    endCallBtn:            document.getElementById('endCallBtn'),
    transcriptBody:        document.getElementById('transcriptBody'),
    clearTranscriptBtn:    document.getElementById('clearTranscriptBtn'),
    latencyBadge:          document.getElementById('latencyBadge'),
    // Enhancement 5: health dashboard panels (add matching ids to index.html)
    dashNetworkLatency:    document.getElementById('dashNetworkLatency'),
    dashProcessingLatency: document.getElementById('dashProcessingLatency'),
    dashAvgLatency:        document.getElementById('dashAvgLatency'),
    dashVadStatus:         document.getElementById('dashVadStatus'),
};

// ==================== HELPERS ====================
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withBackoff(fn, attempts = 3, delays = [1000, 2000, 4000]) {
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (err) {
            if (i === attempts - 1) throw err;
            await sleep(delays[i] || 1000);
        }
    }
}

function rollingAvg(arr) {
    if (!arr.length) return 0;
    return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

function pushLatencySample(arr, value) {
    arr.push(value);
    if (arr.length > LATENCY_WINDOW) arr.shift();
}

function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ==================== UI HELPERS ====================
function setConnectionBadge(state) {
    const badge = dom.connectionBadge;
    badge.className = 'badge px-3 py-2 rounded-pill glow-badge ';
    if (['live','listening','thinking','speaking'].includes(state)) {
        badge.classList.add('bg-success-subtle', 'text-success');
        badge.innerHTML = `<span class="live-indicator"></span> Live`;
    } else if (state === 'connecting') {
        badge.classList.add('bg-warning-subtle', 'text-warning');
        badge.innerHTML = `<span class="live-indicator connecting"></span> Connecting`;
    } else if (state === 'error') {
        badge.classList.add('bg-danger-subtle', 'text-danger');
        badge.innerHTML = `<span class="live-indicator disconnected"></span> Disconnected`;
    } else {
        badge.classList.add('bg-secondary-subtle', 'text-secondary');
        badge.innerHTML = `<span class="live-indicator disconnected"></span> Disconnected`;
    }
}

function setOrbState(state) {
    dom.orb.classList.remove('idle', 'listening', 'thinking', 'speaking');
    dom.orb.classList.add(state);
    const labels = {
        idle: 'Idle', listening: 'Listening…',
        thinking: 'Strategizing…', speaking: 'Speaking'
    };
    dom.orbLabel.textContent = labels[state] || 'Idle';
}

function showLoadingOverlay(show) {
    dom.loadingOverlay.classList.toggle('d-none', !show);
}

function showRetryAlert(show, message = '', countdown = null) {
    if (show) {
        dom.retryAlert.classList.remove('d-none');
        dom.retryMessage.innerHTML = message;
        if (countdown !== null) dom.retryCountdown.textContent = countdown;
    } else {
        dom.retryAlert.classList.add('d-none');
    }
}

// ==================== ENHANCEMENT 1 — STREAMING TRANSCRIPT ====================
// Partial bubbles show tokens as they arrive; committing finalises the bubble.

function updatePartialTranscript(sender, partialText) {
    const placeholder = dom.transcriptBody.querySelector('.text-secondary.text-center');
    if (placeholder) placeholder.remove();

    if (!appState.partialMsgEl) {
        appState.partialMsgEl = document.createElement('div');
        appState.partialMsgEl.className =
            `message ${sender === 'user' ? 'user-message' : 'ai-message'} mb-2 p-2 rounded partial-message`;
        dom.transcriptBody.appendChild(appState.partialMsgEl);
    }

    // Blinking cursor signals the stream is live
    appState.partialMsgEl.innerHTML =
        `${escapeHtml(partialText)}<span class="streaming-cursor">▍</span>`;
    dom.transcriptBody.scrollTop = dom.transcriptBody.scrollHeight;
}

function commitPartialTranscript(sender, finalText) {
    if (appState.partialMsgEl) {
        appState.partialMsgEl.classList.remove('partial-message');
        appState.partialMsgEl.textContent = finalText; // strip cursor span
        appState.partialMsgEl = null;
    } else {
        addTranscriptMessage(sender, finalText);
    }
    dom.transcriptBody.scrollTop = dom.transcriptBody.scrollHeight;
}

function addTranscriptMessage(sender, text) {
    // Discard any lingering partial bubble
    if (appState.partialMsgEl) {
        appState.partialMsgEl.remove();
        appState.partialMsgEl = null;
    }
    const placeholder = dom.transcriptBody.querySelector('.text-secondary.text-center');
    if (placeholder) placeholder.remove();

    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${sender === 'user' ? 'user-message' : 'ai-message'} mb-2 p-2 rounded`;
    msgDiv.textContent = text;
    dom.transcriptBody.appendChild(msgDiv);
    dom.transcriptBody.scrollTop = dom.transcriptBody.scrollHeight;
}

function clearTranscript() {
    appState.partialMsgEl = null;
    dom.transcriptBody.innerHTML =
        `<div class="text-secondary text-center small py-4">No messages yet. Start a session.</div>`;
}

// ==================== ENHANCEMENT 5 — LATENCY / HEALTH DASHBOARD ====================
function updateLatencyBadge(ms) {
    let colorClass = 'text-success';
    if (ms > 600) colorClass = 'text-danger';
    else if (ms > 300) colorClass = 'text-warning';
    dom.latencyBadge.innerHTML = `Latency: <span class="${colorClass}">${ms}ms</span>`;
}

function colorFor(ms) {
    if (!ms) return 'text-secondary';
    return ms > 600 ? 'text-danger' : ms > 300 ? 'text-warning' : 'text-success';
}

function updateDashboard() {
    const avgNet  = rollingAvg(appState.networkLatencyHistory);
    const avgProc = rollingAvg(appState.processingLatencyHistory);
    const combined = [...appState.networkLatencyHistory, ...appState.processingLatencyHistory];
    const avgAll  = rollingAvg(combined);

    const fmt = (v) => v ? `<span class="${colorFor(v)}">${v}ms</span>` : `<span class="text-secondary">—</span>`;

    if (dom.dashNetworkLatency)    dom.dashNetworkLatency.innerHTML    = fmt(avgNet);
    if (dom.dashProcessingLatency) dom.dashProcessingLatency.innerHTML = fmt(avgProc);
    if (dom.dashAvgLatency)        dom.dashAvgLatency.innerHTML        = fmt(avgAll);
    if (dom.dashVadStatus) {
        dom.dashVadStatus.innerHTML = appState.vadActive
            ? `<span class="text-success fw-semibold">● Speech</span>`
            : `<span class="text-secondary">○ Silence</span>`;
    }
}

// Ping loop — measures network RTT over the open WebSocket every 3 s
function startPingLoop() {
    stopPingLoop();
    appState.pingInterval = setInterval(() => {
        if (!appState.socket || appState.socket.readyState !== WebSocket.OPEN) return;
        appState.pingTimestamp = performance.now();
        appState.socket.send(JSON.stringify({ type: 'ping' }));
    }, 3000);
}

function stopPingLoop() {
    if (appState.pingInterval) {
        clearInterval(appState.pingInterval);
        appState.pingInterval = null;
    }
}

// ==================== RENDER STATE ====================
function renderState() {
    setConnectionBadge(appState.status);

    const isActive = !['idle', 'error'].includes(appState.status);
    dom.endCallBtn.classList.toggle('d-none', !isActive);
    dom.startCallBtn.classList.toggle('d-none', isActive);
    dom.startCallBtn.disabled = (appState.status === 'connecting');

    if (['listening','thinking','speaking'].includes(appState.status)) {
        setOrbState(appState.status);
    } else if (appState.status === 'live') {
        setOrbState('listening');
    } else {
        setOrbState('idle');
    }

    updateDashboard(); // Enhancement 5
}

// ==================== API CALLS ====================
async function checkAgentStatus() {
    const resp = await fetch(`${API_BASE}/agent-status/${AGENT_ID}`);
    if (!resp.ok) throw new Error(`Agent status check failed (${resp.status})`);
    return resp.json();
}

async function requestConnection() {
    const resp = await fetch(`${API_BASE}/connection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: AGENT_ID, metadata: {} })
    });
    if (resp.status === 402) throw new Error('Insufficient credits – contact admin');
    if (!resp.ok) throw new Error(`Connection request failed (${resp.status})`);
    return resp.json();
}

async function endCallOnServer() {
    if (!appState.callId) return;
    try {
        await fetch(`${API_BASE}/calls/${appState.callId}/end`, { method: 'POST' });
    } catch (e) {
        console.warn('End call API failed', e);
    }
}

// ==================== WATCHDOG ====================
function startWatchdog() {
    clearWatchdog();
    appState.watchdogTimer = setTimeout(() => {
        console.warn('Watchdog timeout – no response');
        if (appState.socket && appState.socket.readyState === WebSocket.OPEN) {
            appState.socket.close(4000, 'Watchdog timeout');
        }
        handleConnectionFailure();
    }, 10000);
}

function clearWatchdog() {
    if (appState.watchdogTimer) {
        clearTimeout(appState.watchdogTimer);
        appState.watchdogTimer = null;
    }
}

function resetRetryState() {
    appState.retryCount = 0;
    if (appState.retryTimer) {
        clearTimeout(appState.retryTimer);
        appState.retryTimer = null;
    }
}

function handleConnectionFailure() {
    if (appState.status === 'idle' || appState.status === 'error') return;
    appState.status = 'error';
    renderState();
    setOrbState('idle');
    clearWatchdog();
    stopPingLoop();
    showLoadingOverlay(false);

    if (appState.retryCount < appState.maxRetries) {
        const delay = Math.pow(2, appState.retryCount) * 1000;
        appState.retryCount++;
        let countdown = delay / 1000;
        showRetryAlert(true, `Connection lost. Retrying in ${countdown}s…`, countdown);

        const interval = setInterval(() => {
            countdown--;
            if (countdown >= 0) dom.retryCountdown.textContent = countdown;
            else clearInterval(interval);
        }, 1000);

        appState.retryTimer = setTimeout(() => {
            clearInterval(interval);
            showRetryAlert(false);
            appState.isReconnect = true; // Enhancement 4
            connectWebSocket();
        }, delay);
    } else {
        showRetryAlert(true, 'Unable to connect. Please try again.');
        dom.reconnectBtn.classList.remove('d-none');
        dom.retryCountdown.parentElement.classList.add('d-none');
    }
}

// ==================== WEBSOCKET ====================
function connectWebSocket() {
    if (!appState.sessionId) { console.error('No session ID'); return; }
    if (appState.socket && appState.socket.readyState === WebSocket.OPEN) return;

    if (appState.socket) {
        appState.socket.onclose = null;
        appState.socket.close();
        appState.socket = null;
    }

    appState.status = 'connecting';
    renderState();
    showLoadingOverlay(true);
    setOrbState('idle');
    dom.reconnectBtn.classList.add('d-none');
    showRetryAlert(false);

    const wsUrl = `${WS_BASE}/api/voice/stream`;
    try {
        appState.socket = new WebSocket(wsUrl);
        appState.socket.binaryType = 'arraybuffer';
    } catch (e) {
        console.error('WebSocket creation failed', e);
        handleConnectionFailure();
        return;
    }

    appState.socket.onopen = () => {
        console.log('WebSocket connected');

        // Enhancement 4 — Sticky session: include session_id + reconnect flag so the
        // backend can resume the existing session instead of creating a new one.
        appState.socket.send(JSON.stringify({
            server_url:        appState.serverUrl,
            participant_token: appState.participantToken,
            call_id:           appState.callId,
            session_id:        appState.sessionId,   // sticky-session key
            reconnect:         appState.isReconnect, // hint to backend
        }));

        appState.isReconnect = false;
        appState.status      = 'live';
        appState.retryCount  = 0;
        renderState();
        showLoadingOverlay(false);
        startWatchdog();
        startPingLoop(); // Enhancement 5
    };

    appState.socket.onmessage = (event) => {
        startWatchdog();

        if (typeof event.data === 'string') {
            try {
                const data = JSON.parse(event.data);

                // Enhancement 5 — pong: measure network RTT
                if (data.type === 'pong' && appState.pingTimestamp) {
                    const rtt = Math.round(performance.now() - appState.pingTimestamp);
                    appState.pingTimestamp = null;
                    pushLatencySample(appState.networkLatencyHistory, rtt);
                    updateDashboard();
                    return;
                }

                if (data.type === 'state') {
                    if (['listening','thinking','speaking'].includes(data.state)) {
                        appState.status = data.state;
                    }
                    renderState();

                // Enhancement 1 — partial token: update streaming bubble
                } else if (data.type === 'partial') {
                    updatePartialTranscript(data.sender, data.text);

                // Final message: commit (or create) the bubble
                } else if (data.type === 'message') {
                    commitPartialTranscript(data.sender, data.text);

                } else if (data.type === 'latency') {
                    appState.lastLatency = data.latency;
                    updateLatencyBadge(data.latency);
                    // Enhancement 5: feed into processing history
                    pushLatencySample(appState.processingLatencyHistory, data.latency);
                    updateDashboard();
                }
            } catch (e) {
                console.warn('Non-JSON string message', event.data);
            }
        } else {
            // Binary audio chunk from backend
            playIncomingAudio(event.data);
        }
    };

    appState.socket.onerror  = (err)   => console.error('WebSocket error', err);
    appState.socket.onclose  = (event) => {
        console.log('WebSocket closed', event.code);
        clearWatchdog();
        stopPingLoop();
        if (appState.status !== 'idle') handleConnectionFailure();
    };
}

function disconnectWebSocket() {
    if (appState.socket) {
        appState.socket.onclose = null;
        appState.socket.close();
        appState.socket = null;
    }
    resetRetryState();
    stopPingLoop();
    showRetryAlert(false);
    showLoadingOverlay(false);
    appState.status = 'idle';
    renderState();
    clearTranscript();
}

// ==================== ENHANCEMENT 3 — INTERRUPTIBLE AI ====================
// Immediately stops the TTS audio source and notifies the backend when the
// user begins speaking while the AI is in the 'speaking' state.

function interruptAI() {
    if (appState.currentAudioSource) {
        try { appState.currentAudioSource.stop(); } catch (_) {}
        appState.currentAudioSource = null;
    }
    // Signal backend to cancel its TTS pipeline
    if (appState.socket && appState.socket.readyState === WebSocket.OPEN) {
        appState.socket.send(JSON.stringify({ type: 'interrupt' }));
    }
    appState.status = 'listening';
    renderState();
}

// ==================== AUDIO PLAYBACK ====================
// Decodes raw PCM (16-bit LE, mono, 16 kHz) and plays it via Web Audio API.
function playIncomingAudio(arrayBuffer) {
    if (!appState.audioContext) {
        appState.audioContext = new AudioContext();
    }

    const view   = new DataView(arrayBuffer);
    const length = view.byteLength / 2;
    const audioBuf = appState.audioContext.createBuffer(1, length, 48000); // 48kHz matches LiveKit native rate
    const channel  = audioBuf.getChannelData(0);

    for (let i = 0; i < length; i++) {
        channel[i] = view.getInt16(i * 2, true) / 32768;
    }

    const source = appState.audioContext.createBufferSource();
    source.buffer = audioBuf;
    source.connect(appState.audioContext.destination);
    source.onended = () => {
        if (appState.currentAudioSource === source) appState.currentAudioSource = null;
    };
    source.start();
    appState.currentAudioSource = source; // Enhancement 3: track for interruption
}

// ==================== ENHANCEMENT 2 — VAD ====================
// Energy-based Voice Activity Detection using RMS per frame.
// Only transmits PCM when voice is active, cutting unnecessary bandwidth.
// Triggers AI interruption (Enhancement 3) when user speaks over the AI.

function computeRMS(float32Array) {
    let sum = 0;
    for (let i = 0; i < float32Array.length; i++) sum += float32Array[i] ** 2;
    return Math.sqrt(sum / float32Array.length);
}

function onVoiceStart() {
    if (appState.vadActive) return;
    appState.vadActive = true;
    updateDashboard();

    // Enhancement 3: interrupt AI if it's currently speaking
    if (appState.status === 'speaking') interruptAI();
}

function onVoiceEnd() {
    if (!appState.vadActive) return;
    appState.vadActive = false;
    updateDashboard();
}

// ==================== MICROPHONE & ANALYSER ====================
async function initMicAnalyser() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        console.warn('getUserMedia not supported');
        return;
    }
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        appState.micStream = stream;

        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const source       = audioContext.createMediaStreamSource(stream);
        const analyser     = audioContext.createAnalyser();
        analyser.fftSize   = 256;
        source.connect(analyser);

        appState.audioContext = audioContext;
        appState.analyser     = analyser;

        // ScriptProcessor handles both VAD (Enhancement 2) and PCM streaming
        const processor = audioContext.createScriptProcessor(2048, 1, 1);
        source.connect(processor);
        processor.connect(audioContext.destination);

        let holdTimer = null; // debounce for VAD speech-end detection

        processor.onaudioprocess = (e) => {
            if (!appState.socket || appState.socket.readyState !== WebSocket.OPEN) return;

            const input    = e.inputBuffer.getChannelData(0);
            const rms      = computeRMS(input);
            const isSpeech = rms > VAD_ENERGY_THRESHOLD;

            if (isSpeech) {
                // Clear hold — speech is continuing
                if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
                onVoiceStart();
            } else if (appState.vadActive && !holdTimer) {
                // Hold before declaring silence — avoids clipping natural pauses
                holdTimer = setTimeout(() => {
                    holdTimer = null;
                    onVoiceEnd();
                }, VAD_SPEECH_HOLD_MS);
            }

            // Only send PCM when voice is active (Enhancement 2)
            if (appState.vadActive) {
                const pcm = new Int16Array(input.length);
                for (let i = 0; i < input.length; i++) {
                    pcm[i] = Math.max(-1, Math.min(1, input[i])) * 32767;
                }
                appState.socket.send(pcm.buffer);
            }
        };

        // Orb amplitude animation loop
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        function updateOrbAmplitude() {
            if (appState.analyser && appState.status === 'listening') {
                appState.analyser.getByteFrequencyData(dataArray);
                const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
                dom.orb.style.transform = `scale(${1 + (avg / 256) * 0.1})`;
            } else {
                dom.orb.style.transform = 'scale(1)';
            }
            appState.animationFrame = requestAnimationFrame(updateOrbAmplitude);
        }
        updateOrbAmplitude();

    } catch (err) {
        console.warn('Mic access denied or failed', err);
    }
}

function stopMicAnalyser() {
    if (appState.micStream) {
        appState.micStream.getTracks().forEach(t => t.stop());
        appState.micStream = null;
    }
    if (appState.audioContext) {
        appState.audioContext.close();
        appState.audioContext = null;
    }
    if (appState.animationFrame) {
        cancelAnimationFrame(appState.animationFrame);
        appState.animationFrame = null;
    }
    appState.vadActive = false;
    dom.orb.style.transform = 'scale(1)';
}

// ==================== MAIN FLOW ====================
async function startFlow() {
    if (appState.status !== 'idle') return;

    try {
        await checkAgentStatus();

        const connData = await withBackoff(async () => {
            const data = await requestConnection();
            return data;
        }, 3, [1000, 2000, 4000]);

        appState.sessionId        = connData.session_id;
        appState.callId           = connData.call_id;
        appState.serverUrl        = connData.server_url;
        appState.participantToken = connData.participant_token;

        // Reset latency history for the fresh session
        appState.networkLatencyHistory    = [];
        appState.processingLatencyHistory = [];

        connectWebSocket();
        await initMicAnalyser();

    } catch (err) {
        console.error('Start flow failed', err);
        if (err.message.includes('credits')) alert(err.message);
        else handleConnectionFailure();
    }
}

async function endFlow() {
    await endCallOnServer();
    disconnectWebSocket();
    stopMicAnalyser();

    appState.sessionId          = null;
    appState.callId             = null;
    appState.serverUrl          = null;
    appState.participantToken   = null;
    appState.isReconnect        = false;
    appState.vadActive          = false;
    appState.currentAudioSource = null;
    appState.status             = 'idle';

    renderState();
    showLoadingOverlay(false);
    showRetryAlert(false);
}

// ==================== EVENT LISTENERS ====================
dom.startCallBtn.addEventListener('click', () => {
    if (appState.status === 'idle') startFlow();
});

dom.endCallBtn.addEventListener('click', endFlow);

dom.clearTranscriptBtn.addEventListener('click', clearTranscript);

dom.reconnectBtn.addEventListener('click', () => {
    dom.reconnectBtn.classList.add('d-none');
    dom.retryCountdown.parentElement.classList.remove('d-none');
    showRetryAlert(false);
    appState.retryCount  = 0;
    appState.isReconnect = true; // Enhancement 4
    connectWebSocket();
});

window.addEventListener('beforeunload', () => {
    if (appState.callId) navigator.sendBeacon(`${API_BASE}/calls/${appState.callId}/end`);
});

// Initial render
renderState();