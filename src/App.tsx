import { useState, useEffect, useRef, useCallback } from 'react';
import Peer from 'peerjs';
import type { DataConnection } from 'peerjs';
import { QRCodeSVG } from 'qrcode.react';
import { Html5QrcodeScanner } from 'html5-qrcode';
import './App.css'; // Assuming you have your CSS set up

// --- Helper Functions for Local Storage ---
const MY_PEER_ID_KEY = 'myPeerId';
const REMEMBERED_PEERS_KEY = 'rememberedPeerConnections';

function getMyStoredPeerId(): string | null {
  return localStorage.getItem(MY_PEER_ID_KEY);
}

function setMyStoredPeerId(id: string) {
  localStorage.setItem(MY_PEER_ID_KEY, id);
}

function getRememberedPeers(): string[] {
  try {
    const stored = localStorage.getItem(REMEMBERED_PEERS_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch (e) {
    console.error("Failed to parse remembered peers from localStorage", e);
    return [];
  }
}

function addRememberedPeer(id: string) {
  const currentPeers = getRememberedPeers();
  if (!currentPeers.includes(id)) {
    const newPeers = [...currentPeers, id];
    localStorage.setItem(REMEMBERED_PEERS_KEY, JSON.stringify(newPeers));
  }
}

function removeRememberedPeer(id: string) {
  const currentPeers = getRememberedPeers();
  const newPeers = currentPeers.filter(peerId => peerId !== id);
  localStorage.setItem(REMEMEBERED_PEERS_KEY, JSON.stringify(newPeers));
}

// Function to generate a UUID (simple version, for production consider a dedicated library or crypto.randomUUID)
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0,
      v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// --- App Component ---
function App() {
  const [peerId, setPeerId] = useState('');
  const [remotePeerIdInput, setRemotePeerIdInput] = useState(''); // Changed name to avoid confusion with actual remotePeerId
  const [connections, setConnections] = useState<Record<string, DataConnection>>({});
  const [messageInput, setMessageInput] = useState('');
  const [messages, setMessages] = useState<string[]>([]);
  const [isScannerOpen, setIsScannerOpen] = useState(false);

  const peerInstance = useRef<Peer | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scannerRef = useRef<Html5QrcodeScanner | null>(null);

  // Store retry attempts for auto-reconnection
  const reconnectionAttempts = useRef<Record<string, number>>({});
  const reconnectionTimers = useRef<Record<string, NodeJS.Timeout>>({}); // NodeJS.Timeout for better type safety with setTimeout
  const MAX_RETRY_ATTEMPTS = 10;
  const RETRY_INTERVAL_BASE_MS = 3000; // Base interval for retries

  // --- Connection Setup Logic (Memoized) ---
  const setupConnection = useCallback((conn: DataConnection, isRememberedConnection = false) => {
    conn.on('open', () => {
      console.log(`Connection to ${conn.peer} is open.`);
      setConnections(prev => ({ ...prev, [conn.peer]: conn }));
      addRememberedPeer(conn.peer); // Remember this peer

      // Clear any pending reconnection attempts/timers if successful
      if (reconnectionTimers.current[conn.peer]) {
        clearTimeout(reconnectionTimers.current[conn.peer]);
        delete reconnectionTimers.current[conn.peer];
      }
      if (reconnectionAttempts.current[conn.peer]) {
        delete reconnectionAttempts.current[conn.peer];
      }
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
      // If this was a remembered peer, try to reconnect
      if (getRememberedPeers().includes(conn.peer)) {
        scheduleReconnect(conn.peer);
      }
    });

    conn.on('error', (err) => {
      console.error(`Connection error with ${conn.peer}:`, err);
      // If this was a remembered peer, try to reconnect
      if (getRememberedPeers().includes(conn.peer)) {
        scheduleReconnect(conn.peer);
      }
    });
  }, []); // Empty dependency array as setupConnection itself is not dependent on external state, but its logic uses callbacks

  // --- Peer Connection Logic (Memoized) ---
  const connectToPeer = useCallback((peerIdToConnect: string, isRetry = false) => {
    if (!peerIdToConnect || peerIdToConnect === peerId) {
      if (peerIdToConnect === peerId) alert("You cannot connect to yourself.");
      else if (!isRetry) alert('Please enter or scan a valid remote Peer ID.'); // Don't alert for retries
      return;
    }

    // Prevent connecting if already connected or currently attempting
    if (connections[peerIdToConnect] && connections[peerIdToConnect].open) {
      console.log(`Already connected to ${peerIdToConnect}`);
      return;
    }
    // Check if a connection attempt is already in progress
    if (peerInstance.current && peerInstance.current.connections[peerIdToConnect] && peerInstance.current.connections[peerIdToConnect].length > 0) {
      // Find if there's an open or connecting data connection
      const existingDataConns = peerInstance.current.connections[peerIdToConnect].filter(c => c.type === 'data');
      if (existingDataConns.some(conn => conn.open || conn.reliable)) { // `reliable` is true during connection setup
        console.log(`Connection or attempt to ${peerIdToConnect} already exists.`);
        return;
      }
    }


    if (!peerInstance.current) {
      console.warn('Peer instance not ready for connection.');
      // If it's a remembered peer, we might want to retry later when peerInstance is ready
      if (getRememberedPeers().includes(peerIdToConnect)) {
        scheduleReconnect(peerIdToConnect);
      }
      return;
    }

    console.log(`Connecting to ${peerIdToConnect}...`);
    const conn = peerInstance.current.connect(peerIdToConnect, {
      reliable: true,
    });
    setupConnection(conn, getRememberedPeers().includes(peerIdToConnect));

  }, [peerId, connections, setupConnection]); // Include peerId and connections in dependencies

  // --- Reconnection Scheduler ---
  const scheduleReconnect = useCallback((remotePeer: string) => {
    reconnectionAttempts.current[remotePeer] = (reconnectionAttempts.current[remotePeer] || 0) + 1;

    if (reconnectionAttempts.current[remotePeer] <= MAX_RETRY_ATTEMPTS) {
      const delay = RETRY_INTERVAL_BASE_MS * reconnectionAttempts.current[remotePeer]; // Exponential backoff
      console.warn(`Attempting to reconnect to ${remotePeer} (Attempt ${reconnectionAttempts.current[remotePeer]}/${MAX_RETRY_ATTEMPTS}) in ${delay / 1000}s...`);

      // Clear any existing timer for this peer before setting a new one
      if (reconnectionTimers.current[remotePeer]) {
        clearTimeout(reconnectionTimers.current[remotePeer]);
      }
      reconnectionTimers.current[remotePeer] = setTimeout(() => {
        connectToPeer(remotePeer, true); // Mark as retry
      }, delay);
    } else {
      console.error(`Max reconnection attempts reached for ${remotePeer}. Giving up.`);
      // Optionally, you might want to ask the user if they want to 'forget' this peer,
      // or just stop trying until explicit action.
      // For now, it will stop retrying until next page load or manual connect.
      if (reconnectionTimers.current[remotePeer]) {
        clearTimeout(reconnectionTimers.current[remotePeer]);
        delete reconnectionTimers.current[remotePeer];
      }
      if (reconnectionAttempts.current[remotePeer]) {
        delete reconnectionAttempts.current[remotePeer];
      }
    }
  }, [connectToPeer]);

  // --- Initial PeerJS Setup (on Mount) ---
  useEffect(() => {
    let storedId = getMyStoredPeerId();
    if (!storedId) {
      storedId = generateUUID();
      setMyStoredPeerId(storedId);
    }

    const peer = new Peer(storedId, { // Use the stable ID
      debug: 2,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun2.l.google.com:19302' },
        ],
      },
    });

    peer.on('open', (id) => {
      console.log('My peer ID is: ' + id);
      setPeerId(id);
      // Ensure the stored ID matches the one PeerJS actually opens (in case of conflict)
      if (id !== storedId) {
        setMyStoredPeerId(id);
        console.warn(`PeerJS opened with a different ID than stored. Using new ID: ${id}`);
      }
    });

    peer.on('connection', (conn) => {
      console.log(`Incoming connection from ${conn.peer}`);
      setupConnection(conn, true); // Incoming connections are always "remembered" implicitly by design
    });

    peer.on('error', (err) => {
      console.error('PeerJS error:', err);
      // alert(`An error occurred with PeerJS: ${err.message}`); // Only alert for critical errors, not connection retries
    });

    peerInstance.current = peer;

    return () => {
      // Clear all pending reconnection timers on component unmount
      Object.values(reconnectionTimers.current).forEach(timer => clearTimeout(timer));
      reconnectionTimers.current = {};
      reconnectionAttempts.current = {};

      peer.destroy();
    };
  }, [setupConnection]); // setupConnection is a dependency because it's used inside this effect

  // --- Auto-scroll messages ---
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // --- QR Scanner Logic ---
  useEffect(() => {
    if (isScannerOpen) {
      const onScanSuccess = (decodedText: string) => {
        console.log(`QR Code detected: ${decodedText}`);
        setRemotePeerIdInput(decodedText);
        connectToPeer(decodedText); // Auto-connect after scanning
        setIsScannerOpen(false); // Close scanner on success
      };

      const onScanFailure = (error: string) => {
        // console.warn(`QR scan error: ${error}`); // This callback is called frequently, so keep it quiet
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
  }, [isScannerOpen, connectToPeer]); // connectToPeer is a dependency here

  // --- Auto-reconnect to remembered peers when `peerId` is established ---
  useEffect(() => {
    if (peerId && peerInstance.current) {
      const remembered = getRememberedPeers();
      remembered.forEach(id => {
        console.log(`Attempting to auto-reconnect to remembered peer: ${id}`);
        // Only try to connect if not already connected or actively trying
        if (!(connections[id] && connections[id].open) && !reconnectionTimers.current[id]) {
          connectToPeer(id);
        }
      });
    }
  }, [peerId, connectToPeer, connections]); // Trigger when local peerId is set or connections change

  // --- Handlers ---
  const handleConnect = () => {
    connectToPeer(remotePeerIdInput);
  };

  const handleSendMessage = () => {
    if (messageInput) {
      const messageWithSender = `You: ${messageInput}`;
      setMessages(prev => [...prev, messageWithSender]);

      Object.values(connections).forEach(conn => {
        if (conn.open) {
          conn.send(messageInput);
        } else {
          console.warn(`Attempted to send message to closed connection ${conn.peer}.`);
        }
      });
      setMessageInput('');
    }
  };

  const handleForgetPeer = (idToForget: string) => {
    // 1. Close the connection if open
    if (connections[idToForget] && connections[idToForget].open) {
      connections[idToForget].close();
    }
    // 2. Remove from remembered peers in localStorage
    removeRememberedPeer(idToForget);
    // 3. Update UI state (connections will update via conn.on('close'))
    setConnections(prev => {
      const newConns = { ...prev };
      delete newConns[idToForget];
      return newConns;
    });
    // 4. Clear any pending reconnection attempts/timers
    if (reconnectionTimers.current[idToForget]) {
      clearTimeout(reconnectionTimers.current[idToForget]);
      delete reconnectionTimers.current[idToForget];
    }
    if (reconnectionAttempts.current[idToForget]) {
      delete reconnectionAttempts.current[idToForget];
    }
    console.log(`Forgot peer: ${idToForget}`);
  };


  const connectedPeers = Object.keys(connections);
  const allRememberedPeers = getRememberedPeers(); // Get the full list for displaying status

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
                value={remotePeerIdInput}
                onChange={(e) => setRemotePeerIdInput(e.target.value)}
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
              {allRememberedPeers.length === 0 && connectedPeers.length === 0 ? (
                <li className="bg-gray-100 text-gray-500 p-3 rounded-md">Not connected to any peers and no remembered peers.</li>
              ) : (
                allRememberedPeers.map(peerId => {
                  const conn = connections[peerId];
                  const isConnected = conn && conn.open;
                  const isConnecting = (peerInstance.current && peerInstance.current.connections[peerId] && peerInstance.current.connections[peerId].length > 0 && !isConnected) || reconnectionTimers.current[peerId];
                  const baseClasses = 'p-3 rounded-md mb-2 text-sm break-all flex justify-between items-center';

                  return (
                    <li key={peerId} className={`${isConnected ? 'bg-green-100 text-green-800 font-semibold' :
                      isConnecting ? 'bg-yellow-100 text-yellow-800' :
                        'bg-red-100 text-red-800'} ${baseClasses}`}>
                      <span>
                        {isConnected ? 'Connected to' :
                          isConnecting ? `Attempting to connect to` :
                            'Offline (Remembered)'} {peerId}
                        {isConnecting && reconnectionAttempts.current[peerId] > 1 && ` (Retry ${reconnectionAttempts.current[peerId]})`}
                      </span>
                      <button
                        onClick={() => handleForgetPeer(peerId)}
                        className="ml-2 px-3 py-1 bg-gray-200 text-gray-700 rounded-md text-xs hover:bg-gray-300"
                        title="Forget this peer"
                      >
                        Forget
                      </button>
                    </li>
                  );
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
              disabled={connectedPeers.length === 0} // Disable if no connections
            />
            <button
              onClick={handleSendMessage}
              className="px-4 py-2 bg-green-500 text-white rounded-r-md hover:bg-green-600 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-opacity-50"
              disabled={connectedPeers.length === 0} // Disable if no connections
            >
              Send to All
            </button>
          </div>
          <h3 className="text-xl font-semibold text-gray-700 mt-4 mb-2">Received Messages</h3>
          <div className="list-none p-3 bg-gray-50 rounded-md h-64 overflow-y-auto">
            {messages.length === 0 ? (
              <p className="text-gray-500 text-sm">No messages yet. Connect to a peer and start chatting!</p>
            ) : (
              messages.map((message, index) => (
                <p key={index} className="bg-white p-2 rounded-md mb-2 shadow-sm text-sm break-words">
                  {message}
                </p>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
