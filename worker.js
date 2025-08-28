// Load environment variables first
const path = require('path');
const dotenv = require('dotenv');

// Explicitly load from .env file in project root
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Validate required environment variables
const requiredEnvVars = ['LIVEKIT_WS_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'ELEVENLABS_API_KEY'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  console.error('❌ Missing required environment variables:');
  missingVars.forEach(varName => {
    console.error(`   - ${varName}`);
  });
  console.error('\nPlease create a .env file in the project root with these variables.');
  console.error('Example .env file:');
  console.error('LIVEKIT_WS_URL=wss://your-livekit-server.com');
  console.error('LIVEKIT_API_KEY=your_livekit_api_key');
  console.error('LIVEKIT_API_SECRET=your_livekit_api_secret');
  console.error('ELEVENLABS_API_KEY=your_elevenlabs_api_key');
  console.error('PORT=3000');
  process.exit(1);
}

// Log loaded environment variables (names only, not values)
console.log('✅ Environment variables loaded successfully:');
requiredEnvVars.forEach(varName => {
  console.log(`   - ${varName}: [LOADED]`);
});

const { AccessToken } = require('livekit-server-sdk');
const { Room, RoomEvent, ConnectionState, AudioStream, AudioSource, LocalAudioTrack, TrackPublishOptions, TrackSource, AudioFrame } = require('@livekit/rtc-node');
const WebSocket = require('ws');
const { fetch } = require('undici');
const { Readable, PassThrough } = require('stream');
const { request } = require('undici');
const { Writable } = require('node:stream');
const Wav = require('wav');

const VOICE_SAMPLE_RATE = 48000; // LiveKit PCM is 48k mono Int16
const S2S_CHUNK_MS = parseInt(process.env.S2S_CHUNK_MS || '1000', 10); // chunk size for multipart S2S - increased to reduce API calls

// make a tiny WAV from Int16Array mono PCM
function pcmToWavBuffer(int16, sampleRate = VOICE_SAMPLE_RATE) {
  const numChannels = 1, bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * bitsPerSample/8;
  const blockAlign = numChannels * bitsPerSample/8;
  const dataSize = int16.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  let o = 0;
  buffer.write('RIFF', o); o+=4;
  buffer.writeUInt32LE(36 + dataSize, o); o+=4;
  buffer.write('WAVE', o); o+=4;
  buffer.write('fmt ', o); o+=4;
  buffer.writeUInt32LE(16, o); o+=4;                // PCM fmt chunk
  buffer.writeUInt16LE(1, o); o+=2;                 // PCM
  buffer.writeUInt16LE(numChannels, o); o+=2;
  buffer.writeUInt32LE(sampleRate, o); o+=4;
  buffer.writeUInt32LE(byteRate, o); o+=4;
  buffer.writeUInt16LE(blockAlign, o); o+=2;
  buffer.writeUInt16LE(bitsPerSample, o); o+=2;
  buffer.write('data', o); o+=4;
  buffer.writeUInt32LE(dataSize, o); o+=4;
  Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength).copy(buffer, 44);
  return buffer;
}

function pcm16ToWav(pcmBuf, sampleRate = 16000, channels = 1) {
  const blockAlign = channels * 2, byteRate = sampleRate * blockAlign;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcmBuf.length, 4);
  h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(blockAlign, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcmBuf.length, 40);
  return Buffer.concat([h, pcmBuf]);
}

// naive VAD timer thresholds
const SILENCE_DB = -55;          // speak above this
const MIN_UTTER_MS = 700;        // min chunk length
const SILENCE_HANG_MS = 500;     // end chunk after this much silence

// No additional helper functions needed - core functionality is in the class

// Helper function to calculate RMS dBFS level for voice activity detection
function rmsDbFS(int16) {
  if (!int16 || int16.length === 0) return -120;
  let sum = 0;
  for (let i = 0; i < int16.length; i++) {
    const s = int16[i] / 32768; // normalize to -1..1
    sum += s * s;
  }
  const rms = Math.sqrt(sum / int16.length);
  const db = 20 * Math.log10(rms + 1e-12);
  return Math.max(-120, db);
}

