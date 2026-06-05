// 1. Clean up any old instances if StreamElements reloads the widget in editor
if (window.telemetrySocket) {
    window.telemetrySocket.disconnect();
}

// 2. Load Socket.io dynamically with a robust fallback protocol
const scriptId = 'socket-io-script';
let ioScript = document.getElementById(scriptId);

if (!ioScript) {
    ioScript = document.createElement('script');
    ioScript.id = scriptId;
    ioScript.src = "https://cdn.socket.io/4.7.5/socket.io.min.js";
    document.head.appendChild(ioScript);
}

// Function to handle incoming server data and update your exact layout elements
function handleTelemetryUpdate(data) {
    try {
        // Update the 5 main digital metrics
        const tripEl = document.getElementById('val-trip');
        const timeEl = document.getElementById('val-time');
        const speedEl = document.getElementById('val-speed');
        const elevEl = document.getElementById('val-elevation');
        const effEl = document.getElementById('val-eff');

        if (tripEl) tripEl.innerText = data.distance || '-- mi';
        if (timeEl) timeEl.innerText = data.time || '--';
        if (speedEl) speedEl.innerText = data.speed || '-- mph';
        if (elevEl) elevEl.innerText = data.elevation || '-- ft';
        if (effEl) effEl.innerText = data.efficiency || '--';

        // Manage Range Text & Low Battery State Alerts
        const rangeNumEl = document.querySelector('.range-num');
        if (rangeNumEl) {
            const numericRange = parseInt(data.range) || 0;
            rangeNumEl.innerText = numericRange;
            
            if (numericRange < 15) {
                rangeNumEl.classList.add('low-battery');
            } else {
                rangeNumEl.classList.remove('low-battery');
            }
        }

        // Calculate and animate your car's progress bar (0 miles driven = 0% progress fill)
        const rangePercent = parseInt(data.rangePercent) ?? 100;
        const batteryUsed = Math.max(0, Math.min(100, 100 - rangePercent));
        
        const fill = document.querySelector('.road-fill-red');
        const car = document.getElementById('car-icon');

        if (fill) fill.style.width = batteryUsed + "%";
        if (car) car.style.left = batteryUsed + "%";

    } catch (err) {
        console.error("Error parsing layout telemetry: ", err);
    }
}

// Initialize the WebSocket handshake once the library is verified
function initSocketConnection() {
    try {
        // Establishes connection to Render with automatic reconnection parameters
        const socket = io("https://torque-receiver.onrender.com", {
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            timeout: 20000
        });

        // Store globally to prevent duplicates on widget refreshes
        window.telemetrySocket = socket;

        socket.on('connect', () => {
            console.log('Successfully connected to Render Telemetry Server!');
        });

        // Listens directly for your server.js broadcast loop
        socket.on('telemetry_update', (data) => {
            handleTelemetryUpdate(data);
        });

        socket.on('connect_error', (error) => {
            console.warn('Telemetry connection error, retrying...', error);
        });

    } catch (e) {
        console.error("Socket initialization aborted: ", e);
    }
}

// ---------------------------------------------------------
// CLOCK LOGIC (Preserved exactly from your original setup)
// ---------------------------------------------------------
function updateClock() {
    const now = new Date();
    let h = now.getHours();
    const m = now.getMinutes().toString().padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    const clockEl = document.getElementById('clock-display');
    if (clockEl) clockEl.innerHTML = `${h}:${m} <span class="am-pm">${ampm}</span>`;
}

// ---------------------------------------------------------
// STREAMELEMENTS KICKOFF
// ---------------------------------------------------------
window.addEventListener('onWidgetLoad', function (obj) {
    // Start clock loop immediately
    setInterval(updateClock, 1000);
    updateClock();

    // Wait briefly for the script element to safely mount, then wire the socket channel
    if (typeof io !== 'undefined') {
        initSocketConnection();
    } else {
        ioScript.onload = function() {
            initSocketConnection();
        };
    }
});
