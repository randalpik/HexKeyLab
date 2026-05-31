// Web MIDI output: enumerate output ports, pick one, send note-on/off to drive
// the physical instrument. Firefox requires a secure context — localhost (the
// :5170 umbrella) qualifies; file:// does not (see CLAUDE.md browser context).

export interface MidiPort { id: string; name: string; }

export class MidiOut {
  private access: MIDIAccess | null = null;
  private out: MIDIOutput | null = null;
  private stateListeners = new Set<() => void>();

  /** Request MIDI access (no sysex). Throws if unsupported or denied. */
  async requestAccess(): Promise<void> {
    if (this.access) return;
    if (!navigator.requestMIDIAccess) throw new Error('Web MIDI not supported in this browser');
    this.access = await navigator.requestMIDIAccess({ sysex: false });
    this.access.onstatechange = () => { for (const fn of this.stateListeners) { try { fn(); } catch { /* ignore */ } } };
  }

  /** Subscribe to port add/remove (statechange). Returns unsubscribe. */
  onStateChange(fn: () => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  listOutputs(): MidiPort[] {
    if (!this.access) return [];
    const out: MidiPort[] = [];
    this.access.outputs.forEach(p => out.push({ id: p.id, name: p.name || '(unnamed output)' }));
    return out;
  }

  selectOutput(id: string): void {
    if (!this.access) throw new Error('MIDI access not requested');
    this.out = this.access.outputs.get(id) ?? null;
    if (!this.out) throw new Error('MIDI output not found: ' + id);
  }

  get selectedId(): string | null { return this.out?.id ?? null; }
  get hasOutput(): boolean { return this.out != null; }

  noteOn(note: number, velocity: number, channel = 0): void {
    if (!this.out) return;
    const v = Math.max(1, Math.min(127, velocity | 0));
    this.out.send([0x90 | (channel & 0x0f), note & 0x7f, v]);
  }

  noteOff(note: number, channel = 0): void {
    if (!this.out) return;
    this.out.send([0x80 | (channel & 0x0f), note & 0x7f, 0]);
  }

  /** All-notes-off (CC 123) across every channel — safety on step-leave/abort. */
  allNotesOff(): void {
    if (!this.out) return;
    for (let ch = 0; ch < 16; ch++) this.out.send([0xb0 | ch, 123, 0]);
  }

  teardown(): void {
    try { this.allNotesOff(); } catch { /* ignore */ }
    if (this.access) this.access.onstatechange = null;
    this.stateListeners.clear();
    this.out = null;
    this.access = null;
  }
}
