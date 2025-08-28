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

const express = require('express');
const { AccessToken } = require('livekit-server-sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// CORS middleware for development
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// In-memory storage for user voice selections
const userVoiceSelections = new Map();

// Serve index.html at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// LiveKit token generation endpoint
app.get('/get-token', async (req, res) => {
  try {
    const { roomName, identity } = req.query;
    
    console.log('🔍 [BACKEND] Token request received:');
    console.log('  - LIVEKIT_API_KEY:', process.env.LIVEKIT_API_KEY);
    console.log('  - LIVEKIT_WS_URL:', process.env.LIVEKIT_WS_URL);
    console.log('  - roomName:', roomName);
    console.log('  - identity:', identity);
    
    if (!roomName || !identity) {
      return res.status(400).json({ 
        error: 'Missing required parameters: roomName and identity' 
      });
    }

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    
    if (!apiKey || !apiSecret) {
      return res.status(500).json({ 
        error: 'LiveKit credentials not configured' 
      });
    }

    // Create access token
    const at = new AccessToken(apiKey, apiSecret, { identity });
    at.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });

    const token = await at.toJwt();
    
    res.json({
      token,
      wsUrl: process.env.LIVEKIT_WS_URL,
      room: roomName,
      identity
    });
  } catch (error) {
    console.error('Error generating LiveKit token:', error);
    res.status(500).json({ 
      error: 'Failed to generate token',
      details: error.message 
    });
  }
});

// ElevenLabs voices listing endpoint
app.get('/voices', async (req, res) => {
  try {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    
    if (!apiKey) {
      return res.status(500).json({ 
        error: 'ElevenLabs API key not configured' 
      });
    }

    const response = await fetch('https://api.elevenlabs.io/v1/voices', {
      method: 'GET',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => null);
      
      // Handle specific ElevenLabs API errors
      if (response.status === 401) {
        const errorMessage = errorData?.detail?.message || 'Unauthorized - check API key and permissions';
        console.error('ElevenLabs API authentication error:', errorMessage);
        return res.status(500).json({ 
          error: 'ElevenLabs API authentication failed',
          details: errorMessage,
          hint: 'Please check your API key has voices_read permission at https://elevenlabs.io/app/settings'
        });
      }
      
      throw new Error(`ElevenLabs API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    // Return the raw JSON voice list from ElevenLabs
    res.json(data);
  } catch (error) {
    console.error('Error fetching ElevenLabs voices:', error);
    res.status(500).json({ 
      error: 'Failed to fetch voices',
      details: error.message 
    });
  }
});

// Voice selection endpoint
app.post('/set-voice', (req, res) => {
  try {
    const { userId, voiceId } = req.body;
    
    if (!userId || !voiceId) {
      return res.status(400).json({ 
        error: 'Missing required parameters: userId and voiceId' 
      });
    }

    // Store voice selection in memory (simple userId -> voiceId mapping)
    userVoiceSelections.set(userId, voiceId);

    res.json({
      success: true
    });
  } catch (error) {
    console.error('Error setting voice selection:', error);
    res.status(500).json({ 
      error: 'Failed to save voice selection',
      details: error.message 
    });
  }
});

// Get user's current voice selection
app.get('/get-voice/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    
    const voiceSelection = userVoiceSelections.get(userId);
    
    if (!voiceSelection) {
      // Return default voice if none selected
      return res.json({
        success: true,
        userId,
        voiceSelection: 'pNInz6obpgDQGcFmaJgB' // Adam voice as default
      });
    }

    res.json({
      success: true,
      userId,
      voiceSelection
    });
  } catch (error) {
    console.error('Error getting voice selection:', error);
    res.status(500).json({ 
      error: 'Failed to get voice selection',
      details: error.message 
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    details: err.message 
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Route not found',
    path: req.originalUrl 
  });
});

// Start server
console.log(`🚀 Starting server on port ${PORT}...`);
console.log(`💡 Use 'npm run start:dev' to automatically kill any existing process on port ${PORT}`);
console.log(`💡 Do NOT run 'node server.js' manually if you're using 'npm run dev'`);

const server = app.listen(PORT, () => {
  console.log(`✅ Server successfully running on port ${PORT}`);
  console.log(`📡 LiveKit signaling server ready`);
  console.log(`🎤 ElevenLabs voice API integration active`);
  console.log(`🌍 Health check: http://localhost:${PORT}`);
});

// Handle port already in use error
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use!`);
    console.error(`💡 Try running: npm run start:dev`);
    console.error(`💡 Or manually kill the process: npm run kill-3000`);
    process.exit(1);
  } else {
    console.error('❌ Server error:', err);
    process.exit(1);
  }
});

module.exports = app; 