import { create } from 'zustand';
import type { DataConnection } from 'peerjs';
import Peer from 'peerjs';
import type { Group, GroupEvent, P2PMessage, PersistedGroup } from './types';

// --- Helper Functions ---

function generateUUID(): string {
  if (crypto && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0,
      v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

const P2P_GROUPS_KEY = 'p2p_groups';

function getStoredGroups(): Record<string, PersistedGroup> {
  try {
    const stored = localStorage.getItem(P2P_GROUPS_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch (e) {
    console.error("Failed to parse groups from localStorage", e);
    return {};
  }
}

function saveStoredGroups(groups: Record<string, Group>) {
  const persistedGroups: Record<string, PersistedGroup> = {};
  for (const groupId in groups) {
    const { id, name, myPeerId, events } = groups[groupId];
    persistedGroups[groupId] = { id, name, myPeerId, events };
  }
  localStorage.setItem(P2P_GROUPS_KEY, JSON.stringify(persistedGroups));
}

// --- Store Definition ---

interface PeerState {
  groups: Record<string, Group>;
  activeGroupId: string | null;
}

interface PeerActions {
  initializeStore: () => void;
  createGroup: (name: string) => void;
  joinGroup: (inviteCode: string) => void;
  leaveGroup: (groupId: string) => void;
  setActiveGroup: (groupId: string | null) => void;
  addEventAndBroadcast: (groupId: string, type: GroupEvent['type'], payload: any) => void;
  sendMessage: (groupId: string, message: string) => void;
  connectToPeer: (groupId: string, remotePeerId: string) => void;
  destroyStore: () => void;
}

const turnUsername = "1757534482:testuser";
const turnPassword = "mHGqjUySxm/JpHI223rBraoP3Z4=";
const peerConfig = {
  debug: 2,
  config: {
    iceServers: [
      { urls: "turn:coturn.fubar.online:3478", username: turnUsername, credential: turnPassword },
      { urls: "stun:coturn.fubar.online:3478" },
    ],
  },
};

// Sorts events deterministically to ensure consistent state across all peers
const sortEvents = (events: GroupEvent[]) =>
  [...events].sort((a, b) => {
    if (a.timestamp !== b.timestamp) {
      return a.timestamp - b.timestamp;
    }
    // Tie-break with author ID to prevent state divergence from simultaneous events
    return a.authorPeerId.localeCompare(b.authorPeerId);
  });

export const usePeerStore = create<PeerState & PeerActions>((set, get) => {
  let reconnectInterval: number | undefined;

  const _updateGroupState = (groupId: string, newProps: Partial<Group>) => {
    set(state => {
      if (!state.groups[groupId]) return state;
      const updatedGroup = { ...state.groups[groupId], ...newProps };
      const newGroups = { ...state.groups, [groupId]: updatedGroup };
      // Persist changes to events or core properties
      if (newProps.events || newProps.name) {
        saveStoredGroups(newGroups);
      }
      return { groups: newGroups };
    });
  };

  const _setupConnectionListeners = (conn: DataConnection, groupId: string) => {
    conn.on('open', () => {
      const group = get().groups[groupId];
      if (!group) return;

      console.log(`[${group.name}] Connection to ${conn.peer} is open.`);

      _updateGroupState(groupId, {
        connections: { ...group.connections, [conn.peer]: conn },
        isConnecting: { ...group.isConnecting, [conn.peer]: false },
      });

      // --- Start Event Sourcing Sync ---
      const eventIds = get().groups[groupId].events.map(e => e.id);
      const syncRequest: P2PMessage = { type: 'SYNC_REQUEST', payload: { eventIds } };
      conn.send(syncRequest);
      console.log(`[${group.name}] Sent SYNC_REQUEST to ${conn.peer}`);
    });

    conn.on('data', (data) => {
      const msg = data as P2PMessage;
      const currentGroup = get().groups[groupId];
      if (!currentGroup) return;

      console.log(`[${currentGroup.name}] Received data from ${conn.peer}:`, msg.type);

      switch (msg.type) {
        case 'EVENT_BROADCAST': {
          const newEvent = msg.payload.event;
          const eventExists = currentGroup.events.some(e => e.id === newEvent.id);
          if (!eventExists) {
            const updatedEvents = sortEvents([...currentGroup.events, newEvent]);
            _updateGroupState(groupId, { events: updatedEvents });
          }
          break;
        }
        case 'SYNC_REQUEST': {
          const remoteEventIds = new Set(msg.payload.eventIds);
          const missingEvents = currentGroup.events.filter(e => !remoteEventIds.has(e.id));
          if (missingEvents.length > 0) {
            const syncResponse: P2PMessage = { type: 'SYNC_RESPONSE', payload: { missingEvents } };
            conn.send(syncResponse);
            console.log(`[${currentGroup.name}] Sent SYNC_RESPONSE to ${conn.peer} with ${missingEvents.length} events.`);
          }
          break;
        }
        case 'SYNC_RESPONSE': {
          const newEvents = msg.payload.missingEvents;
          const existingEventIds = new Set(currentGroup.events.map(e => e.id));
          const uniqueNewEvents = newEvents.filter(e => !existingEventIds.has(e.id));

          if (uniqueNewEvents.length > 0) {
            const updatedEvents = sortEvents([...currentGroup.events, ...uniqueNewEvents]);
            const groupCreatedEvent = updatedEvents.find(e => e.type === 'GROUP_CREATED');
            const groupName = groupCreatedEvent?.payload?.name;

            const updatePayload: Partial<Group> = { events: updatedEvents };
            if (groupName && currentGroup.name === 'Joining...') {
              updatePayload.name = groupName;
            }
            _updateGroupState(groupId, updatePayload);
            console.log(`[${currentGroup.name}] Applied ${uniqueNewEvents.length} new events from ${conn.peer}.`);

            // After syncing, try to connect to all other members from the event log.
            const allMembers = new Set(updatedEvents.map(e => e.authorPeerId));
            const myPeerId = get().groups[groupId]?.myPeerId;
            if (myPeerId) {
              allMembers.forEach(memberPeerId => {
                if (memberPeerId !== myPeerId) {
                  get().connectToPeer(groupId, memberPeerId);
                }
              });
            }
          }
          break;
        }
      }
    });

    conn.on('close', () => {
      const group = get().groups[groupId];
      if (!group) return; // Group was left, no need to reconnect.

      console.log(`[${group.name}] Connection to ${conn.peer} has closed.`);

      const newConns = { ...group.connections };
      delete newConns[conn.peer];

      const newConnecting = { ...group.isConnecting };
      delete newConnecting[conn.peer]; // Clear connecting flag on close

      _updateGroupState(groupId, {
        connections: newConns,
        isConnecting: newConnecting,
      });

      // The global timer will handle reconnection.
    });

    conn.on('error', (err) => {
      const group = get().groups[groupId];
      if (!group) return;
      console.error(`[${group.name}] Connection error with ${conn.peer}:`, err);
      // Reconnect logic is handled by the 'close' event, which usually follows 'error'.
    });
  };

  const _initializePeerForGroup = (groupId: string, peerToConnect?: string) => {
    const group = get().groups[groupId];
    if (!group || group.peer) return;

    const peer = new Peer(group.myPeerId, peerConfig);
    _updateGroupState(groupId, { peer });

    peer.on('open', (id) => {
      console.log(`[${group.name}] PeerJS instance ready with ID: ${id}`);

      // If joining, connect to the inviting peer
      if (peerToConnect) {
        get().connectToPeer(groupId, peerToConnect);
      }

      // Auto-connect to other members of the group derived from the event log
      const members = new Set(get().groups[groupId].events.map(e => e.authorPeerId));
      members.forEach(memberPeerId => {
        if (memberPeerId !== group.myPeerId && memberPeerId !== peerToConnect) {
          get().connectToPeer(groupId, memberPeerId);
        }
      });
    });

    peer.on('connection', (conn) => {
      console.log(`[${group.name}] Incoming connection from ${conn.peer}`);
      _setupConnectionListeners(conn, groupId);
    });

    peer.on('error', (err) => console.error(`[${group.name}] PeerJS error:`, err));
  };

  return {
    // --- State ---
    groups: {},
    activeGroupId: null,

    // --- Actions ---
    initializeStore: () => {
      const storedGroups = getStoredGroups();
      const runtimeGroups: Record<string, Group> = {};

      for (const groupId in storedGroups) {
        runtimeGroups[groupId] = {
          ...storedGroups[groupId],
          peer: null,
          connections: {},
          isConnecting: {},
        };
      }

      set({ groups: runtimeGroups });

      // Initialize PeerJS for each group
      Object.keys(runtimeGroups).forEach(groupId => _initializePeerForGroup(groupId));

      // Start periodic reconnection check
      if (reconnectInterval) clearInterval(reconnectInterval);
      reconnectInterval = window.setInterval(() => {
        const { groups, connectToPeer } = get();
        for (const groupId in groups) {
          const group = groups[groupId];
          if (!group.peer) continue;

          const allMemberIds = new Set(group.events.map(e => e.authorPeerId));
          allMemberIds.forEach(memberId => {
            if (memberId === group.myPeerId) return;

            const isConnected = group.connections[memberId]?.open;
            const isConnecting = group.isConnecting[memberId];

            if (!isConnected && !isConnecting) {
              console.log(`[${group.name}] Periodic check: attempting to connect to ${memberId}`);
              connectToPeer(groupId, memberId);
            }
          });
        }
      }, 5000);
    },

    destroyStore: () => {
      if (reconnectInterval) {
        clearInterval(reconnectInterval);
        reconnectInterval = undefined;
      }
      const { groups } = get();
      Object.values(groups).forEach(group => {
        group.peer?.destroy();
      });
      set({ groups: {}, activeGroupId: null });
    },

    createGroup: (name) => {
      const groupId = generateUUID();
      const myPeerId = generateUUID();

      const creationEvent: GroupEvent = {
        id: generateUUID(),
        timestamp: Date.now(),
        authorPeerId: myPeerId,
        type: 'GROUP_CREATED',
        payload: { name },
      };

      const newGroup: Group = {
        id: groupId,
        name,
        myPeerId,
        events: [creationEvent],
        peer: null,
        connections: {},
        isConnecting: {},
      };

      set(state => ({
        groups: { ...state.groups, [groupId]: newGroup },
        activeGroupId: groupId,
      }));

      saveStoredGroups(get().groups);
      _initializePeerForGroup(groupId);
    },

    joinGroup: (inviteCode) => {
      try {
        const { groupId, peerId: remotePeerId } = JSON.parse(inviteCode);

        if (!groupId || !remotePeerId) {
          throw new Error("Invalid invite code format.");
        }

        if (get().groups[groupId]) {
          console.warn(`Already a member of group ${groupId}. Connecting if not already connected.`);
          get().connectToPeer(groupId, remotePeerId);
          return;
        }

        const myPeerId = generateUUID();
        const newGroup: Group = {
          id: groupId,
          name: 'Joining...', // Temporary name
          myPeerId,
          events: [],
          peer: null,
          connections: {},
          isConnecting: {},
        };

        set(state => ({
          groups: { ...state.groups, [groupId]: newGroup },
          activeGroupId: groupId,
        }));

        _initializePeerForGroup(groupId, remotePeerId);

      } catch (e) {
        console.error("Failed to join group with invite code:", e);
        alert("Invalid invite code. Please check the code and try again.");
      }
    },

    leaveGroup: (groupId) => {
      set(state => {
        const groupToLeave = state.groups[groupId];
        if (!groupToLeave) return state;

        groupToLeave.peer?.destroy();

        const newGroups = { ...state.groups };
        delete newGroups[groupId];

        const newActiveGroupId = state.activeGroupId === groupId ? null : state.activeGroupId;

        saveStoredGroups(newGroups);

        return {
          groups: newGroups,
          activeGroupId: newActiveGroupId,
        };
      });
    },

    setActiveGroup: (groupId) => {
      set({ activeGroupId: groupId });
    },

    addEventAndBroadcast: (groupId, type, payload) => {
      const group = get().groups[groupId];
      if (!group) return;

      const newEvent: GroupEvent = {
        id: generateUUID(),
        timestamp: Date.now(),
        authorPeerId: group.myPeerId,
        type,
        payload,
      };

      const updatedEvents = sortEvents([...group.events, newEvent]);
      _updateGroupState(groupId, { events: updatedEvents });

      // Broadcast to all connected peers in the group
      const broadcastMessage: P2PMessage = { type: 'EVENT_BROADCAST', payload: { event: newEvent } };
      Object.values(group.connections).forEach(conn => {
        if (conn?.open) {
          conn.send(broadcastMessage);
        }
      });
    },

    sendMessage: (groupId, text) => {
      get().addEventAndBroadcast(groupId, 'MESSAGE_ADDED', { text });
    },

    connectToPeer: (groupId, remotePeerId) => {
      const group = get().groups[groupId];
      if (!group || !group.peer || !remotePeerId || remotePeerId === group.myPeerId) return;
      if (group.connections[remotePeerId]?.open || group.isConnecting[remotePeerId]) return;

      console.log(`[${group.name}] Attempting to connect to ${remotePeerId}...`);
      _updateGroupState(groupId, { isConnecting: { ...group.isConnecting, [remotePeerId]: true } });

      const conn = group.peer.connect(remotePeerId, { reliable: true });
      _setupConnectionListeners(conn, groupId);
    },
  };
});
