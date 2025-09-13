import { useState, useEffect, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Html5QrcodeScanner } from 'html5-qrcode';
import { usePeerStore, getRememberedPeers } from './store';

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
  const [activeTab, setActiveTab] = useState('Pairing');

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
        setActiveTab('Pairing'); // Switch to pairing tab after scan
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
      alert('Please enter a Peer ID.');
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
  const TABS = ['Pairing', 'Chat', 'Tasks', 'Settings'];

  return (
    // max-w-lg mx-auto md:max-w-full md:mx-0
    <div className="flex flex-col gap-6">
      {/* Scanner Modal */}
      {isScannerOpen && (
        <div className="fixed inset-0 bg-black/75 flex justify-center items-center z-50 p-4">
          <div className="bg-white border-[3px] border-black p-6 w-full max-w-[400px] text-center">
            <h3 className="text-lg font-bold mb-4">SCAN QR CODE</h3>
            <div id="qr-reader" className="border-[3px] border-black mb-4"></div>
            <button
              onClick={() => setIsScannerOpen(false)}
              className="py-[0.8rem] px-[1.2rem] border-[3px] text-center cursor-pointer uppercase text-[10px] active:not(:disabled):translate-y-[2px] disabled:bg-gray-200 disabled:text-gray-400 disabled:border-gray-400 disabled:cursor-not-allowed bg-[#eb5757] text-white border-black hover:not(:disabled):bg-[#f47f7f] mt-4 w-full"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Tabbed Interface */}
      <div className="bg-white border-[3px] border-black w-full flex flex-col h-screen">
        {/* Tab Content */}
        <div className="p-4 overflow-y-auto h-full">
          {activeTab === 'Pairing' && (
            <div className="flex flex-col gap-6">
              {/* Your Device Panel */}
              <div>
                <h2 className="text-lg font-bold mb-3">YOUR ID</h2>
                <p className="text-xs break-all mb-3">{peerId || 'Initializing...'}</p>
                {peerId && (
                  <div className="flex justify-center bg-gray-200 p-4 border-2 border-black">
                    <QRCodeSVG value={peerId} size={128} bgColor="transparent" fgColor="#212529" style={{ imageRendering: 'pixelated' }} />
                  </div>
                )}
                <p className="text-xs mt-2">Share this ID or QR code to connect.</p>
              </div>

              {/* Connect Panel */}
              <div>
                <h2 className="text-lg font-bold mb-3">CONNECT TO PEER</h2>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder="Enter Peer ID..."
                    className="p-[0.8rem] border-[3px] border-black bg-white w-full text-[10px] focus:outline-[3px] focus:outline-[#2f80ed] focus:outline-offset-[-3px]"
                    value={remotePeerIdInput}
                    onChange={(e) => setRemotePeerIdInput(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && handleConnect()}
                  />
                  <button
                    onClick={handleConnect}
                    className="py-[0.8rem] px-[1.2rem] border-[3px] text-center cursor-pointer uppercase text-[10px] active:not(:disabled):translate-y-[2px] disabled:bg-gray-200 disabled:text-gray-400 disabled:border-gray-400 disabled:cursor-not-allowed bg-[#2f80ed] text-white border-black hover:not(:disabled):bg-[#5b9eff]"
                  >
                    Link
                  </button>
                </div>
                <button
                  onClick={() => setIsScannerOpen(true)}
                  className="py-[0.8rem] px-[1.2rem] border-[3px] border-black text-center cursor-pointer bg-white text-black uppercase text-[10px] hover:not(:disabled):bg-gray-200 active:not(:disabled):translate-y-[2px] disabled:bg-gray-200 disabled:text-gray-400 disabled:border-gray-400 disabled:cursor-not-allowed mt-2 w-full"
                >
                  Scan QR
                </button>
              </div>

              {/* Connections Panel */}
              <div>
                <h2 className="text-lg font-bold mb-3">CONNECTIONS</h2>
                <div>
                  {allRememberedPeers.length === 0 ? (
                    <p className="text-xs text-gray-500">No remembered peers.</p>
                  ) : (
                    allRememberedPeers.map(id => {
                      const isConnected = connections[id]?.open;
                      const connecting = isConnecting[id];
                      const retrying = reconnectionAttempts[id] > 0;

                      let statusText = 'OFFLINE';
                      let statusClasses = 'bg-[#f8d7da] border-[#eb5757]';

                      if (isConnected) {
                        statusText = 'LINKED';
                        statusClasses = 'bg-[#d4edda] border-[#27ae60]';
                      } else if (connecting || retrying) {
                        statusText = `LINKING...`;
                        statusClasses = 'bg-[#fff3cd] border-[#f2c94c]';
                      }

                      return (
                        <div key={id} className={`p-[0.8rem] mb-2 border-[3px] flex justify-between items-center break-all ${statusClasses}`}>
                          <span className="text-xs mr-2">
                            {statusText}
                            {retrying && ` (RETRY ${reconnectionAttempts[id]})`}
                            <br />
                            {id}
                          </span>
                          <button
                            onClick={() => forgetPeer(id)}
                            className="py-[0.8rem] px-[1.2rem] border-[3px] text-center cursor-pointer uppercase active:not(:disabled):translate-y-[2px] disabled:bg-gray-200 disabled:text-gray-400 disabled:border-gray-400 disabled:cursor-not-allowed bg-[#eb5757] text-white border-black hover:not(:disabled):bg-[#f47f7f] text-xs !p-1"
                            title="Forget this peer"
                          >
                            X
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'Chat' && (
            <div>
              {/* Messaging Panel */}
              <div>
                <div className="bg-gray-200 border-[3px] border-black p-2 h-full overflow-y-auto break-all">
                  {messages.length === 0 ? (
                    <p className="text-xs text-gray-500 p-2">No messages yet.</p>
                  ) : (
                    messages.map((message, index) => (
                      <p key={index} className="bg-white p-2 mb-2 border-l-[3px] border-l-[#2f80ed] last:mb-0 text-sm">
                        {message}
                      </p>
                    ))
                  )}
                  <div ref={messagesEndRef} />
                </div>

                <h2 className="text-lg font-bold mb-3">MESSAGES</h2>
                <div className="flex items-center gap-2 mb-4">
                  <input
                    type="text"
                    placeholder="Type a message..."
                    className="p-[0.8rem] border-[3px] border-black bg-white w-full text-[10px] focus:outline-[3px] focus:outline-[#2f80ed] focus:outline-offset-[-3px]"
                    value={messageInput}
                    onChange={(e) => setMessageInput(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && handleSendMessage()}
                    disabled={connectedPeers.length === 0}
                  />
                  <button
                    onClick={handleSendMessage}
                    className="py-[0.8rem] px-[1.2rem] border-[3px] text-center cursor-pointer uppercase text-[10px] active:not(:disabled):translate-y-[2px] disabled:bg-gray-200 disabled:text-gray-400 disabled:border-gray-400 disabled:cursor-not-allowed bg-[#27ae60] text-white border-black hover:not(:disabled):bg-[#60c887]"
                    disabled={connectedPeers.length === 0}
                  >
                    Send
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'Tasks' && (
            <div>
              <h2 className="text-lg font-bold mb-3">TASKS</h2>
              <p className="text-xs text-gray-500">This feature is not yet implemented.</p>
            </div>
          )}

          {activeTab === 'Settings' && (
            <div>
              <h2 className="text-lg font-bold mb-3">SETTINGS</h2>
              <p className="text-xs text-gray-500">This feature is not yet implemented.</p>
            </div>
          )}
        </div>

        {/* Tab Buttons */}
        <div className="flex border-t-[3px] border-black">
          {TABS.map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 py-[0.8rem] px-[0.5rem] border-r-[3px] border-black last:border-r-0 text-center cursor-pointer uppercase text-[10px] font-bold focus:outline-none ${activeTab === tab
                ? 'bg-white text-black'
                : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                }`}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default App;