// Helper function to map track kind (handles string or numeric enum from @livekit/rtc-node)
function mapKind(k) {
  // handle string or numeric enum from @livekit/rtc-node
  if (k == null) return 'unknown';
  if (typeof k === 'string') return k.toLowerCase();
  switch (k) {
    case 1: return 'audio';
    case 2: return 'video';
    case 3: return 'data';
    default: return 'unknown';
  }
}

// Helper function to check if a track is audio (avoiding Track.Kind enum issues)
function isAudioTrack(track, pub) {
  const k = mapKind(track?.kind ?? pub?.kind);
  return k === 'audio';
}

// A. helper to subscribe to already-published audio
async function subscribeExistingAudioFor(participant) {
  if (!participant) return;
  // Subscribe tracks map (if present)
  if (participant.tracks && typeof participant.tracks.values === 'function') {
    for (const pub of participant.tracks.values()) {
      if (mapKind(pub?.kind) === 'audio') {
        try { await pub.setSubscribed(true); } catch (e) { console.warn('subscribe existing (tracks) failed', e); }
      }
    }
  }
  // Subscribe audioTracks map (rtc-node often uses this)
  if (participant.audioTracks && typeof participant.audioTracks.values === 'function') {
    for (const pub of participant.audioTracks.values()) {
      try { await pub.setSubscribed(true); } catch (e) { console.warn('subscribe existing (audioTracks) failed', e); }
    }
  }
}

// Helper function to safely get participants across SDK variants
function safeParticipants(room) {
  if (!room) return { list: [], count: 0 };
  // rtc-node sometimes exposes `participants` or `remoteParticipants`
  const map =
    room.participants ??
    room.remoteParticipants ??
    (typeof room.getParticipants === 'function' ? room.getParticipants() : undefined) ??
    new Map();
  try {
    const list = Array.from(map.values()).map((p) => p.identity ?? '(unknown)');
    const count = typeof map.size === 'number' ? map.size : list.length;
    return { list, count };
  } catch {
    return { list: [], count: 0 };
  }
}

// Helper function to log room status with proper connection state
function logRoomStatus(room, label = 'Room Status') {
  if (!room) {
    console.warn('logRoomStatus called with undefined room');
    return;
  }
  const { list, count } = safeParticipants(room);
  const connected = room.state === ConnectionState.Connected;
  console.log('📊', label, JSON.stringify({
    connected,
    roomName: room.name,
    participantCount: count,
    participants: list,
  }, null, 2));
}

class LiveKitAudioWorker {
  constructor() {
    this.room = null;
    this.roomName = null;
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this.participantVoices = new Map(); // Store voice selections for participants
    this.routes = new Map(); // Speaker routes with voice and output info
    this._subs = new Set(); // pub.sid we've subscribed to
    this.activeS2S = new Set(); // Track active speech-to-speech conversions
    this.quotaExhausted = null; // Track quota exhaustion timestamp
    this.lastSuccessfulCall = Date.now(); // Track when we last had a successful call
    this.recentlyRecreated = new Set(); // Track recently recreated routes to avoid immediate retry
    this.setupProcess();
    this.setupQuotaResetTimer();
  }

  setupQuotaResetTimer() {
    // Check quota status every minute and reset if enough time has passed
    setInterval(() => {
      if (this.quotaExhausted) {
        const timeSinceExhaustion = Date.now() - this.quotaExhausted;
        if (timeSinceExhaustion > 60000) { // 1 minute
          console.log('🔄 Quota reset timer - attempting to resume ElevenLabs processing');
          this.quotaExhausted = null;
        }
      }
    }, 30000); // Check every 30 seconds
  }

