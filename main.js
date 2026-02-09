// ============================================
// GSB Recorder - Main Application
// ============================================

// Import styles
import './style.css';

// Note: lamejs is loaded via CDN script tag in HTML (global: lamejs)

// ---- Google OAuth Config ----
// Replace with your Google Cloud OAuth 2.0 Client ID
const GOOGLE_CLIENT_ID = '854688270436-dnvjhq5nqpqi087gkr3h863nqir7kqma.apps.googleusercontent.com';
const DRIVE_FOLDER_ID = '11uBzv9fT-TjRX8v0SeNOegA2K-ff3xAZ';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

// ---- State ----
let mediaRecorder = null;
let audioChunks = [];
let audioStream = null;
let isRecording = false;
let timerInterval = null;
let recordingStartTime = null;
let accessToken = null;
let tokenClient = null;

// ---- DOM Elements ----
const customerNameInput = document.getElementById('customerName');
const recordBtn = document.getElementById('recordBtn');
const recordIcon = document.getElementById('recordIcon');
const recordLabel = document.getElementById('recordLabel');
const timerEl = document.getElementById('timer');
const statusText = document.getElementById('statusText');
const statusArea = document.getElementById('statusArea');
const googleSignInBtn = document.getElementById('googleSignInBtn');
const overlay = document.getElementById('overlay');
const overlayText = document.getElementById('overlayText');
const silentAudio = document.getElementById('silentAudio');

// ============================================
// Google OAuth Sign-In
// ============================================
function handleGoogleSignIn() {
    // Build OAuth URL
    const redirectUri = `${window.location.origin}/api/auth`;
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', SCOPES);
    authUrl.searchParams.set('access_type', 'offline'); // Request refresh token
    authUrl.searchParams.set('prompt', 'consent'); // Force consent to always get refresh token

    // Redirect to Google OAuth
    window.location.href = authUrl.toString();
}

// ============================================
// Initialization
// ============================================
function init() {
    // Customer name validation
    customerNameInput.addEventListener('input', onNameChange);
    recordBtn.addEventListener('click', toggleRecording);
    googleSignInBtn.addEventListener('click', handleGoogleSignIn);

    // Disable record button initially
    updateRecordButton();

    // Register service worker
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(() => { });
    }

    // Check for OAuth callback (tokens in URL fragment)
    handleOAuthCallback();

    // Try to load existing refresh token and get new access token
    tryAutoLogin();
}

// Handle OAuth callback with tokens in URL fragment
function handleOAuthCallback() {
    const hash = window.location.hash.substring(1);
    if (!hash) return;

    const params = new URLSearchParams(hash);
    const accessTokenFromUrl = params.get('access_token');
    const refreshToken = params.get('refresh_token');

    if (accessTokenFromUrl && refreshToken) {
        // Store tokens
        accessToken = accessTokenFromUrl;
        localStorage.setItem('google_refresh_token', refreshToken);

        // Clear URL fragment
        window.history.replaceState(null, '', window.location.pathname);

        googleSignInBtn.style.display = 'none';
        setStatus('Signed in to Google ✓', 'success');

        // If we have a pending upload, do it now
        if (window._pendingUpload) {
            const { blob, fileName } = window._pendingUpload;
            window._pendingUpload = null;
            uploadToDrive(blob, fileName);
        }
    }
}

// Try to automatically log in using stored refresh token
async function tryAutoLogin() {
    const refreshToken = localStorage.getItem('google_refresh_token');
    if (!refreshToken) {
        // No refresh token - user needs to sign in
        return;
    }

    try {
        const newAccessToken = await refreshAccessToken(refreshToken);
        if (newAccessToken) {
            accessToken = newAccessToken;
            googleSignInBtn.style.display = 'none';
            setStatus('Signed in to Google ✓', 'success');
        }
    } catch (err) {
        console.error('Auto-login failed:', err);
        // Refresh token is invalid, clear it
        localStorage.removeItem('google_refresh_token');
    }
}

// Refresh access token using refresh token
async function refreshAccessToken(refreshToken) {
    try {
        const response = await fetch('/api/refresh', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ refresh_token: refreshToken }),
        });

        if (!response.ok) {
            const error = await response.json();
            if (error.error === 'invalid_refresh_token') {
                // Refresh token expired, user needs to re-login
                localStorage.removeItem('google_refresh_token');
                googleSignInBtn.style.display = 'flex';
                setStatus('Please sign in again', 'warning');
            }
            return null;
        }

        const data = await response.json();
        return data.access_token;
    } catch (err) {
        console.error('Token refresh error:', err);
        return null;
    }
}

// ============================================
// Customer Name Validation
// ============================================
function onNameChange() {
    updateRecordButton();
    if (customerNameInput.value.trim()) {
        if (!isRecording) {
            setStatus('Ready to record', '');
        }
    } else {
        if (!isRecording) {
            setStatus('Enter a customer name to begin', '');
        }
    }
}

