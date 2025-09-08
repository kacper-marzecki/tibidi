import { useState, useEffect, useRef } from 'react';
import Peer from 'peerjs';
import type { DataConnection } from 'peerjs';
import { QRCodeSVG } from 'qrcode.react';
import { Html5QrcodeScanner } from 'html5-qrcode';
import './App.css';

function App() {
  const [peerId, setPeerId] = useState('');
  const [remotePeerId, setRemotePeerId] = useState('');
  const [connections, setConnections] = useState<Record<string, DataConnection>>({});
  const [messageInput, setMessageInput] = useState('');
  const [messages, setMessages] = useState<string[]>([]);
  const [isScannerOpen, setIsScannerOpen] = useState(false);

  const peerInstance = useRef<Peer | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scannerRef = useRef<Html5QrcodeScanner | null>(null);

  useEffect(() => {
    // For a production app, you'd host your own PeerJS server.
    const peer = new Peer({
      debug: 2,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun2.l.google.com:19302' },
          // You can add more STUN servers here if needed
        ],
      },
    });

    peer.on('open', (id) => {
      console.log('My peer ID is: ' + id);
      setPeerId(id);
    });

    peer.on('connection', (conn) => {
      console.log(`Incoming connection from ${conn.peer}`);
      setupConnection(conn);
    });

    peer.on('error', (err) => {
      console.error('PeerJS error:', err);
      alert(`An error occurred with PeerJS: ${err.message}`);
    });

    peerInstance.current = peer;

    return () => {
      peer.destroy();
    };
  }, []);

  useEffect(() => {
    // Auto-scroll to the latest message
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (isScannerOpen) {
      const onScanSuccess = (decodedText: string) => {
        console.log(`QR Code detected: ${decodedText}`);
        setRemotePeerId(decodedText);
        connectToPeer(decodedText);
        setIsScannerOpen(false); // Close scanner on success
      };

      const onScanFailure = (error: string) => {
        // This callback is called frequently, so we can ignore non-critical errors.
        // console.warn(`QR scan error: ${error}`);
      };

      const scanner = new Html5QrcodeScanner(
        'qr-reader',
        {
          fps: 10,
          qrbox: { width: 250, height: 250 },
        },
        /* verbose= */ false
      );
      scanner.render(onScanSuccess, onScanFailure);
      scannerRef.current = scanner;
    }

    return () => {
      if (scannerRef.current) {
        scannerRef.current.clear().catch(error => {
          console.error('Failed to clear QR scanner.', error);
        });
        scannerRef.current = null;
      }
    };
  }, [isScannerOpen]);

  const setupConnection = (conn: DataConnection) => {
    conn.on('open', () => {
      console.log(`Connection to ${conn.peer} is open.`);
      setConnections(prev => ({ ...prev, [conn.peer]: conn }));
    });

    conn.on('data', (data) => {
      console.log(`Received data from ${conn.peer}:`, data);
      setMessages(prev => [...prev, `${conn.peer}: ${data}`]);
    });

    conn.on('close', () => {
      console.log(`Connection to ${conn.peer} has closed.`);
      setConnections(prev => {
        const newConns = { ...prev };
        delete newConns[conn.peer];
        return newConns;
      });
    });

    conn.on('error', (err) => {
      console.error(`Connection error with ${conn.peer}:`, err);
    });
  };

  const connectToPeer = (peerIdToConnect: string) => {
    if (peerIdToConnect && peerIdToConnect !== peerId) {
      if (connections[peerIdToConnect]) {
        console.log(`Already connected to ${peerIdToConnect}`);
        return;
      }
      if (!peerInstance.current) {
        alert('Peer instance not ready.');
        return;
      }
      console.log(`Connecting to ${peerIdToConnect}...`);
      const conn = peerInstance.current.connect(peerIdToConnect, {
        reliable: true,
      });
      setupConnection(conn);
    } else if (peerIdToConnect === peerId) {
      alert("You cannot connect to yourself.");
    } else {
      alert('Please enter or scan a valid remote Peer ID.');
    }
  };

  const handleConnect = () => {
    connectToPeer(remotePeerId);
  };

  const handleSendMessage = () => {
    if (messageInput) {
      setMessages(prev => [...prev, `You: ${messageInput}`]);

      Object.values(connections).forEach(conn => {
        if (conn.open) {
          conn.send(messageInput);
        }
      });
      setMessageInput('');
    }
  };

  const connectedPeers = Object.keys(connections);

  return (
    <div className="bg-gray-100 text-gray-800 font-sans p-4 md:p-8 min-h-screen">
      {/* Scanner Modal */}
      {isScannerOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex justify-center items-center z-50 p-4">
          <div className="bg-white p-6 rounded-lg shadow-xl w-full max-w-md">
            <h3 className="text-xl font-semibold mb-4 text-center">Scan Peer ID QR Code</h3>
            <div id="qr-reader" className="w-full"></div>
            <button
              onClick={() => setIsScannerOpen(false)}
              className="mt-4 w-full px-4 py-2 bg-red-500 text-white rounded-md hover:bg-red-600 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <h1 className="text-3xl font-bold text-gray-700 mb-6 text-center">P2P Task List - Device Pairing</h1>

      <div className="max-w-4xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Left Column for Connection Management */}
        <div className="flex flex-col gap-6">
          <div className="bg-white rounded-lg shadow-md p-6">
            <h2 className="text-2xl font-semibold text-gray-700 mb-3">Your Device</h2>
            <p>Your Peer ID: <strong className="font-bold text-blue-600 break-all">{peerId || 'Initializing...'}</strong></p>
            {peerId && (
              <div className="mt-4 p-4 bg-gray-50 rounded-md flex justify-center">
                <QRCodeSVG value={peerId} size={160} bgColor="#f9fafb" fgColor="#1f2937" />
              </div>
            )}
            <p className="text-sm text-gray-500 mt-2">Share this ID or let another user scan this QR code to connect.</p>
          </div>

          <div className="bg-white rounded-lg shadow-md p-6">
            <h2 className="text-2xl font-semibold text-gray-700 mb-3">Connect to another Device</h2>
            <div className="flex items-center">
              <input
                type="text"
                placeholder="Enter another user's Peer ID"
                className="p-2 border border-gray-300 rounded-l-md w-full focus:ring-blue-500 focus:border-blue-500"
                value={remotePeerId}
                onChange={(e) => setRemotePeerId(e.target.value)}
              />
              <button
                onClick={handleConnect}
                className="px-4 py-2 bg-blue-500 text-white rounded-r-md hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50"
              >
                Connect
              </button>
            </div>
            <button
              onClick={() => setIsScannerOpen(true)}
              className="mt-4 w-full px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-opacity-50"
            >
              Scan QR Code
            </button>
          </div>

          <div className="bg-white rounded-lg shadow-md p-6">
            <h2 className="text-2xl font-semibold text-gray-700 mb-3">Connection Status</h2>
            <ul className="list-none p-0">
              {connectedPeers.length === 0 ? (
                <li className="bg-gray-100 text-gray-500 p-3 rounded-md">Not connected to any peers.</li>
              ) : (
                connectedPeers.map(peerId => {
                  const conn = connections[peerId];
                  const baseClasses = 'p-3 rounded-md mb-2 text-sm break-all';
                  if (conn && conn.open) {
                    return <li key={peerId} className={`bg-green-100 text-green-800 font-semibold ${baseClasses}`}>Connected to {peerId}</li>;
                  } else {
                    return <li key={peerId} className={`bg-yellow-100 text-yellow-800 ${baseClasses}`}>Connecting to {peerId}...</li>;
                  }
                })
              )}
            </ul>
          </div>
        </div>

        {/* Right Column for Messaging */}
        <div className="bg-white rounded-lg shadow-md p-6 flex flex-col">
          <h2 className="text-2xl font-semibold text-gray-700 mb-3">Send a Message</h2>
          <div className="flex items-center mb-4">
            <input
              type="text"
              placeholder="Type a message..."
              className="p-2 border border-gray-300 rounded-l-md w-full focus:ring-blue-500 focus:border-blue-500"
              value={messageInput}
              onChange={(e) => setMessageInput(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleSendMessage()}
            />
            <button
              onClick={handleSendMessage}
              className="px-4 py-2 bg-green-500 text-white rounded-r-md hover:bg-green-600 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-opacity-50"
            >
              Send to All
            </button>
          </div>
          <h3 className="text-xl font-semibold text-gray-700 mt-4 mb-2">Received Messages</h3>
          <div className="list-none p-3 bg-gray-50 rounded-md h-64 overflow-y-auto">
            {messages.map((message, index) => (
              <p key={index} className="bg-white p-2 rounded-md mb-2 shadow-sm text-sm break-words">
                {message}
              </p>
            ))}
            <div ref={messagesEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
