# Advanced WebRTC VoIP App

A production-grade, highly-resilient, peer-to-peer VoIP and video conferencing application built with modern WebRTC, Socket.io, and Node.js. 

This application features a gorgeous glass-morphism aesthetic UI and is engineered to automatically handle network turbulence, ICE candidate glare, and seamless hardware hot-swapping.

## ✨ Features

- **Mesh Video & Audio Conferencing**: Multi-party peer-to-peer WebRTC video and audio rooms.
- **Hardware Hot-Swapping**: Switch microphones or cameras mid-call without dropping the connection or needing to refresh the page.
- **Active Speaker Detection**: Real-time Web Audio API `AnalyserNode` integration dynamically highlights the current speaker with a glowing green border.
- **Fullscreen Focus Mode**: Click on any participant's video to pin them and expand their feed to fill the entire video grid. Click the 'X' to unpin.
- **Real-Time P2P File Transfer**: Share files (up to 50MB) directly between peers via WebRTC `RTCDataChannel` bypassing the server entirely for maximum privacy and speed. Includes a live progress bar.
- **Screen Sharing**: Instantly present your screen or application windows to the room.
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
   git clone <repo-url>
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
- **Helmet Integration**: Strict Content Security Policies (CSP) are enforced to prevent XSS.
- **Rate Limiting**: Socket.io event rate-limiting protects against signaling DDoS.
- **Data Channels**: Text chat and file transfers flow directly over P2P encrypted channels. The server never sees your messages or files.

## 🛠 Tech Stack
- **Frontend**: Vanilla JavaScript (ES6+), HTML5, custom CSS (no heavy frameworks).
- **Backend**: Node.js, Express.js.
- **Signaling**: Socket.io.
- **Media**: WebRTC (`RTCPeerConnection`, `RTCDataChannel`, `getUserMedia`, `getDisplayMedia`), Web Audio API.

## 🤝 Contributing
Contributions, issues, and feature requests are welcome! Feel free to check the issues page.

## 📝 License
This project is open-source and available under the [MIT License](LICENSE).
