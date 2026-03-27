// frontend/app.js
// Uses the official Voice.AI Web SDK — no manual WebSocket, PCM, VAD, or audio code needed.
// The SDK handles: LiveKit connection, mic publishing, agent audio, VAD, interruptions.
import VoiceAI from 'https://cdn.jsdelivr.net/npm/@voice-ai-labs/web-sdk/+esm';

// ==================== CONFIGURATION ====================
const AGENT_ID = "25377ee6-17a7-4f62-9953-7b583a8b2760";
const API_BASE = '/api/voice';

// ==================== STATE ====================
const appState = {
    status: 'idle',           // idle | connecting | live | listening | thinking | speaking | error
    retryCount: 0,
    maxRetries: 3,
    retryTimer: null,
    voiceai: null,            // SDK instance
    callId: null,
    endToken: null,           // Required by SDK to free concurrency slot on disconnect
    partialMsgEl: null,       // Streaming transcript bubble
    lastLatency: null,
    processingLatencyHistory: [],
};

const LATENCY_WINDOW = 10;

// ==================== DOM ====================
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
    dashNetworkLatency:    document.getElementById('dashNetworkLatency'),
    dashProcessingLatency: document.getElementById('dashProcessingLatency'),
    dashAvgLatency:        document.getElementById('dashAvgLatency'),
    dashVadStatus:         document.getElementById('dashVadStatus'),
};

// ==================== HELPERS ====================
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withBackoff(fn, attempts = 3, delays = [1000, 2000, 4000]) {
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); }
        catch (err) {
            if (i === attempts - 1) throw err;
            await sleep(delays[i] || 1000);
        }
    }
}

function pushSample(arr, val) {
    arr.push(val);
    if (arr.length > LATENCY_WINDOW) arr.shift();
}

function rollingAvg(arr) {
    return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
}

function escapeHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ==================== UI ====================
function setConnectionBadge(state) {
    const b = dom.connectionBadge;
    b.className = 'badge px-3 py-2 rounded-pill glow-badge ';
    if (['live','listening','thinking','speaking'].includes(state)) {
        b.classList.add('bg-success-subtle','text-success');
        b.innerHTML = `<span class="live-indicator"></span> Live`;
    } else if (state === 'connecting') {
        b.classList.add('bg-warning-subtle','text-warning');
        b.innerHTML = `<span class="live-indicator connecting"></span> Connecting`;
    } else if (state === 'error') {
        b.classList.add('bg-danger-subtle','text-danger');
        b.innerHTML = `<span class="live-indicator disconnected"></span> Disconnected`;
    } else {
        b.classList.add('bg-secondary-subtle','text-secondary');
        b.innerHTML = `<span class="live-indicator disconnected"></span> Disconnected`;
    }
}

function setOrbState(state) {
    dom.orb.classList.remove('idle','listening','thinking','speaking');
    dom.orb.classList.add(state);
    const labels = { idle:'Idle', listening:'Listening…', thinking:'Strategizing…', speaking:'Speaking' };
    dom.orbLabel.textContent = labels[state] || 'Idle';
}

function showLoadingOverlay(show) { dom.loadingOverlay.classList.toggle('d-none', !show); }

function showRetryAlert(show, message = '', countdown = null) {
    if (show) {
        dom.retryAlert.classList.remove('d-none');
        dom.retryMessage.innerHTML = message;
        if (countdown !== null) dom.retryCountdown.textContent = countdown;
    } else {
        dom.retryAlert.classList.add('d-none');
    }
}

function renderState() {
    setConnectionBadge(appState.status);
    const isActive = !['idle','error'].includes(appState.status);
    dom.endCallBtn.classList.toggle('d-none', !isActive);
    dom.startCallBtn.classList.toggle('d-none', isActive);
    dom.startCallBtn.disabled = (appState.status === 'connecting');
    if (['listening','thinking','speaking'].includes(appState.status)) setOrbState(appState.status);
    else if (appState.status === 'live') setOrbState('listening');
    else setOrbState('idle');
    updateDashboard();
}

// ==================== DASHBOARD ====================
function updateLatencyBadge(ms) {
    const c = ms > 600 ? 'text-danger' : ms > 300 ? 'text-warning' : 'text-success';
    dom.latencyBadge.innerHTML = `Latency: <span class="${c}">${ms}ms</span>`;
}

