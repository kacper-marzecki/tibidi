import { create } from 'zustand';
import type { DataConnection } from 'peerjs';
import Peer from 'peerjs';
import type { Group, GroupEvent, P2PMessage, PersistedGroup, PersistedState } from './types';

// --- Helper Functions ---


function removeKey<T, K extends keyof T>(obj: T, key: K) {
  const { [key]: _removedProp, ...objRest } = obj
  return objRest
}
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

const APP_STATE_KEY = 'APP_STATE';

function getStoredState(): PersistedState {
  try {
    const stored = localStorage.getItem(APP_STATE_KEY);
    console.log("###############", stored)
    const defaultState: PersistedState = { groups: {}, activeGroupId: null };
    if (!stored) return defaultState;

    const parsed = JSON.parse(stored);
    console.log("PARSED", parsed)
    // Basic validation to prevent app crash on malformed state
    if (parsed) {
      console.log("RETURNING PARSED", parsed)
      return parsed;
    }
    return defaultState;
  } catch (e) {
    console.error("Failed to parse state from localStorage", e);
    return { groups: {}, activeGroupId: null };
  }
}

function saveStoredState(state: Omit<PeerState, 'logs'>) {
  if (Object.keys(state.groups).length == 0) {
    return
  }
  const persistedGroups: Record<string, PersistedGroup> = {};
  for (const groupId in state.groups) {
    const { id, name, myPeerId, events } = state.groups[groupId];
    persistedGroups[groupId] = { id, name, myPeerId, events };
  }
  const persistedState: PersistedState = {
    groups: persistedGroups,
    activeGroupId: state.activeGroupId,
  };
  localStorage.setItem(APP_STATE_KEY, JSON.stringify(persistedState));
  console.log("###### after save", localStorage.getItem(APP_STATE_KEY));
  setTimeout(() => {
    console.log("###### after save", localStorage.getItem(APP_STATE_KEY));
  }, 500)
}

// --- Store Definition ---

interface PeerState {
  groups: Record<string, Group>;
  activeGroupId: string | null;
  logs: any[];
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
  forgetMember: (groupId: string, memberPeerId: string) => void;
  destroyStore: () => void;
  log: (...msg: any[]) => void;
}