function updateRecordButton() {
    const hasName = customerNameInput.value.trim().length > 0;
    recordBtn.disabled = !hasName && !isRecording;
}

// ============================================
// Recording
// ============================================
async function toggleRecording() {
    if (isRecording) {
        stopRecording();
    } else {
        await startRecording();
    }
}

async function startRecording() {
    try {
        // Request microphone
        audioStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                sampleRate: 44100,
            },
        });

        // Determine best supported MIME type
        const mimeType = getSupportedMimeType();

        // Create MediaRecorder
        mediaRecorder = new MediaRecorder(audioStream, {
            mimeType: mimeType,
        });

        audioChunks = [];

        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
                audioChunks.push(e.data);
            }
        };

        mediaRecorder.onstop = () => {
            handleRecordingComplete();
        };

        // Start recording with timeslice to get periodic chunks
        mediaRecorder.start(1000);
        isRecording = true;

        // UI updates
        recordBtn.classList.add('recording');
        recordLabel.textContent = 'Stop Recording';
        timerEl.classList.add('active');
        customerNameInput.disabled = true;
        setStatus('Recording...', '');

        // Start timer
        recordingStartTime = Date.now();
        timerInterval = setInterval(updateTimer, 100);

        // Start silent audio for background persistence
        startBackgroundPersistence();

    } catch (err) {
        console.error('Recording error:', err);
        if (err.name === 'NotAllowedError') {
            setStatus('Microphone access denied. Please allow microphone access.', 'error');
        } else {
            setStatus('Could not start recording: ' + err.message, 'error');
        }
    }
}

function getSupportedMimeType() {
    const types = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/mp4',
        'audio/aac',
    ];
    for (const type of types) {
        if (MediaRecorder.isTypeSupported(type)) {
            return type;
        }
    }
    return '';
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }

    // Stop all tracks
    if (audioStream) {
        audioStream.getTracks().forEach((track) => track.stop());
        audioStream = null;
    }

    isRecording = false;

    // UI updates
    recordBtn.classList.remove('recording');
    recordLabel.textContent = 'Start Recording';
    timerEl.classList.remove('active');
    customerNameInput.disabled = false;
    recordBtn.disabled = false;

    // Stop timer
    clearInterval(timerInterval);
    timerInterval = null;

    // Stop background persistence
    stopBackgroundPersistence();
}

function updateTimer() {
    if (!recordingStartTime) return;
    const elapsed = Date.now() - recordingStartTime;
    const hours = Math.floor(elapsed / 3600000);
    const minutes = Math.floor((elapsed % 3600000) / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);
    timerEl.textContent =
        String(hours).padStart(2, '0') + ':' +
        String(minutes).padStart(2, '0') + ':' +
        String(seconds).padStart(2, '0');
}

// ============================================
// Background Persistence
// ============================================
function startBackgroundPersistence() {
    // Play silent audio to keep app alive in background
    silentAudio.play().catch(() => { });

    // Set Media Session metadata
    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: 'GSB Recorder',
            artist: 'Recording in progress...',
            album: customerNameInput.value.trim(),
        });

        navigator.mediaSession.setActionHandler('play', () => {
            silentAudio.play().catch(() => { });
        });
        navigator.mediaSession.setActionHandler('pause', () => {
            // Don't actually pause - keep recording
            silentAudio.play().catch(() => { });
        });
        navigator.mediaSession.setActionHandler('stop', () => {
            // Don't stop
            silentAudio.play().catch(() => { });
        });
    }
}

function stopBackgroundPersistence() {
    silentAudio.pause();
    silentAudio.currentTime = 0;

    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.setActionHandler('play', null);
        navigator.mediaSession.setActionHandler('pause', null);
        navigator.mediaSession.setActionHandler('stop', null);
    }
}

// ============================================
// MP3 Encoding
// ============================================
async function handleRecordingComplete() {
    showOverlay('Processing recording...');

    try {
        const audioBlob = new Blob(audioChunks, { type: audioChunks[0]?.type || 'audio/webm' });
        const customerName = customerNameInput.value.trim();
        const dateStr = formatDate(new Date());
        const fileName = `${customerName} - ${dateStr}.mp3`;

        setStatus('Encoding MP3...', 'warning');
        updateOverlay('Encoding to MP3...');

        const mp3Blob = await encodeToMp3(audioBlob);

        setStatus('MP3 encoded ✓', 'success');

        // Check if we have Google auth
        if (!accessToken) {
            // Store the pending upload and prompt sign-in
            window._pendingUpload = { blob: mp3Blob, fileName };
            hideOverlay();
            setStatus('Sign in to Google to upload your recording', 'warning');
            googleSignInBtn.style.display = 'flex';
            return;
        }

        // Upload to Google Drive
        await uploadToDrive(mp3Blob, fileName);

    } catch (err) {
        console.error('Processing error:', err);
        hideOverlay();
        setStatus('Error: ' + err.message, 'error');
    }
}

