# Voice Transformation Room

A real-time voice transformation application using LiveKit and ElevenLabs.

## Core Functionality

**When one user talks, their voice is captured, transformed into their chosen voice, and outputted to other users in the same room.**

## Features

- 🎤 **Real-time Voice Capture**: Captures audio from participants using LiveKit
- 🗣️ **Voice Transformation**: Transforms voices using ElevenLabs Speech-to-Speech API
- 🔊 **Live Audio Output**: Outputs transformed audio to other participants in real-time
- ⚡ **Low Latency**: Optimized for real-time voice communication

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Create a `.env` file in the project root with your credentials:

```bash
# LiveKit Configuration
LIVEKIT_API_KEY=your_livekit_api_key_here
LIVEKIT_API_SECRET=your_livekit_api_secret_here
LIVEKIT_WS_URL=wss://your-livekit-server.com

# ElevenLabs Configuration
ELEVENLABS_API_KEY=your_elevenlabs_api_key_here

# Server Configuration
PORT=3000
```

**Note**: Both the server and audio worker use the same environment variables.

### 3. Start the Application

```bash
# Start the server
npm run start:dev
```

Server will be available at `http://localhost:3000`

```bash
# Start the voice transformation worker (in another terminal)
npm run worker testroom
```

### 4. Use the Application

1. Open `http://localhost:3000` in multiple browser tabs
2. Enter different names for each tab 
3. Select a voice for each participant
4. Join the room
5. Start talking - your voice will be transformed and heard by others!

## How It Works

**Real-time Voice Transformation Pipeline**:

1. 🎙️ **Capture**: User speaks into their microphone
2. 🔄 **Transform**: Audio is sent to ElevenLabs Speech-to-Speech API with their selected voice
3. 🔊 **Output**: Transformed audio is played to other participants in the room

**Technical Implementation**:
- Uses LiveKit for real-time audio streaming
- ElevenLabs Speech-to-Speech API for voice transformation
- Processes audio in real-time chunks for low latency
- Manages voice selections per participant

## Core API Endpoints

The application uses these essential endpoints for voice transformation:

### Get LiveKit Token
```
GET /get-token?roomName=<room>&identity=<user>
```
Returns authentication token for joining the voice room.

### List Available Voices  
```
GET /voices
```
Returns available ElevenLabs voices for selection.

### Set User Voice
```
POST /set-voice
```
Stores voice selection for a user.

### Get User Voice
```
GET /get-voice/:userId
```
Retrieves stored voice selection for a user.

## Requirements

- Node.js 18+
- LiveKit server instance
- ElevenLabs API key with Speech-to-Speech access

## Environment Variables

Create a `.env` file with:
```
LIVEKIT_WS_URL=wss://your-livekit-server.com
LIVEKIT_API_KEY=your_api_key
LIVEKIT_API_SECRET=your_api_secret
ELEVENLABS_API_KEY=your_elevenlabs_key
PORT=3000
```

That's it! The application is now streamlined to focus purely on voice transformation between users in the same room. 