const turnUsername = "1757860379:testuser";
const turnPassword = "la+MW+NU6bTuFoHSRrmTEKH5Y8U=";
const peerConfig = {
  debug: 2,
  config: {
    iceServers: [
      { urls: "turn:coturn.fubar.online:3478", username: turnUsername, credential: turnPassword },
      // { urls: "stun:coturn.fubar.online:3478" },
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
  const log = (...asd: any[]) => get().log(asd)

  const _updateGroupState = (groupId: string, newProps: Partial<Group>) => {
    set(state => {
      if (!state.groups[groupId]) return state;
      const updatedGroup = { ...state.groups[groupId], ...newProps };
      const newGroups = { ...state.groups, [groupId]: updatedGroup };
      // Persist changes to events or core properties
      if (newProps.events || newProps.name) {
        saveStoredState({ ...state, groups: newGroups });
      }
      return { groups: newGroups };
    });
  };

  const _setupConnectionListeners = (conn: DataConnection, groupId: string, remotePeerId: string) => {
    conn.on('open', () => {
      const group = get().groups[groupId];
      if (!group) return;

      log(`[${group.name}] Connection to ${remotePeerId} is open.`);

      const newConnecting = { ...group.isConnecting };
      delete newConnecting[remotePeerId];

      _updateGroupState(groupId, {
        connections: { ...group.connections, [remotePeerId]: conn },
        isConnecting: newConnecting,
        lastHeardFrom: { ...group.lastHeardFrom, [remotePeerId]: Date.now() },
      });

      // --- Start Event Sourcing Sync ---
      const eventIds = get().groups[groupId].events.map(e => e.id);
      const syncRequest: P2PMessage = { type: 'SYNC_REQUEST', payload: { eventIds } };
      conn.send(syncRequest);
      log(`[${group.name}] Sent SYNC_REQUEST to ${remotePeerId}`);
    });

    conn.on('data', (data) => {
      const msg = data as P2PMessage;
      const currentGroup = get().groups[groupId];
      if (!currentGroup) return;

      // Any data received is a sign of life
      _updateGroupState(groupId, {
        lastHeardFrom: { ...currentGroup.lastHeardFrom, [remotePeerId]: Date.now() }
      });

      if (msg.type === 'PING') {
        conn.send({ type: 'PONG' });
        return;
      }
      if (msg.type === 'PONG') {
        return; // The lastHeardFrom is already updated, nothing more to do.
      }

      log(`[${currentGroup.name}] Received data from ${remotePeerId}:`, msg.type);

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
            log(`[${currentGroup.name}] Sent SYNC_RESPONSE to ${remotePeerId} with ${missingEvents.length} events.`);
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
            log(`[${currentGroup.name}] Applied ${uniqueNewEvents.length} new events from ${remotePeerId}.`);

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

      log(`[${group.name}] Connection to ${remotePeerId} has closed.`);

      const newConns = { ...group.connections };
      delete newConns[remotePeerId];

      const newConnecting = { ...group.isConnecting };
      delete newConnecting[remotePeerId];

      const newLastHeardFrom = { ...group.lastHeardFrom };
      delete newLastHeardFrom[remotePeerId];

      _updateGroupState(groupId, {
        connections: removeKey(group.connections, remotePeerId),
        isConnecting: removeKey(group.isConnecting, remotePeerId),
        lastHeardFrom: removeKey(group.lastHeardFrom, remotePeerId),
      });

    });

    conn.on('error', (err) => {
      const group = get().groups[groupId];
      console.error(`!!!!!!!!!!!!!![${group.name}] Connection error with ${remotePeerId}:`, err);
      if (!group) return;
      console.error(`[${group.name}] Connection error with ${remotePeerId}:`, err);

      const newConns = { ...group.connections };
      delete newConns[remotePeerId];

      const newConnecting = { ...group.isConnecting };
      delete newConnecting[remotePeerId];

      const newLastHeardFrom = { ...group.lastHeardFrom };
      delete newLastHeardFrom[remotePeerId];

      _updateGroupState(groupId, {
        connections: newConns,
        isConnecting: newConnecting,
        lastHeardFrom: newLastHeardFrom,
      });
    });
  };

  const _initializePeerForGroup = (groupId: string, peerToConnect?: string) => {
    const group = get().groups[groupId];
    // If group doesn't exist, or if there's already a live, non-destroyed peer, do nothing.
    if (!group || (group.peer && !group.peer.destroyed)) {
      return;
    }

    // If there's an old, destroyed peer object, make sure it's cleaned up.
    if (group.peer) {
      get().log(`[${group.name}] Destroying old peer instance before creating a new one.`);
      group.peer.destroy();
    }

    log(`[${group.name}] Initializing new Peer instance for ${group.myPeerId}.`);
    const peer = new Peer(group.myPeerId, peerConfig);
    _updateGroupState(groupId, { peer });

    peer.on('open', (id) => {
      log(`[${group.name}] PeerJS instance ready with ID: ${id}`);

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
      log(`[${group.name}] Incoming connection from ${conn.peer}`);
      _setupConnectionListeners(conn, groupId, conn.peer);
    });

    peer.on('error', (err) => {
      const group = get().groups[groupId];
      if (!group) return;
      const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
      const peerId = err.message.match(uuidRegex);

      console.error(`[${group.name}] Peer error: ${err.type}`, err);
      if (peerId) {
        log(`[${group.name}] removing disconnected peer`);
        _updateGroupState(groupId, { isConnecting: removeKey(group.isConnecting, peerId[0]) });
      }
    });

    peer.on('disconnected', () => {
      const group = get().groups[groupId];
      if (!group) return;
      log(`[${group.name}] Peer disconnected from PeerJS server. It will attempt to reconnect automatically.`);
      for (const id in group.connections) {
        group.connections[id].close()
      }

      group.peer?.destroy()
      _updateGroupState(groupId, { connections: {}, isConnecting: {}, peer: null })
      // _updateGroupState(groupId, { peer: null });
    });

    peer.on('close', () => {
      const group = get().groups[groupId];
      if (!group) return;
      log(`[${group.name}] Peer connection has been closed and is no longer usable.`);

      // const peer = new Peer(group.myPeerId, peerConfig);
      // _updateGroupState(groupId, { connections: {}, isConnecting: {}, peer })
      // _updateGroupState(groupId, { peer: null });
    });
  };

  return {
    // --- State ---
    groups: {},
    activeGroupId: null,
    logs: [],
    log: (smth) => {
      console.log(smth)
      set(({ logs }) => ({ logs: [...logs, smth] }))
    },
    // --- Actions ---
    initializeStore: () => {
      const { groups: storedGroups, activeGroupId: storedActiveGroupId } = getStoredState();
      const runtimeGroups: Record<string, Group> = {};

      for (const groupId in storedGroups) {
        runtimeGroups[groupId] = {
          ...storedGroups[groupId],
          peer: null,
          connections: {},
          isConnecting: {},
          lastHeardFrom: {},
        };
      }
      // If the last active group still exists, set it as active.
      const activeGroupId = storedActiveGroupId && runtimeGroups[storedActiveGroupId]
        ? storedActiveGroupId
        : null;

      set({ groups: runtimeGroups, activeGroupId });

      // Initialize PeerJS for each group
      Object.keys(runtimeGroups).forEach(groupId => _initializePeerForGroup(groupId));

      // Start periodic reconnection check
      if (reconnectInterval) clearInterval(reconnectInterval);
      reconnectInterval = window.setInterval(() => {
        const { groups, connectToPeer } = get();
        const now = Date.now();
        const PING_INTERVAL = 15000; // 15 seconds
        const CONNECTION_TIMEOUT = 30000; // 30 seconds
        const CONNECTING_TIMEOUT = 15000; // 15 seconds to establish a connection

        for (const groupId in groups) {
          const group = groups[groupId];

          // If peer is missing or destroyed, it needs to be re-created.
          if (!group.peer || group.peer.destroyed) {
            log(`[${group.name}] Peer is missing or destroyed. Attempting to re-initialize.`);
            _initializePeerForGroup(groupId);
            continue; // Skip the rest for this interval, let the peer initialize.
          }

          // If peer is disconnected from the signaling server, PeerJS will try to reconnect.
          // We should wait until it's reconnected before trying to establish P2P connections.
          if (group.peer.disconnected) {
            log(`[${group.name}] Peer is disconnected from signaling server. Waiting for auto-reconnect.`);
            continue;
          }

          // --- Heartbeat and connection management ---
          const allMemberIds = new Set(group.events.map(e => e.authorPeerId));

          // 1. Check existing connections and send pings
          for (const peerId in group.connections) {
            const conn = group.connections[peerId];
            if (conn?.open) {
              const lastHeard = group.lastHeardFrom[peerId] || 0;

              if (now - lastHeard > CONNECTION_TIMEOUT) {
                log(`[${group.name}] Connection to ${peerId} timed out. Closing.`);
                conn.close(); // This will trigger the 'close' event handler to clean up state
              } else if (now - lastHeard > PING_INTERVAL) {
                log(`[${group.name}] Pinging ${peerId} to check liveness.`);
                conn.send({ type: 'PING' });
              }
            }
          }

          // 2. Check for and retry stale connection attempts
          for (const peerId in group.isConnecting) {
            const connectingTimestamp = group.isConnecting[peerId];
            if (now - connectingTimestamp > CONNECTING_TIMEOUT) {
              log(`[${group.name}] Connection attempt to ${peerId} timed out. Resetting.`);
              const newConnecting = { ...group.isConnecting };
              delete newConnecting[peerId];
              _updateGroupState(groupId, { isConnecting: newConnecting });
            }
          }

          // 3. Attempt to connect to members we're not connected to
          allMemberIds.forEach(memberId => {
            if (memberId === group.myPeerId) return;

            const isConnected = group.connections[memberId]?.open;
            const isConnecting = group.isConnecting[memberId];

            if (!isConnected && !isConnecting) {
              log(`[${group.name}] Periodic check: attempting to connect to ${memberId}`);
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
      // set({ groups: {}, activeGroupId: null });
      // localStorage.removeItem(APP_STATE_KEY);
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
        lastHeardFrom: {},
      };

      set(state => {
        const newGroups = { ...state.groups, [groupId]: newGroup };
        const newState = { groups: newGroups, activeGroupId: groupId };
        saveStoredState(newState);
        return newState;
      });

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
          get().setActiveGroup(groupId);
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
          lastHeardFrom: {},
        };

        set(state => {
          const newGroups = { ...state.groups, [groupId]: newGroup };
          const newState = { groups: newGroups, activeGroupId: groupId };
          saveStoredState(newState);
          return newState;
        });

        _initializePeerForGroup(groupId, remotePeerId);

      } catch (e) {
        console.error("Failed to join group with invite code:", e);
        alert("Invalid invite code. Please check the code and try again.");
      }
    },

    leaveGroup: (groupId) => {
      const group = get().groups[groupId];
      if (!group) return;

      // Announce departure to other peers
      get().addEventAndBroadcast(groupId, 'MEMBER_LEFT', {});

      // Allow a moment for the broadcast to be sent before destroying the peer connection
      setTimeout(() => {
        set(state => {
          const groupToLeave = state.groups[groupId];
          if (!groupToLeave) return state; // Group might have been removed in the meantime

          groupToLeave.peer?.destroy();

          const newGroups = { ...state.groups };
          delete newGroups[groupId];

          const newActiveGroupId = state.activeGroupId === groupId ? null : state.activeGroupId;

          const newState = {
            groups: newGroups,
            activeGroupId: newActiveGroupId,
          };
          saveStoredState(newState);

          return newState;
        });
      }, 500);
    },

    setActiveGroup: (groupId) => {
      set(state => {
        const newState = { ...state, activeGroupId: groupId };
        saveStoredState(newState);
        return { activeGroupId: groupId };
      });
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
      if (!group || !group.peer || group.peer.destroyed || !remotePeerId || remotePeerId === group.myPeerId) return;
      if (group.connections[remotePeerId]?.open || group.isConnecting[remotePeerId]) {
        log("IGNORING CONNECT TO PEER")
        return;
      }

      log(`[${group.name}] Attempting to connect to ${remotePeerId}...`);
      _updateGroupState(groupId, { isConnecting: { ...group.isConnecting, [remotePeerId]: Date.now() } });

      const conn = group.peer.connect(remotePeerId, { reliable: true });
      _setupConnectionListeners(conn, groupId, remotePeerId);
    },

    forgetMember: (groupId, memberPeerId) => {
      const { groups, log } = get();
      const group = groups[groupId];
      if (!group) return;

      log(`[${group.name}] Forgetting member ${memberPeerId}.`);

      // Close any connection to the forgotten peer
      const connection = group.connections[memberPeerId];
      if (connection) {
        connection.close();
      }

      // Filter out all events authored by the forgotten member
      const remainingEvents = group.events.filter(e => e.authorPeerId !== memberPeerId);

      _updateGroupState(groupId, {
        events: remainingEvents,
        connections: removeKey(group.connections, memberPeerId),
        isConnecting: removeKey(group.isConnecting, memberPeerId),
        lastHeardFrom: removeKey(group.lastHeardFrom, memberPeerId),
      });
    },
  };
});
