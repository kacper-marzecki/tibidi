import { useState, useEffect, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Html5QrcodeScanner } from 'html5-qrcode';
import { usePeerStore, getRememberedPeers } from './store';
import './App.css';

function App() {
  // --- State from Zustand store ---
  const {
    peerId,
    connections,
    messages,
    isConnecting,
    reconnectionAttempts,
    initializePeer,
    destroyPeer,
    connectToPeer,
    sendMessage,
    forgetPeer,
  } = usePeerStore();

  // --- Local UI state ---
  const [remotePeerIdInput, setRemotePeerIdInput] = useState('');
  const [messageInput, setMessageInput] = useState('');
  const [isScannerOpen, setIsScannerOpen] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scannerRef = useRef<Html5QrcodeScanner | null>(null);

  // --- Lifecycle Effect for PeerJS ---
  useEffect(() => {
    initializePeer();
    return () => {
      destroyPeer();
    };
  }, [initializePeer, destroyPeer]);

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
        connectToPeer(decodedText);
        setIsScannerOpen(false);
      };

      const scanner = new Html5QrcodeScanner(
        'qr-reader',
        { fps: 10, qrbox: { width: 250, height: 250 } },
        false
      );
      scanner.render(onScanSuccess, () => { });
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
  }, [isScannerOpen, connectToPeer]);

  // --- Handlers ---
  const handleConnect = () => {
    if (remotePeerIdInput) {
      connectToPeer(remotePeerIdInput);
      setRemotePeerIdInput('');
    } else {
      alert('Please enter or scan a valid remote Peer ID.');
    }
  };

  const handleSendMessage = () => {
    if (messageInput) {
      sendMessage(messageInput);
      setMessageInput('');
    }
  };

  const connectedPeers = Object.keys(connections);
  const allRememberedPeers = getRememberedPeers();

  return (
    <div className="bg-gray-100 text-gray-800 font-sans p-4 md:p-8 min-h-screen">
      {/* Scanner Modal */}
      {isScannerOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex justify-center items-center z-50 p-4">
          <div className="bg-white p-6 rounded-lg shadow-xl w-full max-w-md">
            <h3 className="text-xl font-semibold mb-4 text-center">Scan Peer ID QR Code v1</h3>
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
                onKeyPress={(e) => e.key === 'Enter' && handleConnect()}
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
              {allRememberedPeers.length === 0 ? (
                <li className="bg-gray-100 text-gray-500 p-3 rounded-md">No remembered peers. Connect to a device to get started.</li>
              ) : (
                allRememberedPeers.map(id => {
                  const isConnected = connections[id]?.open;
                  const connecting = isConnecting[id];
                  const retrying = reconnectionAttempts[id] > 0;
                  const baseClasses = 'p-3 rounded-md mb-2 text-sm break-all flex justify-between items-center';

                  let statusText = 'Offline';
                  let statusClass = 'bg-red-100 text-red-800';

                  if (isConnected) {
                    statusText = 'Connected to';
                    statusClass = 'bg-green-100 text-green-800 font-semibold';
                  } else if (connecting || retrying) {
                    statusText = `Connecting to`;
                    statusClass = 'bg-yellow-100 text-yellow-800';
                  }

                  return (
                    <li key={id} className={`${statusClass} ${baseClasses}`}>
                      <span>
                        {statusText} {id}
                        {retrying && ` (Retry ${reconnectionAttempts[id]})`}
                      </span>
                      <button
                        onClick={() => forgetPeer(id)}
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
              disabled={connectedPeers.length === 0}
            />
            <button
              onClick={handleSendMessage}
              className="px-4 py-2 bg-green-500 text-white rounded-r-md hover:bg-green-600 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-opacity-50"
              disabled={connectedPeers.length === 0}
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
