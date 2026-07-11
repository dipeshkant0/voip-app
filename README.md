# Advanced WebRTC VoIP App

A production-grade, highly-resilient, peer-to-peer VoIP and video conferencing application built with modern WebRTC, Socket.io, and Node.js. 

This application features a gorgeous glass-morphism aesthetic UI and is engineered from the ground up to be CPU-optimized, strictly memory-managed, and capable of handling complex network turbulence, ICE candidate glare, and seamless hardware hot-swapping.

## ✨ Features

- **Mesh Video & Audio Conferencing**: Multi-party peer-to-peer WebRTC video and audio rooms.
- **Flawless Three-Tier Viewing**: 
  - **Grid View**: Fluid CSS grids that dynamically scale from 1 column on mobile up to multi-column ultra-wide arrays.
  - **Focus Mode**: Click any participant's video to seamlessly expand their feed across the browser layout.
  - **Native OS Fullscreen**: Dedicated fullscreen toggles utilizing native browser APIs (with full iOS Safari compatibility).
- **Zero-DOM-Thrash UI Engine**: Highly optimized UI state management using cached DOM lookups, `requestAnimationFrame`, and CSS class toggling to minimize layout repaints and CPU drain.
- **Hardware Hot-Swapping**: Switch microphones or cameras mid-call without dropping the connection or needing to refresh the page.
- **Active Speaker Detection**: Real-time Web Audio API `AnalyserNode` integration dynamically highlights the current speaker with a glowing green border using a throttled, memory-safe animation loop.
- **Real-Time P2P File Transfer**: Share files (up to 50MB) directly between peers via WebRTC `RTCDataChannel` bypassing the server entirely for maximum privacy and speed. Includes advanced ArrayBuffer garbage collection to prevent memory leaks during aborted transfers.
- **Screen Sharing**: Instantly present your screen or application windows to the room. Protected against audio-feedback echo loops.
- **Local Call Recording**: Record your active meeting (your screen and all incoming peer audio) directly in the browser and save it locally as an MP4/WebM.
- **Enterprise NAT Traversal**: Built-in support for Twilio NTS and Metered TURN APIs for bypassing strict corporate firewalls.
- **Signaling Resilience**: Fully promise-queued WebRTC signaling negotiation that perfectly mitigates "Glare" collisions when multiple peers upgrade their streams simultaneously.

## 🚀 Getting Started

### Prerequisites
- Node.js (v18 or higher recommended)
- A modern browser that supports WebRTC (Chrome, Firefox, Safari, Edge)

### Installation

1. Clone the repository and navigate into it:
   ```bash
   git clone https://github.com/dipeshkant0/voip-app.git
   cd voip-app
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file based on `.env.example` (or configure directly):
   ```bash
   PORT=3000
   
   # Optional: Configure custom STUN/TURN servers to bypass NATs/Firewalls
   # TWILIO_ACCOUNT_SID=your_sid
   # TWILIO_AUTH_TOKEN=your_token
   # METERED_PROJECT=your_project
   # METERED_API_KEY=your_key
   ```

4. Start the server:
   ```bash
   npm start
   ```
   *For development with auto-reloading, run `npm run dev` (requires `nodemon`).*

5. Open your browser and navigate to `http://localhost:3000` (or your configured port/domain).

## 🔒 Security & Performance
- **Zero-Knowledge Architecture**: The server does not intercept or decrypt WebRTC media, chat payloads, or file transfers.
- **Hardened CSP**: Strict Content Security Policies (CSP) are enforced to prevent XSS (zero reliance on `unsafe-inline` scripts).
- **Rate Limiting**: Socket.io event rate-limiting protects against signaling DDoS.
- **Memory Optimized**: Strict event cleanup, `Set` management for typing indicators, and recursive array clearing ensure V8 Garbage Collection runs perfectly without orphaned memory blocks.

## 🛠 Tech Stack
- **Frontend**: Vanilla JavaScript (ES6+), HTML5, custom CSS (no heavy frameworks).
- **Backend**: Node.js, Express.js.
- **Signaling**: Socket.io.
- **Media**: WebRTC (`RTCPeerConnection`, `RTCDataChannel`, `getUserMedia`, `getDisplayMedia`), Web Audio API.

## 🤝 Contributing
Contributions, issues, and feature requests are welcome! Feel free to check the issues page.

## 📝 License
This project is open-source and available under the [MIT License](LICENSE).
