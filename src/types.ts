import type { DataConnection } from 'peerjs';
import Peer from 'peerjs';

// --- Core Data Structures ---

export interface GroupEvent {
  id: string;          // Unique ID for the event (e.g., UUID)
  timestamp: number;   // Milliseconds since epoch. Used for ordering.
  authorPeerId: string;      // The peerId of the user who created the event
  type: 'GROUP_CREATED' | 'MESSAGE_ADDED'; // Add more types like 'TASK_ADDED' later
  payload: any;        // Data specific to the event (e.g., { name: 'My Group' } or { text: 'Hello!' })
}

// This is the persisted part of the group state
export interface PersistedGroup {
  id: string;
  name: string;
  myPeerId: string;
  events: GroupEvent[];
}

// This is the full group state including runtime properties
export interface Group extends PersistedGroup {
  peer: Peer | null;
  connections: Record<string, DataConnection>;
  isConnecting: Record<string, boolean>;
}

// --- P2P Message Types for Synchronization ---

export type P2PMessage =
  | { type: 'SYNC_REQUEST'; payload: { eventIds: string[] } }
  | { type: 'SYNC_RESPONSE'; payload: { missingEvents: GroupEvent[] } }
  | { type: 'EVENT_BROADCAST'; payload: { event: GroupEvent } };

// --- Derived State Types (for UI) ---

export interface ChatMessage {
  id: string;
  author: string; // Can be 'You' or a peerId
  text: string;
  timestamp: number;
}
