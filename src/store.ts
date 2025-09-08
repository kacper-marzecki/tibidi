import { create } from 'zustand';
import type { DataConnection } from 'peerjs'
import Peer from 'peerjs';

// --- Helper Functions for Local Storage ---
const MY_PEER_ID_KEY = 'myPeerId';
const REMEMBERED_PEERS_KEY = 'rememberedPeerConnections';

function getMyStoredPeerId(): string | null {
  return localStorage.getItem(MY_PEER_ID_KEY);
}

function setMyStoredPeerId(id: string) {
  localStorage.setItem(MY_PEER_ID_KEY, id);
}

export function getRememberedPeers(): string[] {
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
  localStorage.setItem(REMEMBERED_PEERS_KEY, JSON.stringify(newPeers));
}

function generateUUID(): string {
  // For modern browsers, crypto.randomUUID() is preferred, but this is a good fallback.
  if (crypto && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0,
      v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// --- Store Definition ---

interface PeerState {
  peer: Peer | null;
  peerId: string;
  connections: Record<string, DataConnection>;
  messages: string[];
  isConnecting: Record<string, boolean>;
  reconnectionAttempts: Record<string, number>;
  reconnectionTimers: Record<string, NodeJS.Timeout>;
}

interface PeerActions {
  initializePeer: () => void;
  destroyPeer: () => void;
  connectToPeer: (remotePeerId: string, isRetry?: boolean) => void;
  sendMessage: (message: string) => void;
  forgetPeer: (peerIdToForget: string) => void;
}

const MAX_RETRY_ATTEMPTS = 10;
const RETRY_INTERVAL_BASE_MS = 3000;

export const usePeerStore = create<PeerState & PeerActions>((set, get) => {

  const addMessage = (message: string) => set(state => ({ messages: [...state.messages, message] }));

  const setConnectionStatus = (peerId: string, status: boolean) => {
    set(state => ({ isConnecting: { ...state.isConnecting, [peerId]: status } }));
  };

  const _scheduleReconnect = (remotePeer: string) => {
    const { reconnectionAttempts, reconnectionTimers, connectToPeer } = get();
    const attempts = (reconnectionAttempts[remotePeer] || 0) + 1;
    set(state => ({ reconnectionAttempts: { ...state.reconnectionAttempts, [remotePeer]: attempts } }));

    if (attempts <= MAX_RETRY_ATTEMPTS) {
      const delay = RETRY_INTERVAL_BASE_MS * attempts;
      console.warn(`Attempting to reconnect to ${remotePeer} (Attempt ${attempts}/${MAX_RETRY_ATTEMPTS}) in ${delay / 1000}s...`);

      if (reconnectionTimers[remotePeer]) clearTimeout(reconnectionTimers[remotePeer]);

      const newTimer = setTimeout(() => connectToPeer(remotePeer, true), delay);
      set(state => ({ reconnectionTimers: { ...state.reconnectionTimers, [remotePeer]: newTimer } }));
    } else {
      console.error(`Max reconnection attempts reached for ${remotePeer}. Giving up.`);
      const { reconnectionTimers: currentTimers, reconnectionAttempts: currentAttempts } = get();
      if (currentTimers[remotePeer]) {
        clearTimeout(currentTimers[remotePeer]);
        const newTimers = { ...currentTimers };
        delete newTimers[remotePeer];
        const newAttempts = { ...currentAttempts };
        delete newAttempts[remotePeer];
        set({ reconnectionTimers: newTimers, reconnectionAttempts: newAttempts });
      }
    }
  };

  const setupConnectionListeners = (conn: DataConnection) => {
    conn.on('open', () => {
      console.log(`Connection to ${conn.peer} is open.`);
      set(state => ({ connections: { ...state.connections, [conn.peer]: conn } }));
      setConnectionStatus(conn.peer, false);
      addRememberedPeer(conn.peer);

      const { reconnectionTimers, reconnectionAttempts } = get();
      if (reconnectionTimers[conn.peer]) {
        clearTimeout(reconnectionTimers[conn.peer]);
        const newTimers = { ...reconnectionTimers };
        delete newTimers[conn.peer];
        const newAttempts = { ...reconnectionAttempts };
        delete newAttempts[conn.peer];
        set({ reconnectionTimers: newTimers, reconnectionAttempts: newAttempts });
      }
    });

    conn.on('data', (data) => {
      console.log(`Received data from ${conn.peer}:`, data);
      addMessage(`${conn.peer}: ${data as string}`);
    });

    conn.on('close', () => {
      console.log(`Connection to ${conn.peer} has closed.`);
      set(state => {
        const newConns = { ...state.connections };
        delete newConns[conn.peer];
        return { connections: newConns };
      });
      setConnectionStatus(conn.peer, false);
      if (getRememberedPeers().includes(conn.peer)) _scheduleReconnect(conn.peer);
    });

    conn.on('error', (err) => {
      console.error(`Connection error with ${conn.peer}:`, err);
      setConnectionStatus(conn.peer, false);
      if (getRememberedPeers().includes(conn.peer)) _scheduleReconnect(conn.peer);
    });
  };

  return {
    // --- State ---
    peer: null,
    peerId: '',
    connections: {},
    messages: [],
    isConnecting: {},
    reconnectionAttempts: {},
    reconnectionTimers: {},

    // --- Actions ---
    initializePeer: () => {
      if (get().peer) return;

      let storedId = getMyStoredPeerId();
      if (!storedId) {
        storedId = generateUUID();
        setMyStoredPeerId(storedId);
      }

      const peer = new Peer(storedId, {
        debug: 2,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
          ],
        },
      });

      peer.on('open', (id) => {
        console.log('My peer ID is: ' + id);
        set({ peerId: id });
        if (id !== storedId) setMyStoredPeerId(id);

        getRememberedPeers().forEach(peerId => {
          console.log(`Attempting to auto-reconnect to remembered peer: ${peerId}`);
          get().connectToPeer(peerId);
        });
      });

      peer.on('connection', (conn) => {
        console.log(`Incoming connection from ${conn.peer}`);
        setupConnectionListeners(conn);
      });

      peer.on('error', (err) => console.error('PeerJS error:', err));

      set({ peer });
    },

    destroyPeer: () => {
      const { peer, reconnectionTimers } = get();
      if (peer) peer.destroy();
      Object.values(reconnectionTimers).forEach(timer => clearTimeout(timer));
      set({
        peer: null, peerId: '', connections: {}, messages: [],
        isConnecting: {}, reconnectionTimers: {}, reconnectionAttempts: {},
      });
    },

    connectToPeer: (remotePeerId, isRetry = false) => {
      const { peer, peerId, connections, isConnecting } = get();

      if (!remotePeerId || remotePeerId === peerId || isConnecting[remotePeerId]) return;
      if (connections[remotePeerId]?.open) return;

      if (!peer) {
        console.warn('Peer instance not ready. Retrying after a delay.');
        setTimeout(() => get().connectToPeer(remotePeerId, isRetry), 500);
        return;
      }

      console.log(`Connecting to ${remotePeerId}...`);
      setConnectionStatus(remotePeerId, true);
      const conn = peer.connect(remotePeerId, { reliable: true });
      setupConnectionListeners(conn);
    },

    sendMessage: (message) => {
      const { connections } = get();
      if (message) {
        addMessage(`You: ${message}`);
        Object.values(connections).forEach(conn => {
          if (conn.open) conn.send(message);
        });
      }
    },

    forgetPeer: (peerIdToForget) => {
      const { connections, reconnectionTimers, reconnectionAttempts } = get();
      connections[peerIdToForget]?.close();
      removeRememberedPeer(peerIdToForget);

      if (reconnectionTimers[peerIdToForget]) {
        clearTimeout(reconnectionTimers[peerIdToForget]);
        const newTimers = { ...reconnectionTimers };
        delete newTimers[peerIdToForget];
        const newAttempts = { ...reconnectionAttempts };
        delete newAttempts[peerIdToForget];
        set({ reconnectionTimers: newTimers, reconnectionAttempts: newAttempts });
      }
      console.log(`Forgot peer: ${peerIdToForget}`);
    },
  };
});