  setupProcess() {
    // Handle uncaught exceptions to prevent crashes
    process.on('uncaughtException', (error) => {
      console.error('🚨 Uncaught Exception:', error.message);
      if (error.message.includes('InvalidState') && error.message.includes('failed to capture frame')) {
        console.log('🔌 AudioSource InvalidState detected - cleaning up and continuing...');
        // Clean up all active S2S processing
        this.activeS2S.clear();
        // Don't exit - let the worker continue
        return;
      }
      // For other uncaught exceptions, exit gracefully
      console.error('🚨 Fatal error, shutting down...');
      this.cleanup();
      process.exit(1);
    });
    
    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      if (reason && reason.message && reason.message.includes('InvalidState')) {
        // Don't spam logs for InvalidState - we handle this gracefully
        return;
      }
      console.error('🚨 Unhandled Promise Rejection:', reason);
    });

    // Graceful shutdown
    process.on('SIGINT', () => {
      console.log('🛑 Shutting down gracefully...');
      this.cleanup();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      console.log('🛑 Shutting down gracefully...');
      this.cleanup();
      process.exit(0);
    });
  }

  async cleanup() {
    try {
      // Clear timers
      if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
      
      // Clear active processing
      this.activeS2S.clear();
      
      // Clean up any active routes
      for (const [key, route] of this.routes) {
        try {
          if (route.track && this.room?.localParticipant) {
            await this.room.localParticipant.unpublishTrack(route.track);
          }
        } catch (error) {
          console.warn(`Failed to cleanup route ${key}:`, error.message);
        }
      }
      this.routes.clear();
      
      if (this.room) {
        await this.room.disconnect();
        this.room = null;
      }
    } catch (error) {
      console.error('Error during cleanup:', error.message);
    }
  }

  generateToken(roomName, identity) {
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;

    if (!apiKey || !apiSecret) {
      throw new Error('LiveKit credentials not configured. Please set LIVEKIT_API_KEY and LIVEKIT_API_SECRET environment variables.');
    }

    const token = new AccessToken(apiKey, apiSecret, {
      identity: identity,
      ttl: '1h', // Token valid for 1 hour
    });

    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      canUpdateOwnMetadata: true,
    });

    return token.toJwt();
  }

  async connectToRoom(roomName = 'default-room') {
    const wsUrl = process.env.LIVEKIT_URL || process.env.LIVEKIT_WS_URL;
    
    if (!wsUrl) {
      throw new Error('LIVEKIT_URL or LIVEKIT_WS_URL environment variable not set');
    }

    const identity = `audio-worker`;
    this.roomName = roomName;
    const token = await this.generateToken(roomName, identity);

    console.log(`🔗 Connecting to LiveKit room: ${roomName}`);
    console.log(`👤 Identity: ${identity}`);
    console.log("🔍 [WORKER] Connecting to LiveKit:", { 
        url: wsUrl, 
        roomName: roomName, 
        identity: identity 
    });

    this.room = new Room();
    const roomRef = this.room;
    this.setupRoomEventListeners(roomRef);

    try {
      // connect with manual subscriptions
      await this.room.connect(wsUrl, token, {
        autoSubscribe: true, // Enable auto subscription for simplicity
        adaptiveStream: false, // Disable adaptive streaming for audio processing
        publishDefaults: {
          dtx: false, // Disable discontinuous transmission
          red: false, // Disable redundancy encoding
        },
      });

      console.log(`✅ Connected to room: ${roomRef.name}`);
      logRoomStatus(roomRef, 'After connect');
      
      // Handle existing participants - MUST happen before any track subscriptions
      const participantMap = roomRef.participants ?? roomRef.remoteParticipants ?? new Map();
      
      // First, load voices and create routes for all existing participants
      for (const p of participantMap.values()) {
        await this.handleParticipantConnected(p);
      }
      
      // Log existing participants
      const { list: participants } = safeParticipants(roomRef);
      console.log(`👥 Found ${participants.length} existing participants: ${participants.join(', ')}`);

    } catch (error) {
      console.error('❌ Failed to connect to room:', error);
      throw error;
    }
  }

  setupRoomEventListeners(roomRef) {
    roomRef.on(RoomEvent.Connected, () => {
      try {
        console.log('🎉 Successfully connected to LiveKit room');
        logRoomStatus(roomRef, 'Connected event');
      } catch (error) {
        console.error('❌ Error in Connected event handler:', error);
      }
    });

    roomRef.on(RoomEvent.Disconnected, (reason) => {
      try {
        console.log(`❌ Disconnected from room. Reason: ${reason}`);
        
        // Clear all active processing
        this.activeS2S.clear();
        
        // Only reconnect for network issues, not for server-side disconnects
        if (reason === 1) { // Only reconnect for connection lost
          if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
          
          // Simple retry with fixed delay to avoid overwhelming the server
          this._reconnectTimer = setTimeout(() => {
            console.log(`🔁 Attempting to reconnect worker...`);
            this.connectToRoom(this.roomName)
              .then(() => {
                console.log('✅ Reconnection successful');
              })
              .catch(err => {
                console.error('❌ Reconnect failed:', err.message);
                // Don't keep retrying indefinitely
              });
          }, 5000); // Fixed 5 second delay
        } else {
          console.log('🛑 Not reconnecting - server initiated disconnect');
        }
      } catch (error) {
        console.error('❌ Error in Disconnected event handler:', error);
      }
    });

    roomRef.on(RoomEvent.ParticipantConnected, (participant) => {
      try {
        console.log('🔍 [WORKER] participantConnected:', participant?.identity);
        console.log(`👤 Participant connected: ${participant?.identity}`);
        this.handleParticipantConnected(participant);
        logRoomStatus(roomRef, 'After participantConnected');
      } catch (error) {
        console.error('❌ Error in ParticipantConnected event handler:', error);
      }
    });

    roomRef.on(RoomEvent.ParticipantDisconnected, (participant) => {
      try {
        console.log(`👋 Participant disconnected: ${participant?.identity}`);
        this.handleParticipantDisconnected(participant);
        logRoomStatus(roomRef, 'After participantDisconnected');
      } catch (error) {
        console.error('❌ Error in ParticipantDisconnected event handler:', error);
      }
    });

    // Handle track subscriptions for audio processing
    roomRef.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
      try {
        if (!track || !isAudioTrack(track, pub)) return;
        if (!participant?.identity || participant.identity.startsWith('audio-worker')) return;

        console.log(`🎧 Audio track subscribed from ${participant.identity}`);
        
        // Check if route exists, if not wait a moment and try again
        const route = this.routes?.get(participant.identity);
        if (!route) {
          console.log(`⏳ Route not ready for ${participant.identity}, waiting...`);
          setTimeout(() => {
            const retryRoute = this.routes?.get(participant.identity);
            if (retryRoute) {
              console.log(`✅ Route ready for ${participant.identity}, starting audio stream`);
              this._startAudioStream(track, participant.identity);
            } else {
              console.warn(`⚠️ Route still not available for ${participant.identity} after retry`);
            }
          }, Math.max(1000, 1000)); // Ensure positive timeout
          return;
        }
        
        // Start chunked S2S processing for this audio track
        this._startAudioStream(track, participant.identity);
      } catch (e) {
        console.error('❌ TrackSubscribed handler error', e.message);
      }
    });

    roomRef.on(RoomEvent.TrackUnsubscribed, (track, pub, participant) => {
      console.log(`🔇 Track unsubscribed from ${participant?.identity}`);
    });
  }

  async handleParticipantConnected(participant) {
    // Get voice selection for this participant
    await this.loadParticipantVoice(participant.identity);
    
    // Set up route for this participant
    await this.setupRouteForParticipant(participant.identity);
  }

  async loadParticipantVoice(participantIdentity) {
    try {
      console.log(`🔍 Loading voice selection for: ${participantIdentity}`);
      
      // Try to get voice selection from server
      const port = process.env.PORT || 3000;
      const res = await fetch(`http://localhost:${port}/get-voice/${encodeURIComponent(participantIdentity)}`).catch(() => null);
      
      let voiceId = 'pNInz6obpgDQGcFmaJgB'; // Default Adam voice
      let voiceName = 'Adam (Default)';
      
      if (res && res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.voiceSelection) {
          voiceId = data.voiceSelection;
          voiceName = 'Custom Voice';
        }
      }
      
      this.participantVoices.set(participantIdentity, {
        voiceId: voiceId,
        voiceName: voiceName
      });
      
      console.log(`🎤 Voice assigned to ${participantIdentity}: ${voiceName}`);
    } catch (error) {
      console.error(`❌ Error loading voice for ${participantIdentity}:`, error);
      // Fallback to default voice
      this.participantVoices.set(participantIdentity, {
        voiceId: 'pNInz6obpgDQGcFmaJgB',
        voiceName: 'Adam (Fallback)'
      });
    }
  }

  async setupRouteForParticipant(participantIdentity) {
    try {
      // Get the voice for this participant
      const voiceInfo = this.participantVoices.get(participantIdentity);
      if (!voiceInfo) {
        console.warn(`⚠️ No voice info found for ${participantIdentity}`);
        return;
      }

      // Create output audio source and track for this participant
      const routeKey = `from-${participantIdentity}`;
      const source = new AudioSource(48000, 1); // 48kHz mono
      const track = LocalAudioTrack.createAudioTrack(routeKey, source);
      
      // Publish the track with proper naming
      await this.room.localParticipant.publishTrack(track, { 
        name: routeKey // This will be "from-ParticipantName"
      });

      // Store the route
      this.routes.set(participantIdentity, {
        key: routeKey,
        voiceId: voiceInfo.voiceId,
        source: source,
        track: track
      });

      console.log(`🔗 Route created for ${participantIdentity} with voice ${voiceInfo.voiceName}`);
      
      // Check if there's already a subscribed audio track for this participant
      this.startAudioStreamIfTrackExists(participantIdentity);
    } catch (error) {
      console.error(`❌ Error setting up route for ${participantIdentity}:`, error);
    }
  }

  // Helper method to start audio stream if track already exists
  startAudioStreamIfTrackExists(participantIdentity) {
    try {
      if (!this.room) return;
      
      const participantMap = this.room.participants ?? this.room.remoteParticipants ?? new Map();
      for (const p of participantMap.values()) {
        if (p.identity === participantIdentity) {
          // Check for existing audio tracks
          if (p.audioTracks && typeof p.audioTracks.values === 'function') {
            for (const pub of p.audioTracks.values()) {
              const trackObj = pub?.track;
              if (trackObj && !this.activeS2S.has(participantIdentity)) {
                console.log(`🔄 Starting audio stream for existing track from ${participantIdentity}`);
                this._startAudioStream(trackObj, participantIdentity);
                break; // Only start one stream per participant
              }
            }
          }
          break;
        }
      }
    } catch (error) {
      console.warn(`Failed to check for existing track for ${participantIdentity}:`, error.message);
    }
  }

  // Recreate route for participant when AudioSource becomes invalid
  async recreateRouteForParticipant(participantIdentity) {
    try {
      console.log(`🔧 Recreating route for ${participantIdentity}...`);
      
      // Get the existing voice info
      const voiceInfo = this.participantVoices.get(participantIdentity);
      if (!voiceInfo) {
        console.warn(`⚠️ No voice info found for ${participantIdentity}, cannot recreate route`);
        return;
      }

      // Clean up old route
      const oldRoute = this.routes.get(participantIdentity);
      if (oldRoute) {
        try {
          if (oldRoute.track) {
            await this.room.localParticipant.unpublishTrack(oldRoute.track);
          }
        } catch (error) {
          console.warn(`⚠️ Failed to unpublish old track for ${participantIdentity}: ${error.message}`);
        }
        this.routes.delete(participantIdentity);
      }

      // Create new route with new AudioSource
      const routeKey = `from-${participantIdentity}`;
      const source = new AudioSource(48000, 1); // 48kHz mono
      const track = LocalAudioTrack.createAudioTrack(routeKey, source);
      
      // Publish the new track
      await this.room.localParticipant.publishTrack(track, { 
        name: routeKey 
      });

      // Store the new route
      this.routes.set(participantIdentity, {
        key: routeKey,
        voiceId: voiceInfo.voiceId,
        source: source,
        track: track
      });

      console.log(`✅ Route recreated for ${participantIdentity} with voice ${voiceInfo.voiceName}`);
    } catch (error) {
      console.error(`❌ Failed to recreate route for ${participantIdentity}:`, error.message);
    }
  }

  async handleParticipantDisconnected(participant) {
    const participantIdentity = participant.identity;
    console.log(`🧹 Cleaning up resources for: ${participantIdentity}`);
    
    // Stop any active audio processing immediately
    this.activeS2S.delete(participantIdentity);
    
    // Clean up route
    const route = this.routes.get(participantIdentity);
    if (route) {
      try {
        // Null out the source to prevent further use
        if (route.source) {
          route.source = null;
        }
        if (route.track) {
          await this.room.localParticipant.unpublishTrack(route.track);
        }
        this.routes.delete(participantIdentity);
        console.log(`✅ Route cleaned up for: ${participantIdentity}`);
      } catch (error) {
        console.error(`Error cleaning up route for ${participantIdentity}:`, error);
      }
    }
    
    // Clean up voice selection
    this.participantVoices.delete(participantIdentity);
  }







  // Legacy methods removed - using simplified sendS2SChunk approach

  // Simplified room status for debugging
  getRoomStatus() {
    if (!this.room) {
      return { connected: false };
    }

    const { list, count } = safeParticipants(this.room);
    
    return {
      connected: this.room.state === ConnectionState.Connected,
      roomName: this.room.name,
      participantCount: count,
      activeRoutes: this.routes.size,
      activeVoiceTransforms: this.activeS2S.size
    };
  }

  // Unified starter for LiveKit AudioStream (Node SDK uses async iterator)
  _startAudioStream(track, speaker) {
    // ignore our own worker-published tracks
    if (!track || !speaker || speaker.startsWith('audio-worker-')) return;
    
    // Prevent multiple streams for the same speaker
    if (this.activeS2S.has(speaker)) {
      console.log(`🔄 Audio stream already active for ${speaker}, skipping duplicate`);
      return;
    }
    
    const stream = new AudioStream(track);
    const route = this.routes?.get(speaker);
    if (!route || !route.source || !route.voiceId) {
      console.warn(`⚠️ No route available for ${speaker}, skipping stream`);
      return;
    }
    
    this.activeS2S.add(speaker);
    console.log(`🎙️ Starting audio stream for ${speaker} with voice ${route.voiceId}`);
    
    // Chunk input PCM and send via multipart/form-data to ElevenLabs S2S
    (async () => {
      try {
        const samplesPerChunk = Math.max(1, Math.floor((VOICE_SAMPLE_RATE * S2S_CHUNK_MS) / 1000));
        let buffers = [];
        let totalSamples = 0;
        let lastChunkTime = 0;
        const minChunkInterval = 200; // Minimum 200ms between chunks to avoid API spam and reduce processing load

        for await (const frame of stream) {
          const src = frame?.data instanceof Int16Array
            ? frame.data
            : (frame?.data && frame?.data.buffer ? new Int16Array(frame.data.buffer) : null);
          if (!src || src.length === 0) continue;
          
          // Only log every 50th frame to avoid spam
          if (Math.random() < 0.02) console.log(`📊 Processing audio from ${speaker}: ${src.length} samples`);
          
          buffers.push(src);
          totalSamples += src.length;

          const now = Date.now();
          const timeSinceLastChunk = now - lastChunkTime;
          if (totalSamples >= samplesPerChunk && timeSinceLastChunk >= minChunkInterval) {
            // Merge accumulated buffers
            const merged = new Int16Array(totalSamples);
            let o = 0;
            for (const b of buffers) { merged.set(b, o); o += b.length; }
            buffers = [];
            totalSamples = 0;
            lastChunkTime = now;

            // Send chunk to ElevenLabs (multipart with audio field)
            try {
              await this.sendS2SChunk(speaker, merged);
            } catch (chunkError) {
              console.warn(`⚠️ S2S chunk processing failed for ${speaker}: ${chunkError.message}`);
              if (chunkError.message.includes('InvalidState')) {
                console.log(`🔌 Stopping audio processing for ${speaker} due to InvalidState`);
                this.activeS2S.delete(speaker);
                break; // Exit the audio stream loop
              }
            }
          }
        }

        // Flush remaining if there's enough audio content
        if (totalSamples > samplesPerChunk / 2) { // Only flush if we have at least half a chunk
          const merged = new Int16Array(totalSamples);
          let o = 0;
          for (const b of buffers) { merged.set(b, o); o += b.length; }
          try {
            await this.sendS2SChunk(speaker, merged);
          } catch (flushError) {
            console.warn(`⚠️ S2S flush processing failed for ${speaker}: ${flushError.message}`);
            if (flushError.message.includes('InvalidState')) {
              console.log(`🔌 Stopping audio processing for ${speaker} during flush due to InvalidState`);
              this.activeS2S.delete(speaker);
            }
          }
        }
        
        console.log(`🔚 Audio stream ended for ${speaker}`);
      } catch (e) {
        console.error(`❌ Voice convert chunking error for ${speaker}:`, e.message || e);
      } finally {
        this.activeS2S.delete(speaker);
      }
    })();
  }

  // Send a single chunk to ElevenLabs S2S and publish their response into the route's out AudioSource
  async sendS2SChunk(speakerIdentity, int16) {
    try {
      // Check if we should still be processing (room still connected)
      if (!this.room || this.room.state !== ConnectionState.Connected) {
        console.log(`🔌 Room not connected - skipping chunk for ${speakerIdentity}`);
        return;
      }
      
      const route = this.routes?.get(speakerIdentity);
      if (!route || !route.source || !route.voiceId) {
        console.warn(`⚠️ No route found for speaker: ${speakerIdentity}`);
        return;
      }

      // Check if we've hit quota limits recently
      if (this.quotaExhausted && Date.now() - this.quotaExhausted < 60000) {
        // Skip processing for 1 minute after quota exhaustion
        return;
      }

      // Calculate audio level to avoid processing silence
      const rmsLevel = rmsDbFS(int16);
      if (rmsLevel < SILENCE_DB) {
        // Skip processing if audio is too quiet (likely silence)
        return;
      }
      
      // Also skip very quiet audio that might cause issues
      if (rmsLevel < -55) {
        return;
      }

      console.log(`🎵 Processing audio chunk for ${speakerIdentity} with voice ${route.voiceId} (level: ${rmsLevel.toFixed(1)}dB)`);
      
      // Convert PCM to WAV buffer
      const wav = pcmToWavBuffer(int16, VOICE_SAMPLE_RATE);

      // Build multipart/form-data manually (Node-safe)
      const boundary = `----lk-el-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
      const partHeader = Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="audio"; filename="chunk.wav"\r\n` +
        `Content-Type: audio/wav\r\n\r\n`
      );
      const partFooter = Buffer.from(`\r\n--${boundary}--\r\n`);
      const body = Buffer.concat([partHeader, wav, partFooter]);

      const res = await fetch(`https://api.elevenlabs.io/v1/speech-to-speech/${route.voiceId}/stream?output_format=pcm_48000&optimize_streaming_latency=4`, {
        method: 'POST',
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
        timeout: 30000 // 30 second timeout
      });
      
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        
        // Handle quota exhaustion and rate limiting
        if ((res.status === 401 || res.status === 429) && (text.includes('quota_exceeded') || text.includes('quota'))) {
          console.error('💳 ElevenLabs quota exhausted - pausing requests for 1 minute');
          this.quotaExhausted = Date.now();
          return;
        }
        
        if (res.status === 429) {
          console.warn('⏰ Rate limited by ElevenLabs - backing off');
          this.quotaExhausted = Date.now();
          return;
        }
        
        console.error('ElevenLabs S2S error', res.status, text);
        return;
      }

      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) {
        console.warn('⚠️ Received empty response from ElevenLabs');
        return;
      }

      // Response is raw PCM 48k mono Int16 – publish in 20ms frames
      let pcmAll;
      try {
        pcmAll = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
        const samplesPer20ms = Math.floor(48000 * 0.02); // 960
        
        if (!route.source) {
          console.warn(`⚠️ Route source no longer available for ${speakerIdentity}`);
          return;
        }
        
        let framesPublished = 0;
        for (let i = 0; i + samplesPer20ms <= pcmAll.length; i += samplesPer20ms) {
          const slice = pcmAll.subarray(i, i + samplesPer20ms);
          try {
            // Check if route still exists and source is valid
            if (!this.routes.has(speakerIdentity) || !route.source) {
              console.warn(`⚠️ Route became invalid during processing for ${speakerIdentity}`);
              break;
            }
            
            const frame = AudioFrame.create(48000, 1, slice.length);
            new Int16Array(frame.data.buffer).set(slice);
            
            // Check if we should still be processing and route is valid
            if (!this.room || this.room.state !== ConnectionState.Connected) {
              console.log(`🔌 Room disconnected during processing for ${speakerIdentity}`);
              break;
            }
            
            if (!this.routes.has(speakerIdentity) || !this.routes.get(speakerIdentity).source) {
              console.log(`🔌 Route invalid during processing for ${speakerIdentity}`);
              break;
            }
            
            // Wrap captureFrame in additional try-catch to handle InvalidState
            try {
              route.source.captureFrame(frame);
              framesPublished++;
            } catch (captureError) {
              if (captureError.message.includes('InvalidState') || captureError.message.includes('failed to capture frame')) {
                // Only attempt recovery if we haven't recently recreated this route
                if (!this.recentlyRecreated.has(speakerIdentity)) {
                  console.log(`🔄 AudioSource invalid for ${speakerIdentity} - attempting recovery`);
                  this.recentlyRecreated.add(speakerIdentity);
                  // Clear the flag after 5 seconds to allow future recovery attempts
                  setTimeout(() => this.recentlyRecreated.delete(speakerIdentity), 5000);
                  // Try to recreate the AudioSource and route
                  await this.recreateRouteForParticipant(speakerIdentity);
                }
                // Stop processing this chunk, but allow future chunks to try the new route
                throw captureError; 
              }
              console.warn(`⚠️ AudioSource.captureFrame failed: ${captureError.message}`);
              throw captureError;
            }
          } catch (frameError) {
            console.warn(`⚠️ Failed to capture audio frame ${framesPublished + 1}: ${frameError.message}`);
            
            // If it's an InvalidState error, the participant likely disconnected
            if (frameError.message.includes('InvalidState')) {
              console.log(`🔌 Participant ${speakerIdentity} appears to have disconnected - stopping processing`);
              this.activeS2S.delete(speakerIdentity);
            }
            break; // Stop processing this chunk
          }
        }
        
        // Mark successful call
        this.lastSuccessfulCall = Date.now();
        if (this.quotaExhausted) {
          console.log('🎉 ElevenLabs quota appears to be restored - resuming processing');
          this.quotaExhausted = null;
        }
        
        console.log(`✅ Voice transformation complete for ${speakerIdentity}, sent ${pcmAll.length} samples (${framesPublished} frames)`);
      } catch (pcmError) {
        console.warn(`⚠️ Failed to process PCM data for ${speakerIdentity}: ${pcmError.message}`);
        return;
      }
    } catch (e) {
      // Handle network timeouts and other errors gracefully
      if (e.name === 'TimeoutError' || e.code === 'ETIMEDOUT') {
        console.warn('⏰ ElevenLabs request timed out - skipping chunk');
      } else {
        console.error(`❌ sendS2SChunk failed for ${speakerIdentity}:`, e.message || e);
      }
    }
  }

  // Removed duplicate methods - using _startAudioStream and sendS2SChunk instead
}

// Voice transformation pipeline is now handled directly in the class methods

// Main execution
async function main() {
  console.log('🚀 Starting LiveKit Audio Worker with STT → TTS Pipeline...');
  
  const worker = new LiveKitAudioWorker();
  
  try {
    // Get room name from command line args or use default
    const roomName = process.argv[2] || 'default-room';
    
    await worker.connectToRoom(roomName);
    
    // Log status every 30 seconds - capture room reference to avoid scope issues
    const roomRef = worker.room;
    setInterval(() => {
      logRoomStatus(roomRef, 'Periodic');
    }, 30000);
    
    console.log('✅ Audio worker with STT → TTS pipeline is running. Press Ctrl+C to stop.');
    
  } catch (error) {
    console.error('❌ Failed to start audio worker:', error);
    process.exit(1);
  }
}

// Run the worker
if (require.main === module) {
  main();
}

module.exports = LiveKitAudioWorker; 