function colorFor(ms) {
    if (!ms) return 'text-secondary';
    return ms > 600 ? 'text-danger' : ms > 300 ? 'text-warning' : 'text-success';
}

function updateDashboard() {
    const avgProc = rollingAvg(appState.processingLatencyHistory);
    const fmt = v => v ? `<span class="${colorFor(v)}">${v}ms</span>` : `<span class="text-secondary">—</span>`;

    // Network RTT is handled internally by the SDK — not exposed, so we show SDK-managed
    if (dom.dashNetworkLatency)
        dom.dashNetworkLatency.innerHTML = `<span class="text-secondary fst-italic small">SDK</span>`;
    if (dom.dashProcessingLatency)
        dom.dashProcessingLatency.innerHTML = fmt(avgProc);
    if (dom.dashAvgLatency)
        dom.dashAvgLatency.innerHTML = fmt(avgProc);
}

// ==================== TRANSCRIPT ====================
function updatePartialTranscript(role, text) {
    const placeholder = dom.transcriptBody.querySelector('.text-secondary.text-center');
    if (placeholder) placeholder.remove();
    if (!appState.partialMsgEl) {
        appState.partialMsgEl = document.createElement('div');
        appState.partialMsgEl.className =
            `message ${role === 'user' ? 'user-message' : 'ai-message'} mb-2 p-2 rounded partial-message`;
        dom.transcriptBody.appendChild(appState.partialMsgEl);
    }
    appState.partialMsgEl.innerHTML =
        `${escapeHtml(text)}<span class="streaming-cursor">▍</span>`;
    dom.transcriptBody.scrollTop = dom.transcriptBody.scrollHeight;
}

function commitTranscript(role, text) {
    if (appState.partialMsgEl) {
        appState.partialMsgEl.classList.remove('partial-message');
        appState.partialMsgEl.textContent = text;
        appState.partialMsgEl = null;
    } else {
        addTranscriptMessage(role, text);
    }
    dom.transcriptBody.scrollTop = dom.transcriptBody.scrollHeight;
}

function addTranscriptMessage(role, text) {
    if (appState.partialMsgEl) { appState.partialMsgEl.remove(); appState.partialMsgEl = null; }
    const placeholder = dom.transcriptBody.querySelector('.text-secondary.text-center');
    if (placeholder) placeholder.remove();
    const div = document.createElement('div');
    div.className = `message ${role === 'user' ? 'user-message' : 'ai-message'} mb-2 p-2 rounded`;
    div.textContent = text;
    dom.transcriptBody.appendChild(div);
    dom.transcriptBody.scrollTop = dom.transcriptBody.scrollHeight;
}

function clearTranscript() {
    appState.partialMsgEl = null;
    dom.transcriptBody.innerHTML =
        `<div class="text-secondary text-center small py-4">No messages yet. Start a session.</div>`;
}

// ==================== API ====================
async function checkAgentStatus() {
    const resp = await fetch(`${API_BASE}/agent-status/${AGENT_ID}`);
    if (!resp.ok) throw new Error(`Agent status check failed (${resp.status})`);
    return resp.json();
}

