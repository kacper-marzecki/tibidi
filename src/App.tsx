import { useState, useEffect, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Html5QrcodeScanner } from 'html5-qrcode';
import { usePeerStore } from './store';
import type { ChatMessage, Group, GroupEvent } from './types';

// --- Routing Helpers ---
const TABS = ['Groups', 'Pairing', 'Chat', 'Tasks', 'Settings', 'Log'];

const getTabFromHash = () => {
  const hash = window.location.hash.substring(1).toLowerCase();
  const tab = TABS.find(t => t.toLowerCase() === hash);
  return tab || 'Groups';
};

const navigateTo = (tab: string) => {
  window.location.hash = tab.toLowerCase();
};

// --- Selectors to derive state from events ---
const selectChatMessages = (events: GroupEvent[], myPeerId: string): ChatMessage[] => {
  return events
    .filter(event => event.type === 'MESSAGE_ADDED')
    .map(event => ({
      id: event.id,
      author: event.authorPeerId === myPeerId ? 'You' : event.authorPeerId,
      text: event.payload.text,
      timestamp: event.timestamp,
    }));
};

const selectGroupMembers = (group: Group | undefined): string[] => {
  if (!group) return [];
  const members = new Set(group.events.map(e => e.authorPeerId));
  return Array.from(members);
};


