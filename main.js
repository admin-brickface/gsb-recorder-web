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

// ---- Speech Recognition State ----
let speechRecognition = null;
let transcript = '';
let isTranscribing = false;

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

    // Initialize Google Identity Services when loaded
    waitForGoogleIdentity();
}

function waitForGoogleIdentity() {
    if (typeof google !== 'undefined' && google.accounts) {
        initTokenClient();
    } else {
        setTimeout(waitForGoogleIdentity, 100);
    }
}

function initTokenClient() {
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: SCOPES,
        callback: (response) => {
            if (response.error) {
                setStatus('Google sign-in failed. Please try again.', 'error');
                return;
            }
            accessToken = response.access_token;
            googleSignInBtn.style.display = 'none';
            setStatus('Signed in to Google ✓', 'success');

            // If we have a pending upload, do it now
            if (window._pendingUpload) {
                const { mp3Blob, transcriptBlob, baseFileName } = window._pendingUpload;
                window._pendingUpload = null;
                uploadBothFiles(mp3Blob, transcriptBlob, baseFileName);
            }
        },
    });
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

        // Start speech recognition for transcription
        startSpeechRecognition();

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

    // Stop speech recognition
    stopSpeechRecognition();
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
        const baseFileName = `${customerName} - ${dateStr}`;

        setStatus('Encoding MP3...', 'warning');
        updateOverlay('Encoding to MP3...');

        const mp3Blob = await encodeToMp3(audioBlob);

        // Create transcript blob
        const transcriptContent = transcript || '(No transcription available)';
        const transcriptBlob = new Blob([transcriptContent], { type: 'text/plain' });

        setStatus('MP3 encoded ✓', 'success');

        // Check if we have Google auth
        if (!accessToken) {
            // Store the pending upload and prompt sign-in
            window._pendingUpload = { mp3Blob, transcriptBlob, baseFileName };
            hideOverlay();
            setStatus('Sign in to Google to upload your recording', 'warning');
            googleSignInBtn.style.display = 'flex';
            return;
        }

        // Upload both files to Google Drive
        await uploadBothFiles(mp3Blob, transcriptBlob, baseFileName);

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
function handleGoogleSignIn() {
    if (tokenClient) {
        tokenClient.requestAccessToken();
    } else {
        setStatus('Google Identity Services not loaded yet. Please wait.', 'error');
    }
}

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
            // If token expired, re-auth
            if (response.status === 401) {
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
// Speech Recognition / Transcription
// ============================================
function startSpeechRecognition() {
    // Check for browser support
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        console.warn('Speech recognition not supported in this browser');
        transcript = '(Speech recognition not supported in this browser)';
        return;
    }

    // Reset transcript
    transcript = '';

    speechRecognition = new SpeechRecognition();
    speechRecognition.continuous = true;
    speechRecognition.interimResults = true;
    speechRecognition.lang = 'en-US';

    let finalTranscript = '';

    speechRecognition.onresult = (event) => {
        let interimTranscript = '';

        for (let i = 0; i < event.results.length; i++) {
            const result = event.results[i];
            if (result.isFinal) {
                finalTranscript += result[0].transcript + ' ';
            } else {
                interimTranscript += result[0].transcript;
            }
        }

        // Store both final and interim results
        transcript = (finalTranscript + interimTranscript).trim();
        console.log('Transcript:', transcript.substring(0, 100));
    };

    speechRecognition.onerror = (event) => {
        console.warn('Speech recognition error:', event.error);
        // Don't stop recording on error, just note it
        if (event.error === 'no-speech') {
            // This is common, ignore it
        } else if (event.error === 'aborted') {
            // User or system aborted, ignore
        } else {
            transcript = finalTranscript.trim() || '(Transcription error: ' + event.error + ')';
        }
    };

    speechRecognition.onend = () => {
        // If still recording, restart recognition (it auto-stops after silence)
        if (isRecording && speechRecognition) {
            try {
                speechRecognition.start();
            } catch (e) {
                // Already started, ignore
            }
        }
    };

    try {
        speechRecognition.start();
        isTranscribing = true;
        console.log('Speech recognition started');
    } catch (err) {
        console.error('Could not start speech recognition:', err);
        transcript = '(Could not start transcription)';
    }
}

function stopSpeechRecognition() {
    if (speechRecognition) {
        try {
            speechRecognition.stop();
        } catch (e) {
            // Already stopped
        }
        speechRecognition = null;
    }
    isTranscribing = false;
}

// ============================================
// Upload Both Files (MP3 + Transcript)
// ============================================
async function uploadBothFiles(mp3Blob, transcriptBlob, baseFileName) {
    showOverlay('Uploading to Google Drive...');
    setStatus('Uploading MP3...', 'warning');

    console.log('uploadBothFiles called with:', {
        mp3Size: mp3Blob.size,
        transcriptSize: transcriptBlob.size,
        baseFileName
    });

    try {
        // Upload MP3
        console.log('Uploading MP3...');
        await uploadSingleFile(mp3Blob, `${baseFileName}.mp3`, 'audio/mpeg');
        console.log('MP3 uploaded successfully');

        setStatus('Uploading transcript...', 'warning');
        updateOverlay('Uploading transcript...');

        // Upload transcript
        console.log('Uploading transcript...');
        await uploadSingleFile(transcriptBlob, `${baseFileName}.txt`, 'text/plain');
        console.log('Transcript uploaded successfully');

        hideOverlay();
        setStatus(`Uploaded "${baseFileName}" (MP3 + transcript) to Google Drive ✓`, 'success');
        timerEl.textContent = '00:00:00';

        // Reset transcript for next recording
        transcript = '';

    } catch (err) {
        console.error('Upload error:', err);
        hideOverlay();

        // Handle token expiry
        if (err.message?.includes('401') || err.message?.includes('expired')) {
            accessToken = null;
            window._pendingUpload = { mp3Blob, transcriptBlob, baseFileName };
            setStatus('Session expired. Please sign in again.', 'warning');
            googleSignInBtn.style.display = 'flex';
            return;
        }

        setStatus('Upload failed: ' + err.message, 'error');
    }
}

async function uploadSingleFile(blob, fileName, mimeType) {
    const metadata = {
        name: fileName,
        mimeType: mimeType,
        parents: [DRIVE_FOLDER_ID],
    };

    // Build multipart request
    const boundary = '-------gsb_recorder_boundary';
    const delimiter = '\r\n--' + boundary + '\r\n';
    const closeDelimiter = '\r\n--' + boundary + '--';

    const metadataStr = JSON.stringify(metadata);

    // Read blob as base64
    const base64Data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
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
        `Content-Type: ${mimeType}\r\n` +
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
        throw new Error(errData.error?.message || `Upload failed (${response.status})`);
    }

    const result = await response.json();
    console.log('Upload successful:', fileName, result);
    return result;
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
