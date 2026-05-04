// Shared domain types for HexKeyLab.
//
// Imported across modules for the cross-cutting concepts:
//   • lattice coordinates (KeyCoord)
//   • tuning system selection (TuningSystem)
//   • JI ratio with prime-exponent vector (JiRatio)
//   • Lumatone SysEx command IDs (KeyType, SysexCmd)
//
// Note: state/* modules use plain objects with inline shapes — those `State*`
// types live here too for documentation, but the state modules export the
// actual values, not the types.

// ── lattice coordinates ────────────────────────────────────────────────────

/** Lattice coordinate in (q, r). q = major thirds (5:4); r = fifths (3:2). */
export interface KeyCoord {
  q: number;
  r: number;
}

/** "q,r" string key (e.g. "0,0" for A3). Used as Map/Set/object keys throughout. */
export type KeyId = string;

// ── tuning ─────────────────────────────────────────────────────────────────

export type TuningSystem = 'equal' | '5-limit' | '7-limit';

/** A 7-limit septimal region: A bands (syntonic-only) vs B bands (×63/64). */
export interface RegionInfo {
  type: 'A' | 'B';
  /** Distance from r=0 to the corresponding A band, ÷2. */
  aDepth: number;
  /** Whether the corresponding A band is above r=0. */
  aUpper: boolean;
}

/** A JI ratio with both rounded numerator/denominator and an exact prime-
 *  exponent vector [e2, e3, e5, e7]. Consumers that need to factor the
 *  interval should prefer `e` — `num/den` may overflow float precision for
 *  large exponents (e.g. 3^36 / 2^57 from stacked Pythagorean commas). */
export interface JiRatio {
  num: number;
  den: number;
  e: [number, number, number, number];
}

/** Tier of harmonic complexity, used for color-coding intervals in the info panel. */
export type IntervalTier = 'green' | 'yellow' | 'red';

// ── Lumatone SysEx ─────────────────────────────────────────────────────────

/** Lumatone key behavior. typeByte format: (faderUpIsNull << 4) | keyType. */
export const KeyType = {
  Disabled: 0,
  NoteOnNoteOff: 1,
  ContinuousController: 2,
  /** Continuous fader, NOT poly aftertouch. */
  LumaTouch: 3,
} as const;
export type KeyTypeValue = (typeof KeyType)[keyof typeof KeyType];

/** SysEx command IDs (the byte at offset 5 of a Lumatone message). */
export const SysexCmd = {
  ChangeKeyNote: 0x00,
  SetColour: 0x01,
  SetFootControllerSensitivity: 0x03,
  InvertFootController: 0x04,
  SetLightOnKeystrokes: 0x07,
  SetAftertouchFlag: 0x0E,
  GetFirmwareRevision: 0x31,
  CalibrateExpressionPedal: 0x38,
  ResetExpressionPedalBounds: 0x39,
  /** Spontaneous status packet — NOT an ACK. Route before sysex.handleResponse. */
  PeripheralCalibrationData: 0x3E,
} as const;
export type SysexCmdValue = (typeof SysexCmd)[keyof typeof SysexCmd];

/** SysEx response status byte (offset 6). */
export const SysexStatus = {
  Nack: 0x00,
  Ack: 0x01,
  Busy: 0x02,
} as const;
export type SysexStatusValue = (typeof SysexStatus)[keyof typeof SysexStatus];

/** Annotated SysEx message — Uint8Array with optional color-sync and
 *  one-shot-response metadata attached as ad-hoc properties (the SysEx queue
 *  uses these to update lumatone.deviceColors on ACK and to dispatch firmware-
 *  revision callbacks). */
export interface SysexMessage extends Uint8Array {
  /** baseKeys index 0-279, set by buildColorSysEx for ACK-routed device-state updates. */
  keyIdx?: number;
  /** Hex color "#RRGGBB" matching the keyIdx — same source. */
  color?: string;
  /** One-shot response handler invoked when this message's ACK/NACK arrives. */
  onResponse?: (data: Uint8Array) => void;
}

// ── Audio voices ───────────────────────────────────────────────────────────

/** Oscillator voice (sine/square/triangle paths). */
export interface OscVoice {
  type: 'osc';
  osc: OscillatorNode;
  gain: GainNode;
  pressureGain: GainNode;
  vol: number;
  /** Set true on first aftertouch message; gates the handover ramp. */
  aftertouchSeen?: boolean;
  /** Wall-clock end time of the aftertouch handover ramp. */
  handoverEndTime?: number;
}

/** Sample voice (delegates to SampleEngine internally; only freq is tracked here). */
export interface SampleVoice {
  type: 'sample';
  freq: number;
  aftertouchSeen?: boolean;
  handoverEndTime?: number;
}

export type Voice = OscVoice | SampleVoice;

// ── Animation ──────────────────────────────────────────────────────────────

/** Layout-switch view tween. Encapsulated in render/animation.ts. */
export interface AnimationModule {
  /** ms — referenced by setLayout for audio ramp duration */
  readonly duration: number;
  /** true while a tween is in flight */
  readonly isAnimating: boolean;
  /** normalized [0, 1] tween progress, or -1 if not animating */
  readonly progress: number;
  tweenTo(targetQ: number, targetR: number): void;
  /** advance the tween; returns true while still running */
  step(): boolean;
}

// ── SysEx queue (encapsulated module) ──────────────────────────────────────

export interface SysexQueueModule {
  /** in-flight message (or null) */
  readonly inFlight: SysexMessage | null;
  readonly isInProgress: boolean;
  /** Append a single control-channel message; starts a silent push if idle. */
  enqueueControl(msg: SysexMessage): boolean;
  /** Replace the queue with a new visible-progress batch (color sync). */
  replaceQueue(messages: SysexMessage[]): void;
  /** Cancel any in-flight work and clear the queue. */
  cancel(): void;
  /** Route an incoming F0… SysEx response to the in-flight message. */
  handleResponse(data: Uint8Array): void;
  queryFirmware(): void;
}

// ── Window-bridge globals ──────────────────────────────────────────────────

declare global {
  interface Window {
    AudioContext: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
    /** Phase 1 inline-handler bridge — exposes module-scoped functions for
     *  HTML attributes (onclick=, onchange=). Removed when index.html
     *  converts to addEventListener wiring. */
    setLayout: (n: number) => void;
    setTuning: () => void;
    toggleAudio: () => void;
    changeWaveform: () => void;
    togglePedalCalibration: () => void;
    toggleAutoSync: () => void;
    clearSelection: () => void;
    resetPedalBounds: () => void;
    draw: () => void;
    updateInfo: () => void;
    cbNotesChanged: () => void;
    cbExtendChanged: () => void;
  }
}