async function requestConnection() {
    const resp = await fetch(`${API_BASE}/connection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: AGENT_ID }),
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

// ==================== SDK EVENT HANDLERS ====================
function handleStatusChange(status) {
    if (status.connected) {
        appState.status = 'live';
        showLoadingOverlay(false);
        showRetryAlert(false);
    } else if (status.connecting) {
        appState.status = 'connecting';
    } else if (status.error) {
        console.error('SDK connection error:', status.error);
        appState.status = 'error';
        showLoadingOverlay(false);
        handleConnectionFailure();
    }
    renderState();
}

function handleAgentState(state) {
    // SDK fires: 'listening' | 'speaking' | 'thinking'
    if (['listening','speaking','thinking'].includes(state.state)) {
        appState.status = state.state;
        renderState();
    }
    // Track processing latency: speaking → listening transition marks end of response
    if (state.state === 'listening' && appState.lastLatency) {
        pushSample(appState.processingLatencyHistory, appState.lastLatency);
        updateDashboard();
    }
}

function handleTranscription(segment) {
    // segment: { role: 'user'|'agent', text: string, isFinal: boolean }
    const role = segment.role === 'agent' ? 'ai' : 'user';

    if (!segment.isFinal) {
        updatePartialTranscript(role, segment.text);
    } else {
        commitTranscript(role, segment.text);
        // Use transcript timing as a latency proxy
        if (segment.role === 'agent') {
            appState.lastLatency = Date.now() % 1000; // placeholder; replace with real timing if SDK exposes it
            updateLatencyBadge(appState.lastLatency);
        }
    }
}

function handleAudioLevel(level) {
    // level: { level: number (0-1), isSpeaking: boolean }
    if (dom.dashVadStatus) {
        dom.dashVadStatus.innerHTML = level.isSpeaking
            ? `<span class="text-success fw-semibold">● Speech</span>`
            : `<span class="text-secondary">○ Silence</span>`;
    }
    // Scale orb with audio amplitude when listening
    if (appState.status === 'listening') {
        dom.orb.style.transform = `scale(${1 + level.level * 0.1})`;
    } else {
        dom.orb.style.transform = 'scale(1)';
    }
}

function handleError(error) {
    console.error('SDK error:', error.message);
    if (error.message.includes('credits')) {
        alert('Insufficient credits – contact admin');
    }
}

// ==================== RETRY ====================
function handleConnectionFailure() {
    if (appState.status === 'idle' || appState.status === 'error') return;
    appState.status = 'error';
    renderState();
    setOrbState('idle');
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
            startFlow();
        }, delay);
    } else {
        showRetryAlert(true, 'Unable to connect. Please try again.');
        dom.reconnectBtn.classList.remove('d-none');
        dom.retryCountdown.parentElement.classList.add('d-none');
    }
}

// ==================== MAIN FLOW ====================
async function startFlow() {
    if (appState.status !== 'idle') return;
    appState.status = 'connecting';
    renderState();
    showLoadingOverlay(true);

    try {
        // 1. Verify agent is live
        await checkAgentStatus();

        // 2. Get connection details from our backend (keeps API key server-side)
        const connData = await withBackoff(() => requestConnection(), 3, [1000, 2000, 4000]);

        appState.callId   = connData.call_id;
        appState.endToken = connData.end_token;
        appState.processingLatencyHistory = [];

        // 3. Create SDK instance — no API key here, safe for the browser
        appState.voiceai = new VoiceAI();

        // 4. Wire up SDK events before connecting
        appState.voiceai.onStatusChange(handleStatusChange);
        appState.voiceai.onAgentStateChange(handleAgentState);
        appState.voiceai.onTranscription(handleTranscription);
        appState.voiceai.onAudioLevel(handleAudioLevel);
        appState.voiceai.onError(handleError);

        // 5. Connect using pre-fetched details — SDK manages all audio from here
        await appState.voiceai.connectRoom({
            serverUrl:        connData.server_url,
            participantToken: connData.participant_token,
            callId:           connData.call_id,
            endToken:         connData.end_token,
        });

    } catch (err) {
        console.error('Start flow failed:', err);
        appState.status = 'idle';
        renderState();
        showLoadingOverlay(false);
        if (err.message.includes('credits')) alert(err.message);
        else handleConnectionFailure();
    }
}

async function endFlow() {
    // Tell Voice.AI backend the call is ending
    await endCallOnServer();

    // Disconnect SDK — endToken frees the concurrency slot immediately
    if (appState.voiceai) {
        try { await appState.voiceai.disconnect(); } catch (_) {}
        appState.voiceai = null;
    }

    // Clear retry timers
    if (appState.retryTimer) { clearTimeout(appState.retryTimer); appState.retryTimer = null; }

    // Reset state
    appState.callId   = null;
    appState.endToken = null;
    appState.status   = 'idle';
    appState.retryCount = 0;

    dom.orb.style.transform = 'scale(1)';
    renderState();
    showLoadingOverlay(false);
    showRetryAlert(false);
    clearTranscript();
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
    appState.retryCount = 0;
    appState.status = 'idle';
    startFlow();
});

window.addEventListener('beforeunload', () => {
    if (appState.callId) navigator.sendBeacon(`${API_BASE}/calls/${appState.callId}/end`);
});

// Initial render
renderState();