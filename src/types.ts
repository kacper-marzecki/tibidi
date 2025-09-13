import type { DataConnection } from 'peerjs';
import Peer from 'peerjs';

// --- Core Data Structures ---

export interface GroupEvent {
  id: string;          // Unique ID for the event (e.g., UUID)
  timestamp: number;   // Milliseconds since epoch. Used for ordering.
  authorPeerId: string;      // The peerId of the user who created the event
  type: 'GROUP_CREATED' | 'MESSAGE_ADDED' | 'MEMBER_LEFT'; // Add more types like 'TASK_ADDED' later
  payload: any;        // Data specific to the event (e.g., { name: 'My Group' } or { text: 'Hello!' })
}

// This is the persisted part of the group state
export interface PersistedGroup {
  id: string;
  name: string;
  myPeerId: string;
  events: GroupEvent[];
}

// This is the full persisted application state
export interface PersistedState {
  groups: Record<string, PersistedGroup>;
  activeGroupId: string | null;
}

// This is the full group state including runtime properties
export interface Group extends PersistedGroup {
  peer: Peer | null;
  connections: Record<string, DataConnection>;
  isConnecting: Record<string, number>; // Timestamp of when connection attempt started
  lastHeardFrom: Record<string, number>; // Timestamp of last message from a peer
}

// --- P2P Message Types for Synchronization ---

export type P2PMessage =
  | { type: 'SYNC_REQUEST'; payload: { eventIds: string[] } }
  | { type: 'SYNC_RESPONSE'; payload: { missingEvents: GroupEvent[] } }
  | { type: 'EVENT_BROADCAST'; payload: { event: GroupEvent } }
  | { type: 'PING' }
  | { type: 'PONG' };

// --- Derived State Types (for UI) ---

export interface ChatMessage {
  id: string;
  author: string; // Can be 'You' or a peerId
  text: string;
  timestamp: number;
}