function App() {
  // --- State from Zustand store ---
  const {
    groups,
    activeGroupId,
    initializeStore,
    destroyStore,
    createGroup,
    joinGroup,
    leaveGroup,
    setActiveGroup,
    connectToPeer,
    sendMessage,
    forgetMember,
    logs
  } = usePeerStore();

  const activeGroup = activeGroupId ? groups[activeGroupId] : undefined;

  // --- Local UI state ---
  const [newGroupName, setNewGroupName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [remotePeerIdInput, setRemotePeerIdInput] = useState('');
  const [messageInput, setMessageInput] = useState('');
  const [scannerMode, setScannerMode] = useState<'none' | 'join' | 'connect'>('none');
  const [activeTab, setActiveTab] = useState(getTabFromHash());

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scannerRef = useRef<Html5QrcodeScanner | null>(null);

  // --- Lifecycle Effect for Store ---
  useEffect(() => {
    initializeStore();
    return () => {
      destroyStore();
    };
  }, [initializeStore, destroyStore]);

  // --- Effect for handling URL hash changes (Routing) ---
  useEffect(() => {
    const handleHashChange = () => setActiveTab(getTabFromHash());
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  // --- Auto-scroll messages ---
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeGroup?.events]); // Trigger on events change

  // --- QR Scanner Logic ---
  useEffect(() => {
    if (scannerMode === 'none') {
      if (scannerRef.current) {
        scannerRef.current.clear().catch(error => console.error('Failed to clear QR scanner.', error));
        scannerRef.current = null;
      }
      return;
    }

    const onScanSuccess = (decodedText: string) => {
      console.log(`QR Code detected: ${decodedText}`);
      if (scannerMode === 'join') {
        joinGroup(decodedText);
      } else if (scannerMode === 'connect' && activeGroupId) {
        try {
          // The connect QR code could be a full invite code or just a peer ID
          const invite = JSON.parse(decodedText);
          connectToPeer(activeGroupId, invite.peerId);
        } catch (e) {
          // Fallback for old peer-id-only QR codes
          connectToPeer(activeGroupId, decodedText);
        }
        navigateTo('Pairing'); // Switch to pairing tab after scan
      }
      setScannerMode('none');
    };

    const scanner = new Html5QrcodeScanner('qr-reader', { fps: 10, qrbox: { width: 250, height: 250 } }, false);
    scanner.render(onScanSuccess, () => { });
    scannerRef.current = scanner;


    return () => {
      if (scannerRef.current) {
        scannerRef.current.clear().catch(error => console.error('Failed to clear QR scanner.', error));
        scannerRef.current = null;
      }
    };
  }, [scannerMode, activeGroupId, connectToPeer, joinGroup]);

  // --- Handlers ---
  const handleCreateGroup = () => {
    if (newGroupName.trim()) {
      createGroup(newGroupName.trim());
      setNewGroupName('');
    }
  };

  const handleJoinGroup = () => {
    if (inviteCode.trim()) {
      joinGroup(inviteCode.trim());
      setInviteCode('');
    }
  };

  const handleLeaveGroup = (groupId: string, groupName: string) => {
    if (window.confirm(`Are you sure you want to leave the group "${groupName}"? This action cannot be undone.`)) {
      leaveGroup(groupId);
    }
  };

  const handleConnect = () => {
    if (remotePeerIdInput && activeGroupId) {
      connectToPeer(activeGroupId, remotePeerIdInput);
      setRemotePeerIdInput('');
    }
  };

  const handleSendMessage = () => {
    if (messageInput && activeGroupId) {
      sendMessage(activeGroupId, messageInput);
      setMessageInput('');
    }
  };

  const handleForgetMember = (groupId: string, memberPeerId: string) => {
    if (window.confirm(`Are you sure you want to forget this member (${memberPeerId})? All their contributions (messages, etc.) will be permanently removed from your local view of this group.`)) {
      forgetMember(groupId, memberPeerId);
    }
  };

  const chatMessages = activeGroup ? selectChatMessages(activeGroup.events, activeGroup.myPeerId) : [];
  const groupMembers = selectGroupMembers(activeGroup);
  const connectedPeers = activeGroup ? Object.keys(activeGroup.connections).filter(p => activeGroup.connections[p]?.open) : [];
  const qrValue = activeGroup ? JSON.stringify({ groupId: activeGroup.id, peerId: activeGroup.myPeerId }) : '';

  return (
    <div className="w-full max-w-2xl mx-auto">
      {/* Scanner Modal */}
      {scannerMode !== 'none' && (
        <div className="fixed inset-0 bg-black/75 flex justify-center items-center z-50 p-4">
          <div className="bg-white border-[3px] border-black p-6 w-full max-w-[400px] text-center">
            <h3 className="text-lg font-bold mb-4">SCAN QR CODE</h3>
            <div id="qr-reader" className="border-[3px] border-black mb-4"></div>
            <button
              onClick={() => setScannerMode('none')}
              className="py-[0.8rem] px-[1.2rem] border-[3px] text-center cursor-pointer uppercase text-[10px] active:not(:disabled):translate-y-[2px] bg-[#eb5757] text-white border-black hover:not(:disabled):bg-[#f47f7f] mt-4 w-full"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Main UI */}
      <div className="bg-white border-[3px] border-black w-full flex flex-col h-screen">
        <div className="p-4 overflow-y-auto h-full flex flex-col gap-6">
          {activeTab === 'Groups' && (
            <div>
              <h2 className="text-lg font-bold mb-3">CREATE GROUP</h2>
              <div className="flex items-center gap-2 mb-6">
                <input
                  type="text"
                  placeholder="New group name..."
                  className="p-[0.8rem] border-[3px] border-black bg-white w-full text-[10px] focus:outline-[3px] focus:outline-[#2f80ed] focus:outline-offset-[-3px]"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleCreateGroup()}
                />
                <button onClick={handleCreateGroup} className="py-[0.8rem] px-[1.2rem] border-[3px] text-center cursor-pointer uppercase text-[10px] active:not(:disabled):translate-y-[2px] bg-[#27ae60] text-white border-black hover:not(:disabled):bg-[#60c887]">
                  Create
                </button>
              </div>

              <h2 className="text-lg font-bold mb-3">JOIN GROUP</h2>
              <div className="flex items-center gap-2 mb-2">
                <input
                  type="text"
                  placeholder="Paste invite code..."
                  className="p-[0.8rem] border-[3px] border-black bg-white w-full text-[10px] focus:outline-[3px] focus:outline-[#2f80ed] focus:outline-offset-[-3px]"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleJoinGroup()}
                />
                <button onClick={handleJoinGroup} className="py-[0.8rem] px-[1.2rem] border-[3px] text-center cursor-pointer uppercase text-[10px] active:not(:disabled):translate-y-[2px] bg-[#2f80ed] text-white border-black hover:not(:disabled):bg-[#5b9eff]">
                  Join
                </button>
              </div>
              <button onClick={() => setScannerMode('join')} className="py-[0.8rem] px-[1.2rem] border-[3px] border-black text-center cursor-pointer bg-white text-black uppercase text-[10px] hover:not(:disabled):bg-gray-200 active:not(:disabled):translate-y-[2px] w-full mb-6">
                Scan to Join
              </button>


              <h2 className="text-lg font-bold mb-3">MY GROUPS</h2>
              {Object.values(groups).length === 0 ? (
                <p className="text-xs text-gray-500">No groups yet. Create or join one to get started.</p>
              ) : (
                Object.values(groups).map(group => (
                  <div key={group.id} className={`p-[0.8rem] mb-2 border-[3px] flex justify-between items-center ${activeGroupId === group.id ? 'border-black bg-blue-100' : 'border-gray-400 bg-white hover:bg-gray-100'}`}>
                    <div onClick={() => setActiveGroup(group.id)} className="flex-grow cursor-pointer">
                      <span className="font-bold">{group.name}</span>
                      <span className="text-xs text-gray-600 block">{selectGroupMembers(group).length} members</span>
                    </div>
                    <button onClick={() => handleLeaveGroup(group.id, group.name)} className="py-[0.4rem] px-[0.8rem] border-[2px] text-center cursor-pointer uppercase text-[10px] active:not(:disabled):translate-y-[2px] bg-[#eb5757] text-white border-black hover:not(:disabled):bg-[#f47f7f] ml-2 flex-shrink-0">
                      Leave
                    </button>
                  </div>
                ))
              )}
            </div>
          )}

          {!activeGroup && activeTab !== 'Groups' && (
            <div className="text-center p-8">
              <h2 className="text-lg font-bold mb-3">NO GROUP SELECTED</h2>
              <p className="text-xs text-gray-500 mb-4">Please create or select a group from the 'Groups' tab to continue.</p>
              <button onClick={() => navigateTo('Groups')} className="py-[0.8rem] px-[1.2rem] border-[3px] text-center cursor-pointer uppercase text-[10px] bg-white text-black border-black hover:bg-gray-200">
                Go to Groups
              </button>
            </div>
          )}

          {activeGroup && activeTab === 'Pairing' && (
            <>
              <div>
                <h2 className="text-lg font-bold mb-3">INVITE TO "{activeGroup.name}"</h2>
                <p className="text-xs break-all mb-1">Your Peer ID for this group:</p>
                <p className="text-xs break-all mb-3 font-mono bg-gray-100 p-1 border-2">{activeGroup.myPeerId}</p>
                <div className="flex justify-center bg-gray-200 p-4 border-2 border-black">
                  <QRCodeSVG value={qrValue} size={128} bgColor="transparent" fgColor="#212529" style={{ imageRendering: 'pixelated' }} />
                </div>
                <p className="text-xs mt-2">Share your invite code or QR code to invite others to this group.</p>
                <button className="mt-2 p-2 bg-gray-100 border-2 w-full text-xs break-all font-mono" onClick={() => navigator.clipboard.writeText(qrValue)}>
                  {qrValue}
                </button>
              </div>

              <div>
                <h2 className="text-lg font-bold mb-3">CONNECT TO PEER</h2>
                <div className="flex items-center gap-2">
                  <input type="text" placeholder="Enter Peer ID..." className="p-[0.8rem] border-[3px] border-black bg-white w-full text-[10px] focus:outline-[3px] focus:outline-[#2f80ed] focus:outline-offset-[-3px]" value={remotePeerIdInput} onChange={(e) => setRemotePeerIdInput(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && handleConnect()} />
                  <button onClick={handleConnect} className="py-[0.8rem] px-[1.2rem] border-[3px] text-center cursor-pointer uppercase text-[10px] active:not(:disabled):translate-y-[2px] bg-[#2f80ed] text-white border-black hover:not(:disabled):bg-[#5b9eff]">Link</button>
                </div>
                <button onClick={() => setScannerMode('connect')} className="py-[0.8rem] px-[1.2rem] border-[3px] border-black text-center cursor-pointer bg-white text-black uppercase text-[10px] hover:not(:disabled):bg-gray-200 active:not(:disabled):translate-y-[2px] mt-2 w-full">Scan QR</button>
              </div>

              <div>
                <h2 className="text-lg font-bold mb-3">MEMBERS ({groupMembers.length})</h2>
                {groupMembers.map(peerId => {
                  const isYou = peerId === activeGroup.myPeerId;
                  const isConnected = activeGroup.connections[peerId]?.open;
                  const isConnecting = activeGroup.isConnecting[peerId];
                  // const reconnectAttempts = activeGroup.reconnectionAttempts[peerId] || 0;
                  // const isReconnecting = reconnectAttempts > 0;

                  let statusText = 'OFFLINE';
                  let statusClasses = 'bg-[#f8d7da] border-[#eb5757]';
                  if (isYou) {
                    statusText = 'YOU';
                    statusClasses = 'bg-blue-100 border-blue-400';
                  } else if (isConnected) {
                    statusText = 'LINKED';
                    statusClasses = 'bg-[#d4edda] border-[#27ae60]';
                  } else if (isConnecting) {
                    statusText = 'LINKING...';
                    statusClasses = 'bg-[#fff3cd] border-[#f2c94c]';
                    // } else if (isReconnecting) {
                    //   statusText = `RECONNECTING... (${reconnectAttempts})`;
                    //   statusClasses = 'bg-[#fff3cd] border-[#f2c94c]';
                  }
                  return (
                    <div key={peerId} className={`p-[0.8rem] mb-2 border-[3px] flex justify-between items-center break-all ${statusClasses}`}>
                      <span className="text-xs mr-2 flex-grow">{statusText}<br />{peerId}</span>
                      {!isYou && activeGroup && (
                        <button
                          onClick={() => handleForgetMember(activeGroup.id, peerId)}
                          className="py-[0.4rem] px-[0.8rem] border-[2px] text-center cursor-pointer uppercase text-[10px] active:not(:disabled):translate-y-[2px] bg-[#f2c94c] text-black border-black hover:not(:disabled):bg-[#f5d573] ml-2 flex-shrink-0"
                        >
                          Forget
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {activeGroup && activeTab === 'Chat' && (
            <div className="flex flex-col h-full">
              <div className="flex-grow bg-gray-200 border-[3px] border-black p-2 overflow-y-auto break-all mb-4">
                {chatMessages.length === 0 ? (
                  <p className="text-xs text-gray-500 p-2">No messages yet. Send one to start the conversation.</p>
                ) : (
                  chatMessages.map((message) => (
                    <p key={message.id} className="bg-white p-2 mb-2 border-l-[3px] border-l-[#2f80ed] last:mb-0 text-sm">
                      <strong>{message.author}:</strong> {message.text}
                    </p>
                  ))
                )}
                <div ref={messagesEndRef} />
              </div>
              <div className="flex items-center gap-2">
                <input type="text" placeholder="Type a message..." className="p-[0.8rem] border-[3px] border-black bg-white w-full text-[10px] focus:outline-[3px] focus:outline-[#2f80ed] focus:outline-offset-[-3px]" value={messageInput} onChange={(e) => setMessageInput(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && handleSendMessage()} />
                <button onClick={handleSendMessage} className="py-[0.8rem] px-[1.2rem] border-[3px] text-center cursor-pointer uppercase text-[10px] active:not(:disabled):translate-y-[2px]">
                  Send
                </button>
              </div>
            </div>
          )}

          {activeGroup && activeTab === 'Tasks' && (
            <div><h2 className="text-lg font-bold mb-3">TASKS</h2><p className="text-xs text-gray-500">This feature is not yet implemented.</p></div>
          )}
          {activeGroup && activeTab === 'Settings' && (
            <div><h2 className="text-lg font-bold mb-3">SETTINGS</h2><p className="text-xs text-gray-500">This feature is not yet implemented.</p></div>
          )}

          {activeGroup && activeTab === 'Log' && (
            <div className="text-sm flex flex-col gap-2">
              {logs.map(l => <div >
                {`${l}`}
              </div>)}
            </div>
          )}
        </div>


        {/* Tab Buttons */}
        <div className="flex border-t-[3px] border-black">
          {TABS.map(tab => (
            <button key={tab} onClick={() => navigateTo(tab)} className={`flex-1 py-[0.8rem] px-[0.5rem] border-r-[3px] border-black last:border-r-0 text-center cursor-pointer uppercase text-[10px] font-bold focus:outline-none ${activeTab === tab ? 'bg-white text-black' : 'bg-gray-200 text-gray-600 hover:bg-gray-300'}`}>
              {tab}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default App;