async function encodeToMp3(audioBlob) {
    // Decode the audio blob to PCM using AudioContext
    const arrayBuffer = await audioBlob.arrayBuffer();
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    const numberOfChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const samples = audioBuffer.length;

    // Create MP3 encoder using global lamejs from CDN (128 kbps)
    const encoder = new lamejs.Mp3Encoder(numberOfChannels, sampleRate, 128);
    const blockSize = 1152;
    const mp3Data = [];

    if (numberOfChannels === 1) {
        // Mono
        const channelData = audioBuffer.getChannelData(0);
        const samples16 = floatTo16BitPCM(channelData);

        for (let i = 0; i < samples16.length; i += blockSize) {
            const chunk = samples16.subarray(i, i + blockSize);
            const mp3buf = encoder.encodeBuffer(chunk);
            if (mp3buf.length > 0) {
                mp3Data.push(mp3buf);
            }
        }
    } else {
        // Stereo
        const leftData = audioBuffer.getChannelData(0);
        const rightData = audioBuffer.getChannelData(1);
        const leftSamples = floatTo16BitPCM(leftData);
        const rightSamples = floatTo16BitPCM(rightData);

        for (let i = 0; i < leftSamples.length; i += blockSize) {
            const leftChunk = leftSamples.subarray(i, i + blockSize);
            const rightChunk = rightSamples.subarray(i, i + blockSize);
            const mp3buf = encoder.encodeBuffer(leftChunk, rightChunk);
            if (mp3buf.length > 0) {
                mp3Data.push(mp3buf);
            }
        }
    }

    // Flush
    const end = encoder.flush();
    if (end.length > 0) {
        mp3Data.push(end);
    }

    await audioContext.close();

    return new Blob(mp3Data, { type: 'audio/mp3' });
}

function floatTo16BitPCM(float32Array) {
    const int16 = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
        const s = Math.max(-1, Math.min(1, float32Array[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16;
}

// ============================================
// Google Drive Upload
// ============================================
async function uploadToDrive(blob, fileName) {
    showOverlay('Uploading to Google Drive...');
    setStatus('Uploading to Google Drive...', 'warning');

    try {
        const metadata = {
            name: fileName,
            mimeType: 'audio/mpeg',
            parents: [DRIVE_FOLDER_ID],
        };

        // Build multipart request
        const boundary = '-------gsb_recorder_boundary';
        const delimiter = '\r\n--' + boundary + '\r\n';
        const closeDelimiter = '\r\n--' + boundary + '--';

        const metadataStr = JSON.stringify(metadata);

        // Read blob as base64
        const reader = new FileReader();
        const base64Data = await new Promise((resolve, reject) => {
            reader.onload = () => {
                const dataUrl = reader.result;
                const base64 = dataUrl.split(',')[1];
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });

        const multipartBody =
            delimiter +
            'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
            metadataStr +
            delimiter +
            'Content-Type: audio/mpeg\r\n' +
            'Content-Transfer-Encoding: base64\r\n\r\n' +
            base64Data +
            closeDelimiter;

        const response = await fetch(
            'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
            {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer ' + accessToken,
                    'Content-Type': 'multipart/related; boundary=' + boundary,
                },
                body: multipartBody,
            }
        );

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            // If token expired, try refreshing
            if (response.status === 401) {
                const refreshToken = localStorage.getItem('google_refresh_token');
                if (refreshToken) {
                    // Try to refresh token and retry upload
                    const newAccessToken = await refreshAccessToken(refreshToken);
                    if (newAccessToken) {
                        accessToken = newAccessToken;
                        // Retry upload with new token
                        return await uploadToDrive(blob, fileName);
                    }
                }
                // Refresh failed or no refresh token - need to re-login
                accessToken = null;
                window._pendingUpload = { blob, fileName };
                hideOverlay();
                setStatus('Session expired. Please sign in again.', 'warning');
                googleSignInBtn.style.display = 'flex';
                return;
            }
            throw new Error(errData.error?.message || `Upload failed (${response.status})`);
        }

        const result = await response.json();
        hideOverlay();
        setStatus(`Uploaded "${fileName}" to Google Drive ✓`, 'success');
        timerEl.textContent = '00:00:00';
        console.log('Upload successful:', result);

    } catch (err) {
        console.error('Upload error:', err);
        hideOverlay();
        setStatus('Upload failed: ' + err.message, 'error');
    }
}

// ============================================
// Helpers
// ============================================
function formatDate(date) {
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const yyyy = date.getFullYear();
    return `${mm}-${dd}-${yyyy}`;
}

function setStatus(message, type) {
    statusText.textContent = message;
    statusText.className = 'status-text';
    if (type) {
        statusText.classList.add(type);
    }
}

function showOverlay(message) {
    overlayText.textContent = message;
    overlay.style.display = 'flex';
}

function updateOverlay(message) {
    overlayText.textContent = message;
}

function hideOverlay() {
    overlay.style.display = 'none';
}

// ---- Start ----
init();
